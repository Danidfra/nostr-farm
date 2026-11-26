import type { NostrEvent } from '@nostrify/nostrify';

import {
  KIND_GAME_INVENTORY,
  addInventoryItemQuantity,
  buildGameInventoryAddress,
  buildGameInventoryEvent,
  getInventoryItemQuantity,
  parseGameInventoryResult,
  toBuildGameInventoryInput,
  type GameInventory,
  type UnsignedEventTemplate,
} from './package';
import { FARM_GAME_CONTEXT } from './constants';
import { FARM_INVENTORY_CONTEXT } from './package';
import type { ProduceDefinition } from './produce-catalog';
import type { EventReference } from './relay-io';

/**
 * The pure half of the Farm's kind:31633 inventory: markers, base selection and
 * event construction. No network, no signer, no React — all of it testable.
 */

/**
 * The `e` tag marker recording which harvest a credit came from.
 *
 * NOT `grant`. The spec frames grant references as issuer-signed receipts to be
 * audited, and a player's own harvest event is not that; overloading the marker
 * would make this inventory claim something it cannot back. `farm-harvest` is a
 * Farm-specific marker on an otherwise ordinary `e` tag, which the package
 * treats as unmanaged and carries through every rebuild losslessly. Real grant
 * semantics remain available, unused and unclaimed.
 */
export const FARM_HARVEST_MARKER = 'farm-harvest';

/**
 * The per-plot harvest record: `["harvest", "<slot d>", "<plantedAt>"]`.
 *
 * The `e` marker above names the plant EVENT that was consumed, and that id
 * changes every time the plant is watered: one planting is E1 when sown, E2
 * after the first watering, E3 after the next. Two harvesters holding
 * different versions of the same ripe plant therefore present different ids,
 * and an id-keyed check lets both of them credit it. The planting itself is
 * identified by its plot and its `plantedAt`, which every transition carries
 * through unchanged and which `plantingTime` keeps strictly increasing per
 * plot. One record per plot — the newest planting credited there — answers
 * "has this planting been credited?" permanently: any planting with a
 * `plantedAt` at or below the record is an older cycle of that plot, or the
 * same one, and either way was credited already.
 *
 * The record set is bounded by the number of plots ever harvested, not by the
 * number of harvests. That is 36 for every farm that exists today; it grows
 * with the field. See `docs/farm-inventory.md` for what has to change before
 * a farm can have thousands of plots.
 */
export const FARM_HARVEST_RECORD_TAG = 'harvest';

/**
 * How many `farm-harvest` `e` markers a snapshot retains, beyond the ones that
 * are still live (see `retainFarmTags`). The markers only identify a credit by
 * event id, for reconciling an ambiguous publish and for change attribution;
 * the per-plot record is what prevents a second credit.
 */
export const MAX_LEGACY_HARVEST_MARKERS = 64;

/** One planting cycle of one plot: the identity a harvest is credited under. */
export interface HarvestRecord {
  /** The kind:31417 `d` tag, `slot:<map>:<x>:<y>`. */
  slotD: string;
  plantedAt: number;
}

/** Everything that can identify a harvest: the consumed event, and the planting it belonged to. */
export interface HarvestIdentity {
  consumedEventId: string;
  planting?: HarvestRecord;
}

/** The inventory context the Farm writes. It writes no other. */
export const FARM_INVENTORY_D = FARM_INVENTORY_CONTEXT;

/**
 * The full `31633:<owner>:farm:main` address.
 *
 * Every spend and every fold manifest names the inventory by this full
 * coordinate. `farm:main` on its own is not an identity — it is the same `d`
 * for every player.
 */
export function farmInventoryAddress(ownerPubkey: string): string {
  return buildGameInventoryAddress(ownerPubkey, FARM_INVENTORY_D);
}

