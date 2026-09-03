import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';

import { selectNewestInventory, produceQuantity } from '@/inventory/farm-inventory';
import {
  loadFarmInventoryState,
  resolveFarmInventory,
  type FarmInventoryResolution,
} from '@/inventory/effective-inventory';
import { PRODUCE_CATALOG, PRODUCE_CROP_IDS, type ProduceDefinition } from '@/inventory/produce-catalog';
import type { GameInventory } from '@/inventory/package';
import { farmInventoryReadDeps } from './inventory-relays';

export const FARM_INVENTORY_KEY = 'farm-inventory';

export function farmInventoryQueryKey(ownerPubkey: string | undefined) {
  return [FARM_INVENTORY_KEY, ownerPubkey ?? null] as const;
}

export type FarmInventoryStatus = 'ready' | 'unresolved';

export interface FarmInventoryView {
  /**
   * `ready`: `produce` is the effective balance. `unresolved`: the snapshot's
   * settlement chain could not be verified, so there IS no balance to show;
   * `produce` is empty and `inventory` is `null` rather than a guess.
   */
  status: FarmInventoryStatus;
  /** The raw kind:31633 the relays returned, or `null` when the reads found none. */
  snapshot: GameInventory | null;
  /** The EFFECTIVE inventory — snapshot minus applied pending spends — or `null`. */
  inventory: GameInventory | null;
  /** Official produce held, in catalog order. Zero quantities are omitted. */
  produce: { definition: ProduceDefinition; quantity: number }[];
  /** Spends other games published that are not yet settled by a snapshot. */
  pending: { applied: number; rejected: number };
  /** Why the chain did not resolve, when `status` is `unresolved`. */
  problems: string[];
}

/**
 * Read the player's own `farm:main` inventory and derive what they hold.
 *
 * Effective, not raw: a kind:1416 another game published against this
 * inventory is subtracted here, before the Farm has written any snapshot, so
 * the counter never over-reports something already consumed elsewhere. Spends
 * a snapshot already folded are not subtracted again.
 *
 * READ ONLY — it never publishes and never creates an inventory. A resolved
 * `null` here is display state; it is emphatically NOT the base a write may
 * build a replacement from. `creditHarvest` does its own confirmed read and
 * its own derivation inside the write lock for exactly that reason.
 */
export function useFarmInventory(ownerPubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<FarmInventoryView>({
    queryKey: farmInventoryQueryKey(ownerPubkey),
    enabled: !!ownerPubkey,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      if (!ownerPubkey) return emptyView();

      const deps = farmInventoryReadDeps(nostr, ownerPubkey, signal);
      const read = await deps.readInventory();
      if (!read.answered) throw new Error('Could not reach any relay to read your produce.');

      const snapshot = selectNewestInventory(read.events, ownerPubkey);
      if (!snapshot) return emptyView();

      const loaded = await loadFarmInventoryState(deps, snapshot);
      if (loaded.status === 'error') throw new Error(loaded.error);
      return toView(loaded);
    },
  });
}

export function emptyView(): FarmInventoryView {
  return { status: 'ready', snapshot: null, inventory: null, produce: [], pending: { applied: 0, rejected: 0 }, problems: [] };
}

export function toView(resolution: FarmInventoryResolution): FarmInventoryView {
  if (resolution.status === 'unresolved') {
    return {
      status: 'unresolved',
      snapshot: resolution.snapshot,
      inventory: null,
      produce: [],
      pending: { applied: 0, rejected: 0 },
      problems: resolution.problems.map((problem) => problem.message),
    };
  }

  const { inventory, state } = resolution;
  const produce = PRODUCE_CROP_IDS.map((cropId) => PRODUCE_CATALOG[cropId])
    .map((definition) => ({ definition, quantity: produceQuantity(inventory, definition.address) }))
    .filter((entry) => entry.quantity > 0);

  return {
    status: 'ready',
    snapshot: resolution.snapshot,
    inventory,
    produce,
    pending: { applied: state.applied.length, rejected: state.rejected.length },
    problems: [],
  };
}

/**
 * Show a freshly published inventory immediately, without waiting for relays to
 * serve it back.
 *
 * The view is re-derived from the new snapshot together with the manifests and
 * spends the write saw — including the manifest it just published — so a spend
 * that snapshot folded is settled by the chain and NOT subtracted a second
 * time. Never moves the view backwards in time.
 */
export function setFarmInventory(
  queryClient: QueryClient,
  ownerPubkey: string,
  written: { event: NostrEvent; folds: readonly NostrEvent[]; spends: readonly NostrEvent[] }
): void {
  const snapshot = selectNewestInventory([written.event], ownerPubkey);
  if (!snapshot) return;
  const next = toView(resolveFarmInventory({ snapshot, folds: written.folds, spends: written.spends }));

  queryClient.setQueryData<FarmInventoryView>(farmInventoryQueryKey(ownerPubkey), (previous) => {
    if (previous?.snapshot && previous.snapshot.event.created_at > snapshot.event.created_at) return previous;
    return next;
  });
}
