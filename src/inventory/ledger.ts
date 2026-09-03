import type { NostrEvent } from '@nostrify/nostrify';

import {
  KIND_GAME_INVENTORY_FOLD,
  KIND_GAME_INVENTORY_SPEND,
  parseGameInventoryFoldResult,
  parseGameInventorySpendResult,
  type GameInventory,
} from './package';
import { farmInventoryAddress, parseFarmSnapshot, preferNewerInventory } from './farm-inventory';

/**
 * The Farm's LEDGER for one player's `farm:main`: everything the read side has
 * learned, from any source, that the effective balance is derived from.
 *
 * ```text
 * ledger = canonical snapshot (kind:31633)
 *        + every valid spend seen   (kind:1416, immutable, keyed by id)
 *        + every valid manifest seen (kind:1417, immutable, keyed by id)
 * ```
 *
 * Two properties make it safe to feed from an initial fetch, a live relay
 * stream and a later refetch in any order:
 *
 * - **Admission is a gate, not a derivation.** An event enters only if it is
 *   the owner's own, well-formed, and scoped to this exact inventory address.
 *   Whether a spend is pending, folded, voided or an overdraw is decided later
 *   by the package's `resolveGameInventoryState`, never here.
 * - **Merging is monotonic.** Spends and manifests are unioned by id; the
 *   snapshot is replaced only by a newer one. A stale response can therefore
 *   never erase a spend or a snapshot the ledger already knows.
 *
 * Pure: no network, no clock, no React.
 */
export interface FarmLedger {
  readonly owner: string;
  /** The canonical kind:31633, or `null` when none has been seen. */
  readonly snapshot: GameInventory | null;
  /** Valid kind:1416 spends against this inventory, by event id. */
  readonly spends: ReadonlyMap<string, NostrEvent>;
  /** Valid kind:1417 manifests for this inventory, by event id. */
  readonly folds: ReadonlyMap<string, NostrEvent>;
}

export interface LedgerUpdate {
  ledger: FarmLedger;
  /** False when nothing new was learned; the input ledger is returned as-is. */
  changed: boolean;
}

export function emptyLedger(owner: string): FarmLedger {
  return { owner, snapshot: null, spends: new Map(), folds: new Map() };
}

/**
 * Classify one event against this owner's `farm:main`, or reject it.
 *
 * - kind:31633: the owner's own valid `farm:main` snapshot;
 * - kind:1416: parses as a spend (which already requires author == inventory
 *   owner), by THIS owner, against THIS full inventory address;
 * - kind:1417: same, for a manifest.
 *
 * Anything else — another kind, another author, another inventory of the same
 * player, a malformed quantity or address — is `null` and never enters.
 */
export function classifyLedgerEvent(
  event: NostrEvent,
  owner: string
): { kind: 'snapshot'; snapshot: GameInventory } | { kind: 'spend' } | { kind: 'fold' } | null {
  if (event.kind === KIND_GAME_INVENTORY_SPEND) {
    const parsed = parseGameInventorySpendResult(event);
    if (!parsed.ok) return null;
    if (parsed.value.owner !== owner || parsed.value.inventoryAddress !== farmInventoryAddress(owner)) return null;
    return { kind: 'spend' };
  }
  if (event.kind === KIND_GAME_INVENTORY_FOLD) {
    const parsed = parseGameInventoryFoldResult(event);
    if (!parsed.ok) return null;
    if (parsed.value.owner !== owner || parsed.value.inventoryAddress !== farmInventoryAddress(owner)) return null;
    return { kind: 'fold' };
  }
  const snapshot = parseFarmSnapshot(event, owner);
  return snapshot ? { kind: 'snapshot', snapshot } : null;
}

/** Admit one event. Returns the same ledger, unchanged, when it adds nothing. */
export function admitLedgerEvent(ledger: FarmLedger, event: NostrEvent): LedgerUpdate {
  const classified = classifyLedgerEvent(event, ledger.owner);
  if (!classified) return { ledger, changed: false };

  if (classified.kind === 'snapshot') {
    const next = ledger.snapshot ? preferNewerInventory(ledger.snapshot, classified.snapshot) : classified.snapshot;
    if (next === ledger.snapshot) return { ledger, changed: false };
    return { ledger: { ...ledger, snapshot: next }, changed: true };
  }

  const store = classified.kind === 'spend' ? ledger.spends : ledger.folds;
  if (store.has(event.id)) return { ledger, changed: false };
  const grown = new Map(store);
  grown.set(event.id, event);
  return {
    ledger: classified.kind === 'spend' ? { ...ledger, spends: grown } : { ...ledger, folds: grown },
    changed: true,
  };
}

/** Admit many events, in order. */
export function admitLedgerEvents(ledger: FarmLedger, events: Iterable<NostrEvent>): LedgerUpdate {
  let current = ledger;
  let changed = false;
  for (const event of events) {
    const next = admitLedgerEvent(current, event);
    current = next.ledger;
    changed ||= next.changed;
  }
  return { ledger: current, changed };
}

/** Build a ledger from scratch out of raw relay results. Non-ledger events are dropped. */
export function ledgerFromEvents(owner: string, events: Iterable<NostrEvent>): FarmLedger {
  return admitLedgerEvents(emptyLedger(owner), events).ledger;
}

/**
 * Fold `incoming` into `current` without ever losing what `current` knows.
 *
 * Union by id for the immutable kinds; newest-wins for the snapshot. Both
 * inputs are already-admitted ledgers of the same owner, so nothing is
 * re-validated. Commutative up to snapshot ties, idempotent, and cheap.
 */
export function mergeLedgers(current: FarmLedger, incoming: FarmLedger): LedgerUpdate {
  if (current.owner !== incoming.owner) {
    throw new Error('Refusing to merge ledgers of two different owners.');
  }

  let ledger = current;
  let changed = false;

  if (incoming.snapshot) {
    const next = ledger.snapshot ? preferNewerInventory(ledger.snapshot, incoming.snapshot) : incoming.snapshot;
    if (next !== ledger.snapshot) {
      ledger = { ...ledger, snapshot: next };
      changed = true;
    }
  }

  const spends = union(ledger.spends, incoming.spends);
  if (spends) {
    ledger = { ...ledger, spends };
    changed = true;
  }
  const folds = union(ledger.folds, incoming.folds);
  if (folds) {
    ledger = { ...ledger, folds };
    changed = true;
  }

  return { ledger, changed };
}

/** `a ∪ b`, or `undefined` when `b` adds nothing to `a`. */
function union(a: ReadonlyMap<string, NostrEvent>, b: ReadonlyMap<string, NostrEvent>): Map<string, NostrEvent> | undefined {
  let grown: Map<string, NostrEvent> | undefined;
  for (const [id, event] of b) {
    if (a.has(id)) continue;
    grown ??= new Map(a);
    grown.set(id, event);
  }
  return grown;
}

/**
 * Do two ledgers hold the same events?
 *
 * Only meaningful when one is a merge that includes the other, which is how it
 * is used: equal sizes and the same snapshot then mean equal contents.
 */
export function sameLedgerContents(a: FarmLedger, b: FarmLedger): boolean {
  return (
    a.owner === b.owner &&
    (a.snapshot?.event.id ?? null) === (b.snapshot?.event.id ?? null) &&
    a.spends.size === b.spends.size &&
    a.folds.size === b.folds.size
  );
}
