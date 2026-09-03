import { useEffect } from 'react';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NPool, NostrEvent } from '@nostrify/nostrify';

import { produceQuantity, selectNewestInventory } from '@/inventory/farm-inventory';
import {
  loadFarmInventoryState,
  missingFoldReferences,
  resolveFarmInventory,
  type FarmInventoryResolution,
} from '@/inventory/effective-inventory';
import {
  admitLedgerEvents,
  emptyLedger,
  ledgerFromEvents,
  mergeLedgers,
  sameLedgerContents,
  type FarmLedger,
} from '@/inventory/ledger';
import { PRODUCE_CATALOG, PRODUCE_CROP_IDS, type ProduceDefinition } from '@/inventory/produce-catalog';
import type { GameInventory } from '@/inventory/package';
import type { EventReference } from '@/inventory/relay-io';
import { farmInventoryReadDeps } from './inventory-relays';
import { awaitLiveTails, startFarmInventoryLive } from './inventory-live';

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
  /** The canonical raw kind:31633, or `null` when none is known. */
  snapshot: GameInventory | null;
  /** The EFFECTIVE inventory — snapshot minus applied pending spends — or `null`. */
  inventory: GameInventory | null;
  /** Official produce held, in catalog order. Zero quantities are omitted. */
  produce: { definition: ProduceDefinition; quantity: number }[];
  /** Spends other games published that are not yet settled by a snapshot. */
  pending: { applied: number; rejected: number };
  /** Why the chain did not resolve, when `status` is `unresolved`. */
  problems: string[];
  /**
   * Manifests the chain needs and the ledger does not hold, when `unresolved`.
   * Retrievable by id; the live read side fetches them. Empty when the chain
   * is broken for a reason fetching cannot fix.
   */
  missingFolds: EventReference[];
  /** Everything this view was derived from. Merged monotonically, never replaced. */
  ledger: FarmLedger;
}

/**
 * The query holding the player's `farm:main` ledger and the view derived from
 * it. Shared by the hook, the live tail and the harvest write-back so that all
 * three commit through the same merge.
 *
 * `queryFn` does not touch a relay until the live controller for this player
 * has its subscriptions open (`awaitLiveTails`). `useQuery` starts its mount
 * fetch before the effect that starts the controller runs; without the gate,
 * an event landing between the read and the `REQ` would be in neither.
 *
 * `structuralSharing` is where a fetched result meets the cache. TanStack calls
 * it at COMMIT time with the data the cache holds right then, so a spend that
 * arrived live while the fetch was in flight is merged into the fetched result
 * rather than overwritten by it. Reconciling inside `queryFn` would not do:
 * that runs before the commit, and the race is precisely between the two.
 */
export function farmInventoryQueryOptions(nostr: NPool, queryClient: QueryClient, ownerPubkey: string | undefined) {
  return queryOptions<FarmInventoryView>({
    queryKey: farmInventoryQueryKey(ownerPubkey),
    staleTime: 15_000,
    structuralSharing: (previous, next) =>
      mergeFarmInventoryViews(previous as FarmInventoryView | undefined, next as FarmInventoryView),
    queryFn: async ({ signal }) => {
      if (!ownerPubkey) return emptyView(emptyLedger(''));
      await awaitLiveTails(queryClient, ownerPubkey, signal);
      return fetchFarmInventoryView(nostr, ownerPubkey, signal);
    },
  });
}

/**
 * The authoritative read: snapshot, spends, manifests (and any missing manifest
 * by id), resolved into a view of a ledger built ONLY from what the relays
 * returned. Merging with what the cache already knows is the commit's job.
 */
async function fetchFarmInventoryView(nostr: NPool, ownerPubkey: string, signal: AbortSignal): Promise<FarmInventoryView> {
  const deps = farmInventoryReadDeps(nostr, ownerPubkey, signal);
  const read = await deps.readInventory();
  if (!read.answered) throw new Error('Could not reach any relay to read your produce.');

  const snapshot = selectNewestInventory(read.events, ownerPubkey);
  if (!snapshot) return emptyView(ledgerFromEvents(ownerPubkey, read.events));

  const loaded = await loadFarmInventoryState(deps, snapshot);
  if (loaded.status === 'error') throw new Error(loaded.error);

  return deriveFarmInventoryView(ledgerFromEvents(ownerPubkey, [...read.events, ...loaded.folds, ...loaded.spends]));
}

/**
 * Read the player's own `farm:main` inventory and derive what they hold, and
 * keep it current while mounted.
 *
 * Effective, not raw: a kind:1416 another game published against this
 * inventory is subtracted here, before the Farm has written any snapshot, so
 * the counter never over-reports something already consumed elsewhere. Spends
 * a snapshot already folded are not subtracted again.
 *
 * Live: while the hook is mounted, one subscription per inventory relay tails
 * the ledger (see `inventory-live.ts`), so a spend another game publishes
 * lowers the counter without a refresh, and a snapshot the Farm publishes
 * elsewhere replaces it. The query's own mount fetch waits for those
 * subscriptions to be open, and the controller's bootstrap fetch joins it
 * rather than starting a second one.
 *
 * READ ONLY — it never publishes and never creates an inventory. A resolved
 * `null` here is display state; it is emphatically NOT the base a write may
 * build a replacement from. `creditHarvest` does its own confirmed read and
 * its own derivation inside the write lock for exactly that reason.
 */
