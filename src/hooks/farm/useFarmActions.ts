import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';

import { CROP_CATALOG } from '@/farm/crops/catalog';
import { applyFarmAction } from '@/farm/slots/transitions';
import type { FarmActionType } from '@/farm/slots/actions';
import type { FarmSlot } from '@/farm/slots/types';
import type { HarvestResult } from '@/farm/harvest/types';
import { systemClock } from '@/farm/time';
import { buildSlotState, collectOwnedSlots, type SlotStateEvent } from '@/nostr/slot-state';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { describeReads, readFromRelays, type RelayPool } from '@/nostr/query';
import { DEFAULT_GAME_RELAY, GAME_RELAYS } from '@/nostr/relays';
import { creditHarvest, reconcileCredit, type CreditDeps, type CreditRequest, type CreditResult } from '@/inventory/credit-harvest';
import { FARM_INVENTORY_D, type HarvestRecord } from '@/inventory/farm-inventory';
import { getProduceForCrop, type ProduceDefinition } from '@/inventory/produce-catalog';
import { withSerializedWrite } from '@/lib/write-lock';
import { slotKey, type FarmSlotRecord, type FarmSlots } from './useFarmSlots';
import { farmInventoryReadDeps, publishFarmInventory, INVENTORY_RELAY_HINT } from './inventory-relays';
import { farmInventoryQueryKey, setFarmInventory } from './useFarmInventory';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { ACTION_REJECTION_MESSAGES, HARVEST_ERRORS, HARVEST_TOAST } from '@/components/farm/copy';

export interface FarmActionInput {
  mapId: string;
  /** The slot plus the identity of the event it came from. */
  record: FarmSlotRecord;
  type: FarmActionType;
  cropId?: string;
}

export class FarmActionRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'FarmActionRejectedError';
  }
}

/** A harvest that could not be completed, with the phase it stopped in. */
export class HarvestFailedError extends Error {
  constructor(
    message: string,
    readonly phase: 'inventory' | 'slot',
    /** True when the outcome is unknown rather than a definite failure. */
    readonly ambiguous: boolean
  ) {
    super(message);
    this.name = 'HarvestFailedError';
  }
}


/**
 * Perform a farm action.
 *
 * Actions that only change world state (plant, water, clear) keep the
 * optimistic path: they are idempotent replaceable writes, so republishing one
 * twice is the same state.
 *
 * HARVEST IS DIFFERENT, because it also credits an item, and `+1` applied twice
 * is `+2`. It therefore runs credit-first and clears nothing optimistically:
 *
 *   guard → resolve produce → credit farm:main → only then publish the empty slot
 *
 * A crop that lingers after the item arrives is recoverable — the next attempt
 * finds the harvest already credited and only retries the slot clear. A crop
 * that vanishes without an item is not recoverable, which is why the ordering
 * is not the other way round.
 */