/**
 * The inventory a player who has none yet is treated as holding: nothing.
 *
 * Used only as the BASE a derivation runs against when the confirmed read found
 * no snapshot. It is never published as-is, and it has no bearing on whether a
 * write is allowed to create a first inventory — `credit-harvest.ts` still
 * insists on a confirmed empty read for that. Its purpose is to let the spend
 * derivation run through the same code path: a spend against an inventory that
 * holds nothing is an overdraw, and an overdraw is voided rather than left to
 * apply against whatever the first harvest adds.
 */
export function emptyFarmInventory(ownerPubkey: string): GameInventory {
  const template = buildGameInventoryEvent({ id: FARM_INVENTORY_D, contexts: [FARM_GAME_CONTEXT], items: [] });
  const parsed = parseGameInventoryResult(
    { ...template, id: '', pubkey: ownerPubkey, created_at: 0, sig: '' },
    { mode: 'permissive' }
  );
  if (!parsed.ok) throw new Error(`Could not build the empty farm inventory: ${parsed.error}`);
  return parsed.value;
}

/** Every consumed plant event id already credited in this inventory. */
export function harvestedEventIds(inventory: GameInventory | null): string[] {
  if (!inventory) return [];
  return inventory.event.tags
    .filter((tag) => tag[0] === 'e' && tag[3] === FARM_HARVEST_MARKER && typeof tag[1] === 'string' && tag[1] !== '')
    .map((tag) => tag[1]);
}

/**
 * The newest planting credited in each plot: slot `d` → `plantedAt`.
 *
 * A malformed record (blank plot, non-integer time) is ignored rather than
 * trusted; several records for one plot collapse to the newest.
 */
export function harvestRecords(inventory: GameInventory | null): Map<string, number> {
  const records = new Map<string, number>();
  if (!inventory) return records;
  for (const tag of inventory.event.tags) {
    const record = parseHarvestRecordTag(tag);
    if (!record) continue;
    const current = records.get(record.slotD);
    if (current === undefined || record.plantedAt > current) records.set(record.slotD, record.plantedAt);
  }
  return records;
}

function parseHarvestRecordTag(tag: string[]): HarvestRecord | null {
  if (tag[0] !== FARM_HARVEST_RECORD_TAG || typeof tag[1] !== 'string' || tag[1] === '') return null;
  const plantedAt = Number(tag[2]);
  if (!Number.isInteger(plantedAt) || plantedAt < 0) return null;
  return { slotD: tag[1], plantedAt };
}

/**
 * Has this harvest already been credited?
 *
 * Two independent checks, either of which is enough:
 *
 * - the consumed plant event id is among the `farm-harvest` markers — the
 *   same attempt, retried, or an ambiguous publish that did land;
 * - the plot's record is at or past the planting's `plantedAt` — the same
 *   planting seen through a different event (watered elsewhere, or a stale
 *   version that resurfaced), or an older cycle of the plot altogether.
 *
 * A legacy snapshot with markers and no records still answers through the
 * first check, exactly as it did before records existed.
 */
export function isHarvestCredited(inventory: GameInventory | null, harvest: string | HarvestIdentity): boolean {
  const identity: HarvestIdentity = typeof harvest === 'string' ? { consumedEventId: harvest } : harvest;
  if (harvestedEventIds(inventory).includes(identity.consumedEventId)) return true;
  if (!identity.planting) return false;
  const credited = harvestRecords(inventory).get(identity.planting.slotD);
  return credited !== undefined && credited >= identity.planting.plantedAt;
}

/** The quantity of one produce item currently held. */
export function produceQuantity(inventory: GameInventory | null, address: string): number {
  return inventory ? getInventoryItemQuantity(inventory, address) : 0;
}

/**
 * Parse one event as the owner's own `farm:main` snapshot, or `null`.
 *
 * Events from anybody else are ignored outright: this is the owner's own
 * inventory, and a stranger's event at the same `d` is a different inventory.
 * This is the single admission rule for kind:31633 on the read side and the
 * write side alike.
 */
