import { QueryClient, onlineManager } from '@tanstack/react-query';
import type { NPool } from '@nostrify/nostrify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INVENTORY_KINDS } from '@/inventory/package';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { OWNER, OTHER_GAME_ADDRESS, STRANGER, eventId, foldEvent, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';

import { MAX_MISSING_FOLD_ATTEMPTS, retryDelayMs, startFarmInventoryLive, type FarmInventoryLive } from './inventory-live';
import { farmInventoryQueryKey, type FarmInventoryView } from './useFarmInventory';

const RELAYS = ['wss://one.example', 'wss://two.example'] as const;
const PUMPKIN = PRODUCE_CATALOG.pumpkin;
const CARROT = PRODUCE_CATALOG.carrot;
const A = eventId('spend-a');
const M1 = eventId('m1');

let network: FakeRelayNetwork;
let client: QueryClient;
let live: FarmInventoryLive | undefined;

function start(owner = OWNER): FarmInventoryLive {
  live = startFarmInventoryLive({ nostr: network.pool as unknown as NPool, queryClient: client, ownerPubkey: owner, relays: RELAYS });
  return live;
}

function view(owner = OWNER): FarmInventoryView | undefined {
  return client.getQueryData<FarmInventoryView>(farmInventoryQueryKey(owner));
}

function pumpkins(owner = OWNER): number | undefined {
  return view(owner)?.produce.find((entry) => entry.definition === PUMPKIN)?.quantity ?? (view(owner) ? 0 : undefined);
}

/** Every distinct view the cache went through, in order. */
function recordViews(): FarmInventoryView[] {
  const seen: FarmInventoryView[] = [];
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const data = event.query.state.data as FarmInventoryView | undefined;
    if (data && seen.at(-1) !== data) seen.push(data);
  });
  return seen;
}

const S1 = () => snapshotEvent({ id: eventId('snap1'), createdAt: 1_000, revision: 30, items: { [PUMPKIN.address]: 4 } });

beforeEach(() => {
  network = new FakeRelayNetwork();
  // `gcTime: Infinity` as in the app: the ledger is never dropped behind the tail's back.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  onlineManager.setOnline(true);
});

afterEach(() => {
  live?.stop();
  live = undefined;
  vi.useRealTimers();
});

