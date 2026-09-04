import { useMutation, useQueryClient } from '@tanstack/react-query';

import { CROP_CATALOG, getCrop } from '@/farm/crops/catalog';
import type { FarmSlot } from '@/farm/slots/types';
import { systemClock } from '@/farm/time';
import { buildSlotState } from '@/nostr/slot-state';
import { slotKey, type FarmSlotRecord, type FarmSlots } from '@/hooks/farm/useFarmSlots';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { DEV_TOOLS_ENABLED } from '@/dev/enabled';
import { canUseDevFarmTools } from './access';
import { acceleratedToReady } from './accelerate';

export interface AccelerateCropInput {
  mapId: string;
  record: FarmSlotRecord;
}

/**
 * Developer-only: publish a planted slot as already harvestable.
 *
 * This is the SAME write the game performs for plant and water — one
 * owner-signed kind:31417 replacement built by `buildSlotState` and published
 * through `useNostrPublish` — carrying the state `acceleratedToReady` computes.
 * It touches no inventory: the crop still has to be harvested on the field,
 * and that harvest runs the production pipeline unchanged, with the id of
 * the event published here as its idempotency marker.
 *
 * The hook refuses to run for anybody but the authorized developer even if
 * something rendered a button for them; see `access.ts` for what that gate is
 * and is not.
 */
export function useAccelerateCrop() {
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation<{ slot: FarmSlot; eventId: string }, Error, AccelerateCropInput>({
    mutationFn: async ({ mapId, record }) => {
      if (!canUseDevFarmTools({ enabled: DEV_TOOLS_ENABLED, pubkey: user?.pubkey })) {
        throw new Error('Developer tools are not available for this session.');
      }
      if (!user) throw new Error('Sign in to work your farm.');

      const { slot } = record;
      if (slot.content.type !== 'plant') throw new Error('Nothing is planted in that slot.');
      const crop = getCrop(slot.content.plant.cropId, CROP_CATALOG);
      if (!crop) throw new Error(`Unknown crop "${slot.content.plant.cropId}".`);

      const plant = acceleratedToReady(slot.content.plant, crop, systemClock.now());
      const next: FarmSlot = { coord: slot.coord, content: { type: 'plant', plant } };

      const event = await publishEvent(buildSlotState({ mapId, ownerPubkey: user.pubkey, slot: next }));

      // The field must harvest THIS event, so the cache learns its id at once
      // rather than waiting for the next relay poll.
      const key = ['farm-slots', user.pubkey, mapId];
      const previous = queryClient.getQueryData<FarmSlots>(key);
      const byAddress = new Map(previous?.byAddress);
      byAddress.set(slotKey(mapId, slot.coord.x, slot.coord.y), { slot: next, sourceEventId: event.id });
      queryClient.setQueryData<FarmSlots>(key, { byAddress });

      return { slot: next, eventId: event.id };
    },
  });
}
