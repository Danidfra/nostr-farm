import { useCallback, useEffect, useRef, useState } from 'react';
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
import { allCompleteAmong, describeReads, readFromRelays, type RelayPool } from '@/nostr/query';
import { DEFAULT_GAME_RELAY, GAME_RELAY_URLS, REQUIRED_GAME_RELAY_URLS } from '@/nostr/relays';
import { ownEventsOfKinds, relaySync, type PublishPool } from '@/nostr/relay-sync';
import { creditHarvest, reconcileCredit, type CreditDeps, type CreditRequest, type CreditResult } from '@/inventory/credit-harvest';
import { FARM_INVENTORY_D, snapshotRevision, type HarvestRecord } from '@/inventory/farm-inventory';
import { verifyCredit } from '@/inventory/verify-credit';
import { getProduceForCrop, type ProduceDefinition } from '@/inventory/produce-catalog';
import { withSerializedWrite } from '@/lib/write-lock';
import { slotKey, type FarmSlotRecord, type FarmSlots } from './useFarmSlots';
import { farmInventoryReadDeps, publishFarmInventory, INVENTORY_RELAY_HINT } from './inventory-relays';
import { farmInventoryQueryKey, setFarmInventory } from './useFarmInventory';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { ACTION_REJECTION_MESSAGES, HARVEST_ERRORS, HARVEST_TOAST, HARVEST_VERIFY, PLANT_ERRORS } from '@/components/farm/copy';

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

/** A planting that was not started because the plot's state could not be confirmed. Nothing was published. */
export class PlantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlantRefusedError';
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
 * PLANTING additionally re-reads the plot first. It is the one action taken on
 * what a plot does NOT hold, and "nothing there" is true only when every game
 * relay said so; a plot one relay did not answer about is unknown, and a
 * planting published over it would replace whatever is growing there.
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
export function useFarmActions({ verifyDelayMs = HARVEST_VERIFY_DELAY_MS }: { verifyDelayMs?: number } = {}) {
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

  /** What the last post-write verification found, for the page and for tests. */
  const [lastVerification, setLastVerification] = useState<HarvestVerification | null>(null);
  const verifyTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = verifyTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

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

  /**
   * Read `farm:main` back once, a moment after an accepted credit, and act on
   * what the relays hold:
   *
   * - confirmed: nothing to do, the harvest toast already said so;
   * - overwritten: another writer replaced our snapshot from an older base.
   *   The credit is run ONCE more under the very same identity — same plot,
   *   same `plantedAt` — so if it did survive somewhere after all, the
   *   record makes the retry a no-op. Never a new identity, never a loop;
   * - uncertain: the relays could not say. Reported, not retried: a retry on
   *   no evidence is how a harvest gets counted twice.
   *
   * None of this is a guarantee that the snapshot is durable on every relay;
   * it is one more look, taken while the device is still online.
   */
  const verifyHarvest = useCallback(
    async (written: NostrEvent, request: CreditIdentity, lockKey: string): Promise<void> => {
      if (!user) return;
      const identity = { consumedEventId: request.consumedEventId, planting: request.planting };
      const outcome = await verifyCredit(creditDeps(), written, identity);

      if (outcome.status === 'confirmed') {
        observeRevision(lockKey, outcome.newest.revision);
        setLastVerification({ status: 'confirmed' });
        return;
      }
      if (outcome.status === 'uncertain') {
        setLastVerification({ status: 'uncertain', reason: outcome.reason });
        toast(HARVEST_VERIFY.uncertain);
        return;
      }

      observeRevision(lockKey, outcome.newest.revision);
      const again = await runCredit(creditDeps(), lockKey, request);
      if (again.status === 'accepted' || again.status === 'already-applied') {
        if (again.status === 'accepted') {
          observeRevision(lockKey, snapshotRevision(again.event));
          setFarmInventory(queryClient, user.pubkey, { event: again.event, folds: again.folds, spends: again.spends });
        }
        queryClient.invalidateQueries({ queryKey: farmInventoryQueryKey(user.pubkey) });
        setLastVerification({ status: 'recredited' });
        toast(HARVEST_VERIFY.resaved);
        return;
      }
      const detail = again.error;
      setLastVerification({ status: 'lost', reason: detail });
      toast(HARVEST_VERIFY.lost(detail));
    },
    [creditDeps, queryClient, toast, user]
  );

  const scheduleVerification = useCallback(
    (written: NostrEvent, request: CreditIdentity, lockKey: string) => {
      const timer = setTimeout(() => {
        verifyTimers.current.delete(timer);
        void verifyHarvest(written, request, lockKey).catch(() => undefined);
      }, verifyDelayMs);
      verifyTimers.current.add(timer);
    },
    [verifyDelayMs, verifyHarvest]
  );

  const mutation = useMutation<{ slot: FarmSlot; harvest?: HarvestResult; produce?: ProduceDefinition }, Error, FarmActionInput>({
    mutationFn: async ({ mapId, record, type, cropId }) => {
      if (!user) throw new Error('Sign in to work your farm.');

      // Computed ONCE per action. The optimistic path reuses this result rather
      // than re-running the transition against a second, later clock reading.
      const result = applyFarmAction(record.slot, { type, nowSec: systemClock.now(), cropId }, CROP_CATALOG);
      if (!result.ok) throw new FarmActionRejectedError(result.reason);

      if (type === 'plant') {
        // Planting acts on absence, so the absence is confirmed on the relays
        // first and the planting is recomputed on what they hold.
        const slotD = slotKey(mapId, record.slot.coord.x, record.slot.coord.y);
        const plot = await readPlotNow(nostr, user.pubkey, mapId, slotD);
        if (plot.newest ? !plot.current : !plot.allComplete) {
          throw new PlantRefusedError(PLANT_ERRORS.plotUnconfirmed(plot.detail));
        }
        const planted = applyFarmAction(plot.newest?.slot ?? record.slot, { type, nowSec: systemClock.now(), cropId }, CROP_CATALOG);
        if (!planted.ok) {
          queryClient.invalidateQueries({ queryKey: ['farm-slots', user.pubkey, mapId] });
          throw new FarmActionRejectedError(planted.reason);
        }
        await publishEvent({
          ...buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: planted.slot }),
          ...(plot.newest ? { replaces: plot.newest.event } : {}),
        });
        return { slot: planted.slot };
      }

      if (type !== 'harvest' || !result.harvest) {
        await publishEvent({
          ...buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: result.slot }),
          ...(record.sourceCreatedAt !== undefined ? { replaces: { created_at: record.sourceCreatedAt } } : {}),
        });
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
      if (!plot.newest || !plot.current) {
        throw new HarvestFailedError(
          plot.newest ? HARVEST_ERRORS.plotUnconfirmed(plot.detail) : plot.allComplete ? HARVEST_ERRORS.plotGone : HARVEST_ERRORS.plotUnconfirmed(plot.detail),
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
      const request: CreditIdentity = {
        produce,
        consumedEventId: plot.newest.event.id,
        consumedEventRelay: DEFAULT_GAME_RELAY,
        planting,
        liveSlotEventIds: liveSlotEventIds(queryClient.getQueryData<FarmSlots>(['farm-slots', user.pubkey, mapId])),
      };
      const credit = await runCredit(creditDeps(), lockKey, request);

      if (credit.status === 'accepted') observeRevision(lockKey, snapshotRevision(credit.event));
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
        // And look again shortly, once the relays have had a moment: a second
        // device building on an older base can replace this snapshot.
        scheduleVerification(credit.event, request, lockKey);
      }

      // Only now is it safe to remove the crop.
      try {
        await publishEvent({
          ...buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: harvested.slot }),
          replaces: plot.newest.event,
        });
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

  return { act, isActing: mutation.isPending, lastVerification };
}

