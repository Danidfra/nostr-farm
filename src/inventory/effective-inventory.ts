import type { NostrEvent } from '@nostrify/nostrify';

import {
  resolveGameInventoryState,
  type GameInventory,
  type GameInventoryDerivedState,
  type GameInventoryFoldProblem,
  type GameInventoryFoldResolution,
} from './package';
import { dedupeEventsById, type EventReference, type InventoryReadResult } from './relay-io';

/**
 * The Farm's EFFECTIVE inventory: what the player actually holds once the
 * kind:1416 spends other games have published against `farm:main` are taken
 * into account.
 *
 * ```text
 * effective = snapshot − applied pending spends
 * ```
 *
 * where "pending" means "not settled by the kind:1417 fold chain the snapshot
 * references". The arithmetic, the ordering, the overdraw rule and the chain
 * walk are all the package's (`resolveGameInventoryState`); this module only
 * decides what to fetch and how to present the answer. It never reimplements
 * a protocol rule and never publishes anything.
 *
 * The spec is `docs/1416-1417-game-inventory-spend.md` in
 * `@nostr-games/inventory`; the Farm-specific summary is
 * `docs/farm-inventory.md`.
 */

export type FarmInventoryResolution =
  /**
   * The chain resolved and a balance was derived. `inventory` is the effective
   * state; `snapshot` is the raw kind:31633 it was derived from.
   */
  | {
      status: 'ready';
      snapshot: GameInventory;
      inventory: GameInventory;
      state: GameInventoryDerivedState;
      chain: GameInventoryFoldResolution;
      folds: NostrEvent[];
      spends: NostrEvent[];
    }
  /**
   * The snapshot references a fold chain that could not be verified — a
   * manifest is missing, malformed, foreign, or claims a spend it cannot have
   * settled. NO balance exists in this state. The raw snapshot is the last
   * consolidated statement and may be shown as such, but it MUST NOT be
   * presented as the balance and MUST NOT be written on top of: doing either
   * could resurrect items another game already consumed.
   */
  | {
      status: 'unresolved';
      snapshot: GameInventory;
      chain: GameInventoryFoldResolution;
      problems: GameInventoryFoldProblem[];
      folds: NostrEvent[];
      spends: NostrEvent[];
    };

export interface ResolveFarmInventoryInput {
  snapshot: GameInventory;
  /** Candidate kind:1417 events, any order, duplicates tolerated. */
  folds: readonly NostrEvent[];
  /** Candidate kind:1416 events, any order, duplicates tolerated. */
  spends: readonly NostrEvent[];
}

/**
 * Resolve the effective inventory from events already in hand. Pure.
 *
 * Everything that matters is delegated: wrong-author and foreign spends are
 * invalid/ignored by the package's parser, folded and voided ids are excluded
 * by the chain walk, and pending spends are applied or rejected in the
 * normative `(created_at, id)` order. A spend that debits an item the snapshot
 * does not hold is simply an overdraw against a balance of zero and is
 * rejected; the Farm invents no balance for it.
 */
export function resolveFarmInventory(input: ResolveFarmInventoryInput): FarmInventoryResolution {
  const folds = dedupeEventsById(input.folds);
  const spends = dedupeEventsById(input.spends);
  const resolution = resolveGameInventoryState({ inventory: input.snapshot, folds, spends });

  if (resolution.status !== 'resolved') {
    return {
      status: 'unresolved',
      snapshot: input.snapshot,
      chain: resolution.chain,
      problems: resolution.chain.problems,
      folds,
      spends,
    };
  }

  return {
    status: 'ready',
    snapshot: input.snapshot,
    inventory: resolution.state.inventory,
    state: resolution.state,
    chain: resolution.chain,
    folds,
    spends,
  };
}

/**
 * The manifests a failed resolution could not find, each with the best relay
 * hint the chain offers for it: the snapshot's own `fold` tag for the head,
 * the `previous` link of the manifest that named it for anything deeper.
 *
 * Only `missing-fold` problems are retrievable. An invalid, foreign or cyclic
 * manifest is not going to become valid by fetching it again.
 */
