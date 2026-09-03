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
 * Has this exact plant event already been credited?
 *
 * This is the whole idempotency story. The consumed plant event id is durable,
 * identical on every device, and — unlike the empty slot event that replaces it
 * — unchanged when an attempt is retried.
 */
export function isHarvestCredited(inventory: GameInventory | null, consumedEventId: string): boolean {
  return harvestedEventIds(inventory).includes(consumedEventId);
}

/** The quantity of one produce item currently held. */
export function produceQuantity(inventory: GameInventory | null, address: string): number {
  return inventory ? getInventoryItemQuantity(inventory, address) : 0;
}

/**
 * Pick the newest valid `farm:main` inventory the owner authored.
 *
 * Events from anybody else are ignored outright: this is the owner's own
 * inventory, and a stranger's event at the same `d` is a different inventory.
 */
export function selectNewestInventory(events: readonly NostrEvent[], ownerPubkey: string): GameInventory | null {
  let newest: GameInventory | null = null;

  for (const event of events) {
    if (event.pubkey !== ownerPubkey) continue;
    if (event.kind !== KIND_GAME_INVENTORY) continue;

    const parsed = parseGameInventoryResult(event, { mode: 'permissive' });
    if (!parsed.ok || parsed.value.id !== FARM_INVENTORY_D) continue;

    if (!newest || event.created_at > newest.event.created_at) newest = parsed.value;
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
  const { base, produce, consumedEventId, consumedEventRelay, fold } = input;
  const marker: string[] = ['e', consumedEventId, consumedEventRelay, FARM_HARVEST_MARKER];
  // A new manifest replaces the reference; no new manifest keeps the base's.
  const foldInput = fold ? { fold: { eventId: fold.eventId, relay: fold.relay } } : {};

  if (!base) {
    return buildGameInventoryEvent({
      id: FARM_INVENTORY_D,
      contexts: [FARM_GAME_CONTEXT],
      items: [{ address: produce.address, relay: produce.relayHint, quantity: 1 }],
      revision: 1,
      ...foldInput,
      extraTags: [marker],
    });
  }

  const next = addInventoryItemQuantity(base, produce.address, 1, produce.relayHint);

  return buildGameInventoryEvent({
    ...toBuildGameInventoryInput(next),
    ...foldInput,
    revision: (next.revision ?? 0) + 1,
    extraTags: [marker],
  });
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
