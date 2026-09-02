import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';

import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { mapRef, slotAddress } from '@/nostr/identifiers';
import { collectOwnedSlots } from '@/nostr/slot-state';
import { DEFAULT_GAME_RELAY } from '@/nostr/relays';

const QUERY_TIMEOUT_MS = 5000;

export interface FarmSlots {
  /** Keyed by slot address, so lookups match the event `d` exactly. */
  byAddress: Map<string, FarmSlot>;
}

export function slotKey(mapId: string, x: number, y: number): string {
  return slotAddress(mapId, x, y);
}

/** Read the owner's slot states for one map. Non-owner events are ignored. */
export function useFarmSlots(ownerPubkey: string | undefined, mapId: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<FarmSlots>({
    queryKey: ['farm-slots', ownerPubkey, mapId],
    enabled: !!ownerPubkey && !!mapId,
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      if (!ownerPubkey || !mapId) return { byAddress: new Map() };

      const relay = nostr.relay(DEFAULT_GAME_RELAY);
      const events = await relay.query(
        [{ kinds: [KIND_SLOT_STATE], authors: [ownerPubkey], '#a': [mapRef(ownerPubkey, mapId)], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]) }
      );

      const owned = collectOwnedSlots(events, ownerPubkey, mapId);
      const byAddress = new Map<string, FarmSlot>();
      for (const [address, state] of owned) byAddress.set(address, state.slot);

      return { byAddress };
    },
  });
}

/** The slot at a coordinate, defaulting to an empty one so the grid is total. */
export function readSlot(slots: FarmSlots | undefined, mapId: string, x: number, y: number): FarmSlot {
  return slots?.byAddress.get(slotKey(mapId, x, y)) ?? emptySlot({ x, y });
}