export function useFarmInventory(ownerPubkey: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const query = useQuery({ ...farmInventoryQueryOptions(nostr, queryClient, ownerPubkey), enabled: !!ownerPubkey });

  useEffect(() => {
    if (!ownerPubkey) return;
    const live = startFarmInventoryLive({ nostr, queryClient, ownerPubkey });
    return () => live.stop();
  }, [nostr, queryClient, ownerPubkey]);

  return query;
}

export function emptyView(ledger: FarmLedger): FarmInventoryView {
  return {
    status: 'ready',
    snapshot: null,
    inventory: null,
    produce: [],
    pending: { applied: 0, rejected: 0 },
    problems: [],
    missingFolds: [],
    ledger,
  };
}

/** The view of a ledger: nothing without a snapshot, else the package's derivation. */
export function deriveFarmInventoryView(ledger: FarmLedger): FarmInventoryView {
  if (!ledger.snapshot) return emptyView(ledger);
  return toView(
    resolveFarmInventory({ snapshot: ledger.snapshot, folds: [...ledger.folds.values()], spends: [...ledger.spends.values()] }),
    ledger
  );
}

export function toView(resolution: FarmInventoryResolution, ledger: FarmLedger): FarmInventoryView {
  if (resolution.status === 'unresolved') {
    return {
      status: 'unresolved',
      snapshot: resolution.snapshot,
      inventory: null,
      produce: [],
      pending: { applied: 0, rejected: 0 },
      problems: resolution.problems.map((problem) => problem.message),
      missingFolds: missingFoldReferences(resolution.snapshot, resolution.chain),
      ledger,
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
    missingFolds: [],
    ledger,
  };
}

/**
 * Commit-time reconciliation: the view the cache will hold after `next` lands
 * on top of `previous`.
 *
 * Monotonic in the ledger. Whatever `next` came from — the authoritative
 * fetch, a live event, the harvest write-back — nothing `previous` knew is
 * dropped: spends and manifests are unioned by id, and the snapshot only ever
 * moves forward. Returns `previous` itself when `next` taught it nothing, so
 * React does not re-render for a refetch that found the same events.
 */
export function mergeFarmInventoryViews(previous: FarmInventoryView | undefined, next: FarmInventoryView): FarmInventoryView {
  if (!previous || previous.ledger.owner !== next.ledger.owner) return next;

  const merged = mergeLedgers(previous.ledger, next.ledger);
  if (!merged.changed) return previous;
  if (sameLedgerContents(merged.ledger, next.ledger)) return next;
  return deriveFarmInventoryView(merged.ledger);
}

/**
 * Admit events into the cached ledger and re-derive. The updater form merges
 * against the cache's current value, so it composes with the fetch commit in
 * either order. Does nothing when no view is established yet: the events are
 * the live tail's to hold until the authoritative fetch has landed.
 *
 * Returns true when the cache changed.
 */
export function admitFarmInventoryEvents(queryClient: QueryClient, ownerPubkey: string, events: readonly NostrEvent[]): boolean {
  let changed = false;
  queryClient.setQueryData<FarmInventoryView>(farmInventoryQueryKey(ownerPubkey), (previous) => {
    if (!previous) return undefined;
    const admitted = admitLedgerEvents(previous.ledger, events);
    if (!admitted.changed) return previous;
    changed = true;
    return deriveFarmInventoryView(admitted.ledger);
  });
  return changed;
}

/**
 * Show a freshly published inventory immediately, without waiting for relays to
 * serve it back.
 *
 * The snapshot, the manifests and the spends the write saw — including the
 * manifest it just published — are admitted into the ledger, so a spend that
 * snapshot folded is settled by the chain and NOT subtracted a second time.
 * Merging, not replacing: a spend the live tail learned meanwhile survives,
 * and a newer snapshot already known is never moved backwards.
 */
export function setFarmInventory(
  queryClient: QueryClient,
  ownerPubkey: string,
  written: { event: NostrEvent; folds: readonly NostrEvent[]; spends: readonly NostrEvent[] }
): void {
  const events = [...written.folds, ...written.spends, written.event];
  queryClient.setQueryData<FarmInventoryView>(farmInventoryQueryKey(ownerPubkey), (previous) => {
    const base = previous?.ledger ?? emptyLedger(ownerPubkey);
    const admitted = admitLedgerEvents(base, events);
    if (previous && !admitted.changed) return previous;
    return deriveFarmInventoryView(admitted.ledger);
  });
}
