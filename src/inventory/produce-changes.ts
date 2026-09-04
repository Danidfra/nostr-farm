import type { NostrEvent } from '@nostrify/nostrify';

import type { GameInventory } from './package';
import type { FarmInventoryResolution } from './effective-inventory';
import { harvestedEventIds, produceQuantity } from './farm-inventory';
import { PRODUCE_CATALOG, PRODUCE_CROP_IDS, type ProduceDefinition } from './produce-catalog';

/**
 * Why a produce count changed between two renders of the read model.
 *
 * Presentation over the resolved view, not accounting: every number here is
 * read off the effective inventory the package derived, and the cause is
 * inferred from what the ledger learned in between. Nothing is stored and
 * nothing is re-derived.
 */

export type ProduceChangeCause =
  /** The Farm credited a harvest: the snapshot moved and carries a new harvest marker. */
  | 'harvest'
  /** Another game published a kind:1416 against `farm:main` that the resolver applied. */
  | 'external-spend'
  /** The balance moved for a reason the ledger diff cannot name (e.g. a foreign snapshot). */
  | 'other';

export interface ProduceChange {
  definition: ProduceDefinition;
  from: number;
  to: number;
  cause: ProduceChangeCause;
  /**
   * The `client` tag of the spend that caused an `external-spend` change, if
   * it carried one. Self-declared by whoever published the spend; shown as
   * text, never trusted for anything else.
   */
  client?: string;
}

/** The slice of the read model the diff needs. `FarmInventoryView` satisfies it. */
export interface ProduceLedgerView {
  status: 'ready' | 'unresolved';
  snapshot: GameInventory | null;
  inventory: GameInventory | null;
  ledger: { owner: string; spends: ReadonlyMap<string, NostrEvent> };
  resolution: FarmInventoryResolution | null;
}

/**
 * The produce counts that differ between `previous` and `next`, each with
 * its most likely cause.
 *
 * Rules, in order:
 *
 * - No previous view, or either side unresolved, or a different owner: no
 *   changes. An unresolved view has no balance, so there is nothing honest
 *   to compare against.
 * - Equal effective quantities: no change, whatever happened underneath. A
 *   fold that re-bases the snapshot without moving the effective balance is
 *   invisible here by construction.
 * - An increase is a `harvest` when the snapshot gained a harvest marker.
 * - A decrease is an `external-spend` when a spend the ledger had not seen
 *   before was applied against that item by the resolver.
 * - Anything else is `other`.
 */
export function diffProduceViews(previous: ProduceLedgerView | undefined, next: ProduceLedgerView): ProduceChange[] {
  if (!previous) return [];
  if (previous.status !== 'ready' || next.status !== 'ready') return [];
  if (previous.ledger.owner !== next.ledger.owner) return [];

  const previousMarkers = new Set(harvestedEventIds(previous.snapshot));
  const newHarvestMarkers = harvestedEventIds(next.snapshot).filter((id) => !previousMarkers.has(id));

  const newSpendIds = new Set<string>();
  for (const id of next.ledger.spends.keys()) {
    if (!previous.ledger.spends.has(id)) newSpendIds.add(id);
  }
  const applied = next.resolution?.status === 'ready' ? next.resolution.state.applied : [];

  const changes: ProduceChange[] = [];
  for (const cropId of PRODUCE_CROP_IDS) {
    const definition = PRODUCE_CATALOG[cropId];
    const from = produceQuantity(previous.inventory, definition.address);
    const to = produceQuantity(next.inventory, definition.address);
    if (from === to) continue;

    if (to > from) {
      changes.push({ definition, from, to, cause: newHarvestMarkers.length > 0 ? 'harvest' : 'other' });
      continue;
    }

    const spends = applied.filter((spend) => newSpendIds.has(spend.id) && spend.itemAddress === definition.address);
    if (spends.length === 0) {
      changes.push({ definition, from, to, cause: 'other' });
      continue;
    }
    const client = spends.map((spend) => describeSpendClient(spend.client)).find((name) => name !== undefined);
    changes.push({ definition, from, to, cause: 'external-spend', ...(client ? { client } : {}) });
  }
  return changes;
}

/** A spend's self-declared client name, made safe to print inline, or `undefined`. */
export function describeSpendClient(client: string | undefined): string | undefined {
  if (typeof client !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = client.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (clean.length === 0) return undefined;
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}
