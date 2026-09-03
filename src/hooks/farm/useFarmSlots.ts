import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';

import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { mapRef, slotAddress } from '@/nostr/identifiers';
import { collectOwnedSlots } from '@/nostr/slot-state';
import { DEFAULT_GAME_RELAY } from '@/nostr/relays';

const QUERY_TIMEOUT_MS = 5000;

/**
 * A slot as the application sees it: the pure domain value plus the identity of
 * the kind:31417 event it came from.
 *
 * The event id is kept HERE rather than inside `FarmSlot` because `src/farm`
 * must not learn about relays or events. Harvest needs it: the id of the plant
 * event being consumed is the durable idempotency key for the inventory credit,
 * and unlike the empty slot event that replaces it, it does not change when an
 * attempt is retried.
 */
export interface FarmSlotRecord {
  slot: FarmSlot;
  /**
   * The id of the authoritative event this slot was parsed from, or
   * `undefined` for a cell that has never been written.
   */
  sourceEventId?: string;
}

export interface FarmSlots {
  /** Keyed by slot address, so lookups match the event `d` exactly. */
  byAddress: Map<string, FarmSlotRecord>;
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
      const byAddress = new Map<string, FarmSlotRecord>();
      for (const [address, state] of owned) {
        byAddress.set(address, { slot: state.slot, sourceEventId: state.event.id });
      }

      return { byAddress };
    },
  });
}

/**
 * The slot record at a coordinate, defaulting to an untouched empty cell so the
 * grid is total.
 */
export function readSlotRecord(
  slots: FarmSlots | undefined,
  mapId: string,
  x: number,
  y: number
): FarmSlotRecord {
  return slots?.byAddress.get(slotKey(mapId, x, y)) ?? { slot: emptySlot({ x, y }) };
}

/** The slot at a coordinate, for rendering and for the pure domain. */
export function readSlot(slots: FarmSlots | undefined, mapId: string, x: number, y: number): FarmSlot {
  return readSlotRecord(slots, mapId, x, y).slot;
}
