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
import { buildSlotState } from '@/nostr/slot-state';
import { DEFAULT_GAME_RELAY } from '@/nostr/relays';
import { creditHarvest, reconcileCredit, type CreditDeps, type CreditResult } from '@/inventory/credit-harvest';
import { FARM_INVENTORY_D } from '@/inventory/farm-inventory';
import { getProduceForCrop, type ProduceDefinition } from '@/inventory/produce-catalog';
import { withSerializedWrite } from '@/lib/write-lock';
import { slotKey, type FarmSlotRecord, type FarmSlots } from './useFarmSlots';
import { farmInventoryReadDeps, publishFarmInventory, INVENTORY_RELAY_HINT } from './inventory-relays';
import { farmInventoryQueryKey, setFarmInventory } from './useFarmInventory';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { ACTION_REJECTION_MESSAGES, HARVEST_TOAST } from '@/components/farm/copy';

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
    return {
      ownerPubkey: user.pubkey,
      ...farmInventoryReadDeps(nostr, user.pubkey),
      signEvent: (template) => user.signer.signEvent(template),
      publish: publishFarmInventory(nostr),
      nowSec: () => systemClock.now(),
      relayHint: INVENTORY_RELAY_HINT,
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

      if (!record.sourceEventId) {
        throw new HarvestFailedError(
          'This crop has not been confirmed on a relay yet. Refresh and try again.',
          'inventory',
          false
        );
      }

      const credit = await runCredit(creditDeps(), record.sourceEventId, produce);

      if (credit.status === 'rejected' || credit.status === 'fold-unconfirmed') {
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
        await publishEvent(buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: result.slot }));
      } catch (error) {
        throw new HarvestFailedError(
          `Your ${produce.name} was added, but clearing the crop failed. Harvest it again to finish — it will not be counted twice. (${error instanceof Error ? error.message : String(error)})`,
          'slot',
          false
        );
      }

      return { slot: result.slot, harvest: result.harvest, produce };
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
async function runCredit(
  deps: CreditDeps,
  consumedEventId: string,
  produce: ProduceDefinition
): Promise<CreditResult> {
  const lockKey = `nostr-worlds:inventory:${deps.ownerPubkey}:${FARM_INVENTORY_D}`;

  return withSerializedWrite(lockKey, async () => {
    const request = { produce, consumedEventId, consumedEventRelay: DEFAULT_GAME_RELAY, unconfirmedFold: unconfirmedFolds.get(lockKey) };
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