/** How long after an accepted credit the relays are read back. */
export const HARVEST_VERIFY_DELAY_MS = 3000;

/** What the post-write verification of the most recent harvest found. */
export type HarvestVerification =
  | { status: 'confirmed' }
  | { status: 'recredited' }
  | { status: 'uncertain'; reason: string }
  | { status: 'lost'; reason: string };

type CreditIdentity = Omit<CreditRequest, 'unconfirmedFold'>;

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

/** Test seam: forget every revision this session has observed. */
export function forgetObservedRevisions(): void {
  knownRevisions.clear();
}

const PLOT_READ_TIMEOUT_MS = 5000;
/** Once the required relays have answered with the plot, the others get this much longer. */
const PLOT_READ_GRACE_MS = 1500;

/**
 * The plot as the game relays hold it right now, for a harvest or a planting.
 *
 * Every game relay is asked and the newest revision any of them returned is
 * `newest`, wherever it came from.
 *
 * `current` means every REQUIRED relay reached EOSE. A write succeeds only
 * when a required relay accepted it, so the newest state of the plot is on
 * one of them: with all of them heard, `newest` is the plot as it stands.
 * Without that, `newest` is only what some other relay happened to hold, and
 * is not enough to credit or to plant on.
 *
 * `allComplete` means EVERY relay reached EOSE. Only then does a missing
 * `newest` mean the plot has never been written.
 *
 * Afterwards a relay that finished its answer without that newest revision is
 * offered it.
 */
async function readPlotNow(
  nostr: RelayPool & PublishPool,
  ownerPubkey: string,
  mapId: string,
  slotD: string
): Promise<{ newest?: SlotStateEvent; current: boolean; allComplete: boolean; detail: string }> {
  const filters = [{ kinds: [KIND_SLOT_STATE], authors: [ownerPubkey], '#d': [slotD] }];
  const read = await readFromRelays(nostr, GAME_RELAY_URLS, filters, {
    timeoutMs: PLOT_READ_TIMEOUT_MS,
    graceMs: PLOT_READ_GRACE_MS,
    anchors: REQUIRED_GAME_RELAY_URLS,
  });
  void relaySync.carryMissing(nostr, {
    account: ownerPubkey,
    reads: read.reads,
    filters,
    allows: ownEventsOfKinds(ownerPubkey, [KIND_SLOT_STATE]),
    destinations: GAME_RELAY_URLS,
  });
  const newest = collectOwnedSlots(read.events, ownerPubkey, mapId).get(slotD);
  return {
    ...(newest ? { newest } : {}),
    current: allCompleteAmong(read, REQUIRED_GAME_RELAY_URLS),
    allComplete: read.allComplete,
    detail: describeReads(read.reads),
  };
}

async function runCredit(deps: CreditDeps, lockKey: string, identity: CreditIdentity): Promise<CreditResult> {
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