export function missingFoldReferences(snapshot: GameInventory, chain: GameInventoryFoldResolution): EventReference[] {
  const hints = new Map<string, string>();
  if (snapshot.fold) hints.set(snapshot.fold.eventId, snapshot.fold.relay);
  for (const fold of chain.chain) {
    if (fold.previous) hints.set(fold.previous.eventId, fold.previous.relay);
  }

  const references: EventReference[] = [];
  for (const problem of chain.problems) {
    if (problem.code !== 'missing-fold' || !problem.foldId) continue;
    if (references.some((reference) => reference.eventId === problem.foldId)) continue;
    references.push({ eventId: problem.foldId, relay: hints.get(problem.foldId) ?? '' });
  }
  return references;
}

/** How the read model reaches relays. Implemented by `hooks/farm/inventory-relays.ts`. */
export interface FarmInventoryReadDeps {
  /** Every kind:1416 by the owner naming the full `farm:main` address. No `since`. */
  readSpends(): Promise<InventoryReadResult>;
  /** Every kind:1417 by the owner scoped to the full `farm:main` address. */
  readFolds(): Promise<InventoryReadResult>;
  /** Specific kind:1417 events by id, tried on the configured relays plus each hint. */
  readFoldsById(references: EventReference[]): Promise<InventoryReadResult>;
}

export type FarmInventoryLoad =
  | FarmInventoryResolution
  /** The network could not be read well enough to derive anything. */
  | { status: 'error'; error: string };

/** Upper bound on by-id fetch rounds while walking an unusually deep chain. */
const MAX_FOLD_FETCH_ROUNDS = 8;

/**
 * Fetch what a snapshot needs and resolve its effective state.
 *
 * 1. read every candidate spend and, when the snapshot references a fold, every
 *    manifest for the inventory — one round trip normally covers the chain;
 * 2. resolve; on `missing-fold`, fetch the named ids from the configured relays
 *    and the relay hints the chain carries, and resolve again;
 * 3. stop when resolved, when nothing is missing, or when a round finds nothing
 *    new — an unresolved chain is reported, never guessed around.
 *
 * Spends are never filtered by timestamp. A spend older than the snapshot that
 * is not in its chain is pending, and the package applies it exactly once.
 */
export async function loadFarmInventoryState(
  deps: FarmInventoryReadDeps,
  snapshot: GameInventory
): Promise<FarmInventoryLoad> {
  const [spends, folds] = await Promise.all([
    deps.readSpends(),
    snapshot.fold ? deps.readFolds() : Promise.resolve<InventoryReadResult>({ events: [], answered: true }),
  ]);
  if (!spends.answered) return { status: 'error', error: 'No relay answered when reading spends against your inventory.' };
  if (!folds.answered) return { status: 'error', error: 'No relay answered when reading your inventory settlement records.' };

  let known = dedupeEventsById(folds.events);
  let resolution = resolveFarmInventory({ snapshot, folds: known, spends: spends.events });

  for (let round = 0; round < MAX_FOLD_FETCH_ROUNDS && resolution.status === 'unresolved'; round += 1) {
    const missing = missingFoldReferences(snapshot, resolution.chain);
    if (missing.length === 0) break;

    const fetched = await deps.readFoldsById(missing);
    const before = known.length;
    known = dedupeEventsById([...known, ...fetched.events]);
    if (known.length === before) break;

    resolution = resolveFarmInventory({ snapshot, folds: known, spends: spends.events });
  }

  return resolution;
}

/** A one-line, user-readable account of why a chain did not resolve. */
export function describeUnresolved(problems: readonly GameInventoryFoldProblem[]): string {
  if (problems.length === 0) return 'The inventory settlement chain could not be verified.';
  return problems.map((problem) => problem.message).join('; ');
}