export function parseFarmSnapshot(event: NostrEvent, ownerPubkey: string): GameInventory | null {
  if (event.pubkey !== ownerPubkey) return null;
  if (event.kind !== KIND_GAME_INVENTORY) return null;

  const parsed = parseGameInventoryResult(event, { mode: 'permissive' });
  if (!parsed.ok || parsed.value.id !== FARM_INVENTORY_D) return null;
  return parsed.value;
}

/**
 * Which of two valid snapshots of the same inventory is the canonical one?
 *
 * Newer `created_at` wins — that is how relays resolve an addressable event,
 * so it is what every other reader sees. On an exact tie the lower id wins,
 * which is NIP-01's rule too. The Farm's own writes stamp every replacement
 * strictly after its predecessor, so a tie only ever involves a foreign or
 * duplicated event, and the answer must merely be deterministic.
 */
export function preferNewerInventory(current: GameInventory, incoming: GameInventory): GameInventory {
  if (incoming.event.created_at > current.event.created_at) return incoming;
  if (incoming.event.created_at === current.event.created_at && (incoming.event.id ?? '') < (current.event.id ?? '')) return incoming;
  return current;
}

/** The `revision` tag of a snapshot event, when it carries a valid one. */
export function snapshotRevision(event: NostrEvent): number | undefined {
  const raw = event.tags.find(([name]) => name === 'revision')?.[1];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Pick the newest valid `farm:main` inventory the owner authored. */
export function selectNewestInventory(events: readonly NostrEvent[], ownerPubkey: string): GameInventory | null {
  let newest: GameInventory | null = null;

  for (const event of events) {
    const parsed = parseFarmSnapshot(event, ownerPubkey);
    if (!parsed) continue;
    newest = newest ? preferNewerInventory(newest, parsed) : parsed;
  }

  return newest;
}

export interface CreditInput {
  /**
   * The inventory to credit ON TOP OF, or `null` when the player provably has
   * none yet.
   *
   * In the spend-aware write path this is the EFFECTIVE inventory — the
   * snapshot minus every applied pending spend — not the raw snapshot. Its
   * `event` is still the snapshot's, which is what keeps the round-trip
   * lossless: unmanaged tags, the harvest markers and the current fold
   * reference all come from there.
   */
  base: GameInventory | null;
  produce: ProduceDefinition;
  /** The kind:31417 plant event this harvest consumes. */
  consumedEventId: string;
  /** Relay hint for the consumed event, so the marker is resolvable. */
  consumedEventRelay: string;
  /**
   * The planting this harvest ends. Written as the plot's `harvest` record,
   * replacing the plot's previous one. Every real harvest has it; it is
   * optional only so the pure builder can be exercised without one.
   */
  planting?: HarvestRecord;
  /**
   * The kind:31417 event ids currently holding every plot of the map, as the
   * client last read them. A legacy `farm-harvest` marker older than the
   * retained window is dropped only when its event is NOT among these — an
   * event that is still the current state of a plot could still be presented
   * for harvest, so its marker stays. Omit it, and no marker is dropped.
   */
  liveSlotEventIds?: readonly string[];
  /**
   * The kind:1417 manifest this snapshot newly settles spends through. Omit it
   * when nothing was settled: the base's own fold reference then round-trips
   * unchanged, which is what keeps already-folded spends folded.
   */
  fold?: EventReference;
}

/**
 * Build the unsigned kind:31633 that credits one unit of produce.
 *
 * Two paths, deliberately:
 *
 * - **No base.** A first inventory is built from scratch at revision 1. This is
 *   only ever reached once an empty read has been CONFIRMED — see
 *   `credit-harvest.ts`. Building a replacement from an unconfirmed empty read
 *   is how an entire inventory gets wiped.
 * - **A base.** Everything goes back through `toBuildGameInventoryInput`, which
 *   returns the structured fields AND `preserveTags` for every tag the builder
 *   does not manage. Rebuilding by hand from `{ id, items }` compiles, looks
 *   right, and permanently deletes the contexts, content and unknown tags other
 *   applications wrote — including our own earlier harvest markers.
 */
export function buildCreditEvent(input: CreditInput): UnsignedEventTemplate<typeof KIND_GAME_INVENTORY> {
  const { base, produce, consumedEventId, consumedEventRelay, planting, liveSlotEventIds, fold } = input;
  const marker: string[] = ['e', consumedEventId, consumedEventRelay, FARM_HARVEST_MARKER];
  const extraTags: string[][] = planting
    ? [marker, [FARM_HARVEST_RECORD_TAG, planting.slotD, String(planting.plantedAt)]]
    : [marker];
  // A new manifest replaces the reference; no new manifest keeps the base's.
  const foldInput = fold ? { fold: { eventId: fold.eventId, relay: fold.relay } } : {};

  if (!base) {
    return buildGameInventoryEvent({
      id: FARM_INVENTORY_D,
      contexts: [FARM_GAME_CONTEXT],
      items: [{ address: produce.address, relay: produce.relayHint, quantity: 1 }],
      revision: 1,
      ...foldInput,
      extraTags,
    });
  }

  const next = addInventoryItemQuantity(base, produce.address, 1, produce.relayHint);
  const rebuilt = toBuildGameInventoryInput(next);

  return buildGameInventoryEvent({
    ...rebuilt,
    preserveTags: retainFarmTags(rebuilt.preserveTags ?? [], { planting, liveSlotEventIds }),
    ...foldInput,
    revision: (next.revision ?? 0) + 1,
    extraTags,
  });
}

/**
 * Decide which of the Farm's own tags a rebuilt snapshot keeps. Every tag that
 * is not the Farm's passes through untouched, in its original order.
 *
 * - **Records** are permanent. The only record ever removed is the one for
 *   the plot being credited now, which the new record replaces. Age is never
 *   a reason: the record is the proof that a plot's planting was credited, and
 *   that proof has no expiry.
 * - **Legacy `e` markers** are bounded. The newest `MAX_LEGACY_HARVEST_MARKERS − 1`
 *   stay (the new one makes the full window), and so does any older marker
 *   whose event is still the current state of some plot (`liveSlotEventIds`),
 *   because such an event could still be presented for harvest. Without a
 *   live-id list nothing can be vouched for, so nothing is dropped. A marker
 *   dropped under this rule can only matter again if a relay loses the newer
 *   slot events and an old one resurfaces as current.
 */
export function retainFarmTags(
  tags: readonly string[][],
  options: { planting?: HarvestRecord; liveSlotEventIds?: readonly string[] }
): string[][] {
  const live = options.liveSlotEventIds ? new Set(options.liveSlotEventIds) : null;
  const markerPositions = tags.flatMap((tag, index) => (isLegacyMarker(tag) ? [index] : []));
  const windowStart = markerPositions.length - (MAX_LEGACY_HARVEST_MARKERS - 1);
  const dropMarkers = new Set(
    live ? markerPositions.filter((position, rank) => rank < windowStart && !live.has(tags[position][1])) : []
  );

  return tags.filter((tag, index) => {
    if (dropMarkers.has(index)) return false;
    const record = parseHarvestRecordTag(tag);
    if (record && options.planting && record.slotD === options.planting.slotD) return false;
    return true;
  });
}

function isLegacyMarker(tag: string[]): boolean {
  return tag[0] === 'e' && tag[3] === FARM_HARVEST_MARKER && typeof tag[1] === 'string' && tag[1] !== '';
}

/**
 * `created_at` for a replacement, strictly after the event it replaces.
 *
 * Relays resolve addressable events by `created_at`, so a replacement stamped
 * in the same second as its predecessor may not win. Never backdated below the
 * previous value.
 */
export function nextCreatedAt(previous: GameInventory | null, nowSec: number): number {
  const floor = previous ? previous.event.created_at + 1 : 0;
  return Math.max(nowSec, floor);
}
