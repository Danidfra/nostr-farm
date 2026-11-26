import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrFilter } from '@nostrify/nostrify';

import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { mapRef, slotAddress } from '@/nostr/identifiers';
import { collectOwnedSlots } from '@/nostr/slot-state';
import { allCompleteAmong, describeReads, readFromRelays, type RelayPool } from '@/nostr/query';
import { GAME_RELAY_URLS, REQUIRED_GAME_RELAY_URLS } from '@/nostr/relays';
import { ownEventsOfKinds, relaySync, type PublishPool } from '@/nostr/relay-sync';

const QUERY_TIMEOUT_MS = 5000;
/** Once the required relays have answered with plots, the others get this much longer. */
const QUERY_GRACE_MS = 1500;
const FIELD_LIMIT = 500;

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
  /** That event's `created_at`, so a later, partial read cannot move the plot backwards. */
  sourceCreatedAt?: number;
}

export interface FarmSlots {
  /** Keyed by slot address, so lookups match the event `d` exactly. */
  byAddress: Map<string, FarmSlotRecord>;
  /**
   * Every game relay reached `EOSE` for this read. Only then is a plot with no
   * record KNOWN to be untouched; otherwise it is merely not seen, and the
   * relay that did not answer may hold a plant for it. Absent on a value that
   * did not come from a relay read (an optimistic update keeps what it had).
   */
  complete?: boolean;
}

/** The field could not be read well enough to show anything new. The last known field stays. */
export class FieldUnreadableError extends Error {
  constructor(detail: string) {
    super(`The relays did not finish answering about your field. (${detail})`);
    this.name = 'FieldUnreadableError';
  }
}

/**
 * Read the owner's plots for one map from EVERY game relay and merge them.
 *
 * No relay is believed alone, least of all the first: a relay that is new, or
 * that refuses this player's writes, holds nothing, and reading only it would
 * show bare soil where crops are growing. Each plot keeps its NIP-01 winner
 * across all the answers (`collectOwnedSlots`).
 *
 *   every relay reached EOSE     → the merged field, `complete`
 *   the required relays did      → the merged field, not `complete`: the
 *                                  newest state of every written plot is on a
 *                                  required relay, so what is shown is current,
 *                                  but a plot with no record is not proven bare
 *   a required relay did not     → what answered is folded over `previous`,
 *                                  each plot keeping its newer event; never a
 *                                  field that moves backwards
 *   nothing usable, no previous  → `FieldUnreadableError`, never an empty field
 *
 * Afterwards a relay that finished its answer without the newest state of one
 * of the player's plots is offered that event.
 */
export async function readFarmField(
  nostr: RelayPool & PublishPool,
  ownerPubkey: string,
  mapId: string,
  previous?: FarmSlots,
  signal?: AbortSignal
): Promise<FarmSlots> {
  const filters: NostrFilter[] = [
    { kinds: [KIND_SLOT_STATE], authors: [ownerPubkey], '#a': [mapRef(ownerPubkey, mapId)], limit: FIELD_LIMIT },
  ];
  const read = await readFromRelays(nostr, GAME_RELAY_URLS, filters, {
    signal,
    timeoutMs: QUERY_TIMEOUT_MS,
    graceMs: QUERY_GRACE_MS,
    anchors: REQUIRED_GAME_RELAY_URLS,
  });

  const byAddress = new Map<string, FarmSlotRecord>();
  for (const [address, state] of collectOwnedSlots(read.events, ownerPubkey, mapId)) {
    byAddress.set(address, { slot: state.slot, sourceEventId: state.event.id, sourceCreatedAt: state.event.created_at });
  }

  void relaySync.carryMissing(nostr, {
    account: ownerPubkey,
    reads: read.reads,
    filters,
    allows: ownEventsOfKinds(ownerPubkey, [KIND_SLOT_STATE]),
    destinations: GAME_RELAY_URLS,
  });

  if (read.allComplete) return { byAddress, complete: true };
  if (allCompleteAmong(read, REQUIRED_GAME_RELAY_URLS)) return { byAddress, complete: false };

  // A required relay did not finish, so what did arrive may be old.
  if (!previous && byAddress.size === 0) throw new FieldUnreadableError(describeReads(read.reads));
  const merged = new Map(previous?.byAddress);
  for (const [address, record] of byAddress) {
    const known = merged.get(address);
    const knownAt = known?.sourceCreatedAt;
    // An optimistic record has no event behind it yet; a partial read does not overrule it.
    if (known && (knownAt === undefined || knownAt > (record.sourceCreatedAt ?? 0))) continue;
    merged.set(address, record);
  }
  return { byAddress: merged, complete: false };
}

export function slotKey(mapId: string, x: number, y: number): string {
  return slotAddress(mapId, x, y);
}

/** Read the owner's slot states for one map. Non-owner events are ignored. */
export function useFarmSlots(ownerPubkey: string | undefined, mapId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  return useQuery<FarmSlots>({
    queryKey: ['farm-slots', ownerPubkey, mapId],
    enabled: !!ownerPubkey && !!mapId,
    refetchInterval: 30_000,
    queryFn: async ({ signal, queryKey }) => {
      if (!ownerPubkey || !mapId) return { byAddress: new Map() };
      // A read that could not finish throws or folds over what is cached, so
      // the last known field is what stays on screen.
      return readFarmField(nostr, ownerPubkey, mapId, queryClient.getQueryData<FarmSlots>(queryKey), signal);
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