export function useFarmActions() {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  /**
   * Slots with an action in flight, checked synchronously.
   *
   * React state is not a mutex: two clicks in the same tick both observe the
   * pre-render `isPending === false`. This closes that window before any
   * network call happens.
   */
  const inFlight = useRef(new Set<string>());

  const creditDeps = useCallback((): CreditDeps => {
    if (!user) throw new Error('Sign in to work your farm.');
    const minRevision = knownRevisions.get(inventoryLockKey(user.pubkey));
    return {
      ownerPubkey: user.pubkey,
      ...farmInventoryReadDeps(nostr, user.pubkey),
      signEvent: (template) => user.signer.signEvent(template),
      publish: publishFarmInventory(nostr),
      nowSec: () => systemClock.now(),
      relayHint: INVENTORY_RELAY_HINT,
      ...(minRevision === undefined ? {} : { minRevision }),
    };
  }, [nostr, user]);

  const mutation = useMutation<{ slot: FarmSlot; harvest?: HarvestResult; produce?: ProduceDefinition }, Error, FarmActionInput>({
    mutationFn: async ({ mapId, record, type, cropId }) => {
      if (!user) throw new Error('Sign in to work your farm.');

      // Computed ONCE per action. The optimistic path reuses this result rather
      // than re-running the transition against a second, later clock reading.
      const result = applyFarmAction(record.slot, { type, nowSec: systemClock.now(), cropId }, CROP_CATALOG);
      if (!result.ok) throw new FarmActionRejectedError(result.reason);

      if (type !== 'harvest' || !result.harvest) {
        await publishEvent(buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: result.slot }));
        return { slot: result.slot, harvest: result.harvest };
      }

      const produce = getProduceForCrop(result.harvest.cropId);
      if (!produce) {
        // Fail before any network mutation: a crop with no item must never be
        // cleared, because it could never be credited.
        throw new HarvestFailedError(
          `"${result.harvest.cropId}" has no official produce definition yet, so it cannot be harvested.`,
          'inventory',
          false
        );
      }

      if (!record.sourceEventId || record.slot.content.type !== 'plant') {
        throw new HarvestFailedError(
          'This crop has not been confirmed on a relay yet. Refresh and try again.',
          'inventory',
          false
        );
      }

      const planting: HarvestRecord = {
        slotD: slotKey(mapId, record.slot.coord.x, record.slot.coord.y),
        plantedAt: record.slot.content.plant.plantedAt,
      };

      // The plot as the relays hold it NOW, not as this device last fetched
      // it. The harvest is recomputed on that state: a watering from another
      // device is honoured, a plot that moved on to another planting (or to
      // nothing) is refused, and a read that did not finish is refused too.
      const plot = await readPlotNow(nostr, user.pubkey, mapId, planting.slotD);
      if (!plot.newest || !plot.complete) {
        throw new HarvestFailedError(
          plot.newest ? HARVEST_ERRORS.plotUnconfirmed(plot.detail) : plot.complete ? HARVEST_ERRORS.plotGone : HARVEST_ERRORS.plotUnconfirmed(plot.detail),
          'inventory',
          false
        );
      }
      const fresh = plot.newest.slot;
      if (fresh.content.type !== 'plant' || fresh.content.plant.plantedAt !== planting.plantedAt) {
        queryClient.invalidateQueries({ queryKey: ['farm-slots', user.pubkey, mapId] });
        throw new HarvestFailedError(HARVEST_ERRORS.plotChanged, 'inventory', false);
      }
      const harvested = applyFarmAction(fresh, { type, nowSec: systemClock.now() }, CROP_CATALOG);
      if (!harvested.ok) throw new FarmActionRejectedError(harvested.reason);
      if (!harvested.harvest) throw new HarvestFailedError(HARVEST_ERRORS.plotChanged, 'inventory', false);

      const lockKey = inventoryLockKey(user.pubkey);
      const credit = await runCredit(creditDeps(), lockKey, {
        produce,
        consumedEventId: plot.newest.event.id,
        consumedEventRelay: DEFAULT_GAME_RELAY,
        planting,
        liveSlotEventIds: liveSlotEventIds(queryClient.getQueryData<FarmSlots>(['farm-slots', user.pubkey, mapId])),
      });

      if (credit.status === 'accepted') observeRevision(lockKey, revisionOf(credit.event));
      if (credit.status === 'already-applied') observeRevision(lockKey, credit.inventory.revision);

      if (credit.status === 'rejected' || credit.status === 'fold-unconfirmed' || credit.status === 'stale-read') {
        throw new HarvestFailedError(credit.error, 'inventory', false);
      }
      if (credit.status === 'unresolved') throw new HarvestFailedError(credit.error, 'inventory', false);
      if (credit.status === 'ambiguous') {
        throw new HarvestFailedError(
          'Your produce may or may not have been credited, so the crop was left in place. Try again — it will not be counted twice.',
          'inventory',
          true
        );
      }

      if (credit.status === 'accepted') {
        // Show the new balance at once, derived from the very event we signed
        // and the spends it settled, rather than waiting for a relay.
        setFarmInventory(queryClient, user.pubkey, { event: credit.event, folds: credit.folds, spends: credit.spends });
      }

      // Only now is it safe to remove the crop.
      try {
        await publishEvent(buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: harvested.slot }));
      } catch (error) {
        throw new HarvestFailedError(
          `Your ${produce.name} was added, but clearing the crop failed. Harvest it again to finish — it will not be counted twice. (${error instanceof Error ? error.message : String(error)})`,
          'slot',
          false
        );
      }

      return { slot: harvested.slot, harvest: harvested.harvest, produce };
    },

    onMutate: async ({ mapId, record, type, cropId }) => {
      if (!user) return;
      const key = ['farm-slots', user.pubkey, mapId];

      // Harvest clears nothing up front — the crop stays until the item exists.
      if (type === 'harvest') return { key };

      await queryClient.cancelQueries({ queryKey: key });
      const result = applyFarmAction(record.slot, { type, nowSec: systemClock.now(), cropId }, CROP_CATALOG);
      if (!result.ok) return { key };

      const previous = queryClient.getQueryData<FarmSlots>(key);
      if (previous) {
        const byAddress = new Map(previous.byAddress);
        byAddress.set(slotKey(mapId, record.slot.coord.x, record.slot.coord.y), { slot: result.slot });
        queryClient.setQueryData<FarmSlots>(key, { byAddress });
      }
      return { previous, key };
    },

    onError: (error, _input, context) => {
      const ctx = context as { previous?: FarmSlots; key?: unknown[] } | undefined;
      if (ctx?.previous && ctx.key) queryClient.setQueryData(ctx.key, ctx.previous);

      toast({
        variant: 'destructive',
        title: error instanceof HarvestFailedError && error.phase === 'slot' ? 'Crop not cleared' : 'Action failed',
        description:
          error instanceof FarmActionRejectedError ? (ACTION_REJECTION_MESSAGES[error.reason] ?? error.reason) : error.message,
      });
    },

    onSuccess: (data, { mapId }) => {
      if (!user) return;
      queryClient.invalidateQueries({ queryKey: ['farm-slots', user.pubkey, mapId] });

      if (data.produce) {
        queryClient.invalidateQueries({ queryKey: farmInventoryQueryKey(user.pubkey) });
        toast({ variant: 'harvest', title: `+1 ${data.produce.emoji} ${data.produce.name}`, description: HARVEST_TOAST.description });
      }
    },

    onSettled: (_data, _error, { mapId, record }) => {
      inFlight.current.delete(guardKey(mapId, record));
    },
  });

  /** Reject a duplicate action on the same slot before it can reach the network. */
  const act = useCallback(
    async (input: FarmActionInput) => {
      const key = guardKey(input.mapId, input.record);
      if (inFlight.current.has(key)) return undefined;
      inFlight.current.add(key);
      try {
        return await mutation.mutateAsync(input);
      } finally {
        inFlight.current.delete(key);
      }
    },
    [mutation]
  );

  return { act, isActing: mutation.isPending };
}