describe('farm inventory live tail', () => {
  it('A: an external spend lowers the effective quantity without any refetch', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));
    const queriesBefore = network.queries.length;

    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));

    await vi.waitFor(() => expect(pumpkins()).toBe(2));
    expect(view()?.pending).toEqual({ applied: 1, rejected: 0 });
    // The raw snapshot is unchanged; only the derivation moved.
    expect(view()?.snapshot?.items[0].quantity).toBe(4);
    expect(network.queries.length).toBe(queriesBefore);
  });

  it('B: settling a pending spend into a new snapshot keeps the balance continuous (fold, then snapshot)', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));
    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    await vi.waitFor(() => expect(pumpkins()).toBe(2));

    const views = recordViews();
    // The Farm's write order: manifest first, then the snapshot referencing it.
    network.publish(foldEvent({ id: M1, spends: [A], createdAt: 3_000 }));
    network.publish(snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, revision: 31, items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));

    await vi.waitFor(() => expect(view()?.snapshot?.revision).toBe(31));
    expect(pumpkins()).toBe(2);
    expect(view()?.pending).toEqual({ applied: 0, rejected: 0 });
    // At no point was the spend subtracted from a snapshot that had already folded it.
    for (const v of views) expect(v.produce.find((e) => e.definition === PUMPKIN)?.quantity ?? 0).not.toBe(0);
  });

  it('B: snapshot arriving before its manifest is unavailable, never a guess, then resolves', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));
    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    await vi.waitFor(() => expect(pumpkins()).toBe(2));

    network.publish(snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, revision: 31, items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));
    await vi.waitFor(() => expect(view()?.status).toBe('unresolved'));
    expect(view()?.produce).toEqual([]);
    expect(view()?.inventory).toBeNull();

    network.publish(foldEvent({ id: M1, spends: [A], createdAt: 3_000 }));
    await vi.waitFor(() => expect(view()?.status).toBe('ready'));
    expect(pumpkins()).toBe(2);
  });

  it('C: a live newer snapshot replaces the current one, and an older one does not', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(view()?.snapshot?.revision).toBe(30));

    network.publish(snapshotEvent({ id: eventId('snap2'), createdAt: 2_000, revision: 31, items: { [PUMPKIN.address]: 5 } }));
    await vi.waitFor(() => expect(view()?.snapshot?.revision).toBe(31));
    expect(pumpkins()).toBe(5);

    network.publish(snapshotEvent({ id: eventId('snap0'), createdAt: 500, revision: 29, items: { [PUMPKIN.address]: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view()?.snapshot?.revision).toBe(31);
    expect(pumpkins()).toBe(5);
  });

  it('D: a stale refetch committed after a live event does not erase the event', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));

    // A refetch starts (relay one reconnects and replays) and captures the
    // store as it is now — without the spend — but is slow to come back.
    network.holdQueries();
    network.reconnect(RELAYS[0]);
    await vi.waitFor(() => expect(network.queries.length).toBeGreaterThan(3));

    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    await vi.waitFor(() => expect(pumpkins()).toBe(2));

    network.releaseQueries();
    await vi.waitFor(() => expect(client.getQueryState(farmInventoryQueryKey(OWNER))?.fetchStatus).toBe('idle'));
    expect(pumpkins()).toBe(2);
    expect(view()?.ledger.spends.has(A)).toBe(true);
  });

  it('D: a stale refetch does not move a live newer snapshot or a known fold backwards', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(view()?.snapshot?.revision).toBe(30));

    network.holdQueries();
    network.reconnect(RELAYS[1]);
    await vi.waitFor(() => expect(network.queries.length).toBeGreaterThan(3));

    network.publish(foldEvent({ id: M1, spends: [A], createdAt: 3_000 }));
    network.publish(snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, revision: 31, items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));
    await vi.waitFor(() => expect(view()?.snapshot?.revision).toBe(31));

    network.releaseQueries();
    await vi.waitFor(() => expect(client.getQueryState(farmInventoryQueryKey(OWNER))?.fetchStatus).toBe('idle'));
    expect(view()?.snapshot?.revision).toBe(31);
    expect(view()?.status).toBe('ready');
    expect(view()?.ledger.folds.has(M1)).toBe(true);
    expect(pumpkins()).toBe(2);
  });

  it('E: an event arriving between the authoritative fetch and its commit is not lost, and nothing partial is shown', async () => {
    network.seed(S1());
    network.holdQueries();
    start();
    await vi.waitFor(() => expect(network.openSubscriptions).toBe(RELAYS.length));

    // The relay has replayed the snapshot into the subscription already, and
    // now a spend lands while the fetch is still out.
    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view()).toBeUndefined();

    network.releaseQueries();
    await vi.waitFor(() => expect(pumpkins()).toBe(2));
  });

  it('F: a spend missed while a relay had closed the subscription is recovered after the restart backoff', async () => {
    vi.useFakeTimers();
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));

    network.closeAll();
    await vi.waitFor(() => expect(network.openSubscriptions).toBe(0));
    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    expect(pumpkins()).toBe(4);

    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    await vi.waitFor(() => expect(pumpkins()).toBe(2));
    expect(network.openSubscriptions).toBe(RELAYS.length);
  });

  it('F: a relay reconnect replay triggers an authoritative refetch', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));
    const before = network.queries.length;

    // Seeded silently: only a refetch can find it.
    network.seed(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    network.reconnect(RELAYS[0]);

    await vi.waitFor(() => expect(pumpkins()).toBe(2));
    expect(network.queries.length).toBeGreaterThan(before);
  });

  it('F: coming back online refetches', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));

    onlineManager.setOnline(false);
    network.seed(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    onlineManager.setOnline(true);

    await vi.waitFor(() => expect(pumpkins()).toBe(2));
  });

  it('G: malformed, wrong-author and wrong-inventory ledger events change nothing', async () => {
    network.seed(S1());
    start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));
    const before = view();

    network.publish(spendEvent({ id: eventId('foreign'), pubkey: STRANGER, item: PUMPKIN.address, quantity: 2 }));
    network.publish(spendEvent({ id: eventId('other'), inventory: OTHER_GAME_ADDRESS, item: PUMPKIN.address, quantity: 2 }));
    network.publish(spendEvent({ id: eventId('bad'), item: PUMPKIN.address, quantity: 0 }));
    network.publish(foldEvent({ id: eventId('mforeign'), pubkey: STRANGER, spends: [A] }));
    network.publish(snapshotEvent({ id: eventId('sforeign'), pubkey: STRANGER, createdAt: 9_000, items: { [PUMPKIN.address]: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(view()).toBe(before);
    expect(pumpkins()).toBe(4);
    expect(view()?.ledger.spends.size).toBe(0);
  });

  it('H: a missing manifest is retried with backoff, never shown raw, and the timer is cleaned up on stop', async () => {
    vi.useFakeTimers();
    network.seed(snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, revision: 31, items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));
    start();
    await vi.waitFor(() => expect(view()?.status).toBe('unresolved'));
    expect(view()?.produce).toEqual([]);
    expect(view()?.missingFolds.map((r) => r.eventId)).toEqual([M1]);

    const byId = () => network.queries.filter((q) => q.filters[0].ids?.includes(M1)).length;
    const attemptsSoFar = byId();
    expect(attemptsSoFar).toBeGreaterThan(0);

    // The manifest becomes retrievable only after the first retry has failed.
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    await vi.waitFor(() => expect(byId()).toBeGreaterThan(attemptsSoFar));
    expect(view()?.status).toBe('unresolved');

    network.seed(foldEvent({ id: M1, spends: [A], createdAt: 3_000 }));
    await vi.advanceTimersByTimeAsync(retryDelayMs(2));
    await vi.waitFor(() => expect(view()?.status).toBe('ready'));
    expect(pumpkins()).toBe(2);

    // Stopping cancels any pending retry: no query is issued afterwards.
    live!.stop();
    const after = network.queries.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(network.queries.length).toBe(after);
  });

  it('H: a chain missing several manifests is walked link by link, each fetched by id', async () => {
    const M0 = eventId('m0');
    const B = eventId('spend-b');
    start();
    await vi.waitFor(() => expect(view()?.status).toBe('ready'));

    // Stored after the tail's replay and never streamed: findable only by id.
    network.seed(foldEvent({ id: M0, spends: [B], createdAt: 2_000 }));
    network.seed(foldEvent({ id: M1, spends: [A], previous: { eventId: M0 }, createdAt: 3_000 }));
    network.seed(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_500 }));
    network.seed(spendEvent({ id: B, item: PUMPKIN.address, quantity: 1, createdAt: 1_500 }));

    // Only the snapshot arrives live, so the live side must fetch M1, then M0.
    const snap2 = snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, revision: 31, items: { [PUMPKIN.address]: 1 }, fold: { eventId: M1 } });
    network.store.push(snap2);
    for (const sub of network.subscriptions) if (sub.filters[0].kinds?.[0] === INVENTORY_KINDS.inventory) sub.push(['EVENT', 'sub', snap2]);

    await vi.waitFor(() => expect(view()?.snapshot?.revision).toBe(31));
    await vi.waitFor(() => expect(view()?.status).toBe('ready'));
    expect(view()?.ledger.folds.has(M0)).toBe(true);
    expect(view()?.ledger.folds.has(M1)).toBe(true);
    const byId = (id: string) => network.queries.filter((q) => q.filters[0].ids?.includes(id)).length;
    expect(byId(M1)).toBeGreaterThan(0);
    expect(byId(M0)).toBeGreaterThan(0);
    expect(pumpkins()).toBe(1);
  });

  it('H: retries are bounded, and a manifest that cannot be fixed by fetching is not retried at all', async () => {
    vi.useFakeTimers();
    network.seed(snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, revision: 31, items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));
    start();
    await vi.waitFor(() => expect(view()?.status).toBe('unresolved'));
    const byId = () => network.queries.filter((q) => q.filters[0].ids?.includes(M1)).length;

    for (let i = 0; i < MAX_MISSING_FOLD_ATTEMPTS + 3; i += 1) await vi.advanceTimersByTimeAsync(60_000);
    const settled = byId();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(byId()).toBe(settled);
    expect(view()?.status).toBe('unresolved');
    expect(view()?.produce).toEqual([]);

    // A stranger's manifest under that id never enters the ledger, so the
    // chain is still missing its head — and the budget for it is spent.
    network.publish(foldEvent({ id: M1, pubkey: STRANGER, spends: [A] }));
    await vi.advanceTimersByTimeAsync(10);
    expect(view()?.status).toBe('unresolved');
    expect(view()?.ledger.folds.size).toBe(0);
    expect(byId()).toBe(settled);

    // A chain that is present but cyclic is unresolved for a reason no fetch
    // can fix: nothing is reported missing and nothing is fetched.
    const M2 = eventId('m2');
    network.publish(foldEvent({ id: M2, spends: [A], previous: { eventId: M1 } }));
    network.publish(foldEvent({ id: M1, spends: [A], previous: { eventId: M2 } }));
    await vi.advanceTimersByTimeAsync(10);
    expect(view()?.status).toBe('unresolved');
    expect(view()?.problems.join(' ')).toMatch(/revisits/i);
    expect(view()?.missingFolds).toEqual([]);
    const afterCycle = network.queries.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(network.queries.length).toBe(afterCycle);
  });

  it('I: stopping one player\'s tail before starting the next leaks nothing across', async () => {
    network.seed(S1());
    const first = start();
    await vi.waitFor(() => expect(pumpkins()).toBe(4));
    first.stop();
    await vi.waitFor(() => expect(network.openSubscriptions).toBe(0));

    network.seed(snapshotEvent({ id: eventId('stranger'), pubkey: STRANGER, createdAt: 1_000, items: { [CARROT.address]: 7 } }));
    start(STRANGER);
    await vi.waitFor(() => expect(view(STRANGER)?.status).toBe('ready'));
    expect(view(STRANGER)?.produce).toEqual([{ definition: CARROT, quantity: 7 }]);

    // The new subscriptions are the stranger's, and only theirs.
    const open = network.subscriptions.slice(-RELAYS.length);
    for (const sub of open) for (const filter of sub.filters) expect(filter.authors).toEqual([STRANGER]);
    expect(network.openSubscriptions).toBe(RELAYS.length);

    // An event for the old player changes neither cache.
    const before = view(STRANGER);
    network.publish(spendEvent({ id: A, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view(STRANGER)).toBe(before);
    expect(pumpkins()).toBe(4);
  });

  it('J: one subscription per relay with three exact filters, regardless of how many produce items exist', async () => {
    network.seed(
      snapshotEvent({
        id: eventId('many'),
        items: { [PUMPKIN.address]: 1, [CARROT.address]: 2, [PRODUCE_CATALOG.parsnip.address]: 3, [PRODUCE_CATALOG.strawberry.address]: 4 },
      })
    );
    start();
    await vi.waitFor(() => expect(view()?.produce).toHaveLength(4));
    for (let i = 0; i < 6; i += 1) network.publish(spendEvent({ id: eventId(`s${i}`), item: CARROT.address, quantity: 1, createdAt: 2_000 + i }));
    await vi.waitFor(() => expect(view()?.ledger.spends.size).toBe(6));

    expect(network.openSubscriptions).toBe(RELAYS.length);
    expect(network.subscriptions).toHaveLength(RELAYS.length);
    for (const sub of network.subscriptions) {
      expect(sub.filters.map((f) => f.kinds)).toEqual([[INVENTORY_KINDS.inventory], [INVENTORY_KINDS.spend], [INVENTORY_KINDS.fold]]);
      for (const filter of sub.filters) {
        expect(filter.authors).toEqual([OWNER]);
        expect(filter.since).toBeUndefined();
        expect(filter.ids).toBeUndefined();
        if (filter['#a']) expect(filter['#a']).toEqual([`31633:${OWNER}:farm:main`]);
        else expect(filter['#d']).toEqual(['farm:main']);
      }
    }
  });
});
