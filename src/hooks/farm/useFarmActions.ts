import { useMutation, useQueryClient } from '@tanstack/react-query';

import { CROP_CATALOG } from '@/farm/crops/catalog';
import { applyFarmAction } from '@/farm/slots/transitions';
import type { FarmActionType } from '@/farm/slots/actions';
import type { FarmSlot } from '@/farm/slots/types';
import type { HarvestResult } from '@/farm/harvest/types';
import { systemClock } from '@/farm/time';
import { buildSlotState } from '@/nostr/slot-state';
import { slotKey, type FarmSlots } from './useFarmSlots';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';

export interface FarmActionInput {
  mapId: string;
  slot: FarmSlot;
  type: FarmActionType;
  cropId?: string;
}

export class FarmActionRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'FarmActionRejectedError';
  }
}

const MESSAGES: Record<string, string> = {
  unknown_action: 'That action does not exist.',
  unknown_crop: 'That crop is not in the catalog.',
  slot_occupied: 'Something is already growing here.',
  slot_empty: 'There is nothing planted here.',
  plant_rotten: 'This crop has rotted — clear it first.',
  plant_not_rotten: 'This crop is still alive.',
  not_ready: 'This crop is not ready to harvest yet.',
  already_saturated: 'This crop is already as wet as it can get.',
};

/**
 * Perform a farm action.
 *
 * The flow is deliberately: **validate locally with the pure domain, then
 * publish the resulting state**. The player is the authority for their own
 * farm, so there is no intent event, no host election and no processor to poll.
 *
 * A future visitor flow slots in at exactly this point: a visitor publishes an
 * intent event, the owner's client checks permission, and then runs this same
 * `applyFarmAction` and publishes the same resulting `SlotState`. Nothing in
 * `src/farm` has to change for that.
 */
export function useFarmActions() {
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation<{ slot: FarmSlot; harvest?: HarvestResult }, Error, FarmActionInput>({
    mutationFn: async ({ mapId, slot, type, cropId }) => {
      if (!user) throw new Error('Sign in to work your farm.');

      const result = applyFarmAction(slot, { type, nowSec: systemClock.now(), cropId }, CROP_CATALOG);
      if (!result.ok) throw new FarmActionRejectedError(result.reason);

      await publishEvent(buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: result.slot }));
      return { slot: result.slot, harvest: result.harvest };
    },

    onMutate: async ({ mapId, slot, type, cropId }) => {
      if (!user) return;
      const key = ['farm-slots', user.pubkey, mapId];
      await queryClient.cancelQueries({ queryKey: key });

      // Optimistic update: run the same transition and patch the cache, so the
      // grid reacts instantly and still shows exactly what will be published.
      const result = applyFarmAction(slot, { type, nowSec: systemClock.now(), cropId }, CROP_CATALOG);
      if (!result.ok) return;

      const previous = queryClient.getQueryData<FarmSlots>(key);
      if (previous) {
        const byAddress = new Map(previous.byAddress);
        byAddress.set(slotKey(mapId, slot.coord.x, slot.coord.y), result.slot);
        queryClient.setQueryData<FarmSlots>(key, { byAddress });
      }
      return { previous, key };
    },

    onError: (error, _input, context) => {
      const ctx = context as { previous?: FarmSlots; key?: unknown[] } | undefined;
      if (ctx?.previous && ctx.key) queryClient.setQueryData(ctx.key, ctx.previous);

      toast({
        variant: 'destructive',
        title: 'Action failed',
        description: error instanceof FarmActionRejectedError ? (MESSAGES[error.reason] ?? error.reason) : error.message,
      });
    },

    onSuccess: (_data, { mapId }) => {
      if (!user) return;
      queryClient.invalidateQueries({ queryKey: ['farm-slots', user.pubkey, mapId] });
    },
  });

  return {
    act: mutation.mutateAsync,
    isActing: mutation.isPending,
  };
}