function guardKey(mapId: string, record: FarmSlotRecord): string {
  return `${mapId}:${record.slot.coord.x}:${record.slot.coord.y}`;
}

/**
 * The event id currently holding every plot the client has read, or
 * `undefined` when the field has not been read at all — in which case no
 * legacy marker may be dropped, because none can be vouched for.
 */
function liveSlotEventIds(slots: FarmSlots | undefined): string[] | undefined {
  if (!slots) return undefined;
  const ids: string[] = [];
  for (const record of slots.byAddress.values()) if (record.sourceEventId) ids.push(record.sourceEventId);
  return ids;
}

/**
 * kind:1417 manifests this tab signed whose settlement no snapshot has yet
 * confirmed, per inventory. A manifest is immutable and identified by its id;
 * if the retry needs the same manifest, it republishes this one instead of
 * signing a look-alike with a different id. Cleared once a snapshot that
 * references it is established, or once the retry needed a different one.
 */
const unconfirmedFolds = new Map<string, NostrEvent>();

/**
 * Run the credit inside the shared write lock, then reconcile an ambiguous
 * outcome once before reporting it.
 */
/**
 * The highest `farm:main` revision this session has read or written, per
 * inventory. A later read that comes back below it is a relay that has not
 * caught up, and `creditHarvest` refuses to build on it. Session-scoped on
 * purpose: a fresh page load has nothing to compare against and must trust
 * the confirmed read, which is the documented residual limitation.
 */
const knownRevisions = new Map<string, number>();

function inventoryLockKey(ownerPubkey: string): string {
  return `nostr-worlds:inventory:${ownerPubkey}:${FARM_INVENTORY_D}`;
}

function observeRevision(lockKey: string, revision: number | undefined): void {
  if (revision === undefined) return;
  const known = knownRevisions.get(lockKey);
  if (known === undefined || revision > known) knownRevisions.set(lockKey, revision);
}

function revisionOf(event: NostrEvent): number | undefined {
  const raw = event.tags.find(([name]) => name === 'revision')?.[1];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Test seam: forget every revision this session has observed. */
export function forgetObservedRevisions(): void {
  knownRevisions.clear();
}

const PLOT_READ_TIMEOUT_MS = 5000;

/**
 * The plot as the game relays hold it right now, for a harvest.
 *
 * `complete` means at least one relay reached EOSE, so `newest` is that
 * relay's current state for the plot rather than whatever arrived before the
 * stream was cut. Presence without completeness is not enough to credit on.
 */
async function readPlotNow(
  nostr: RelayPool,
  ownerPubkey: string,
  mapId: string,
  slotD: string
): Promise<{ newest?: SlotStateEvent; complete: boolean; detail: string }> {
  const read = await readFromRelays(
    nostr,
    GAME_RELAYS.map((relay) => relay.url),
    [{ kinds: [KIND_SLOT_STATE], authors: [ownerPubkey], '#d': [slotD] }],
    { timeoutMs: PLOT_READ_TIMEOUT_MS }
  );
  const newest = collectOwnedSlots(read.events, ownerPubkey, mapId).get(slotD);
  return { ...(newest ? { newest } : {}), complete: read.anyComplete, detail: describeReads(read.reads) };
}

async function runCredit(deps: CreditDeps, lockKey: string, identity: Omit<CreditRequest, 'unconfirmedFold'>): Promise<CreditResult> {
  return withSerializedWrite(lockKey, async () => {
    const request: CreditRequest = { ...identity, unconfirmedFold: unconfirmedFolds.get(lockKey) };
    const result = await creditHarvest(deps, request);
    rememberFold(lockKey, result);
    if (result.status !== 'ambiguous') return result;

    // "Unknown" is not failure. Look for the marker before telling the user
    // anything, and never publish a second `+1` to find out.
    const check = await reconcileCredit(deps, request);
    if (check.credited) {
      unconfirmedFolds.delete(lockKey);
      return { status: 'already-applied', inventory: check.inventory!, quantity: check.quantity };
    }
    return result;
  });
}

function rememberFold(lockKey: string, result: CreditResult): void {
  if (result.status === 'accepted' || result.status === 'already-applied') {
    unconfirmedFolds.delete(lockKey);
    return;
  }
  if ('fold' in result && result.fold) unconfirmedFolds.set(lockKey, result.fold);
}
