import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INVENTORY_KINDS } from '@/inventory/package';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { OWNER, STRANGER, eventId, foldEvent, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';

let network = new FakeRelayNetwork();

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: network.pool }),
}));

const { useFarmInventory } = await import('./useFarmInventory');

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const S1 = eventId('s1');
const M1 = eventId('m1');
const CARROT = PRODUCE_CATALOG.carrot;
const PUMPKIN = PRODUCE_CATALOG.pumpkin;

const queriedFilters = () => network.queries.map((q) => q.filters[0]);

beforeEach(() => {
  network = new FakeRelayNetwork();
});

describe('useFarmInventory', () => {
  it('shows the effective quantity before the Farm has folded anything', async () => {
    network.seed(snapshotEvent({ items: { [CARROT.address]: 3 } }));
    network.seed(spendEvent({ id: S1, item: CARROT.address, quantity: 1 }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.status).toBe('ready');
    expect(result.current.data?.produce).toEqual([{ definition: CARROT, quantity: 2 }]);
    expect(result.current.data?.pending).toEqual({ applied: 1, rejected: 0 });
    // The raw snapshot is still there, as the last consolidated statement.
    expect(result.current.data?.snapshot?.items[0].quantity).toBe(3);
  });

  it('queries spends by owner and full inventory address, never with a since', async () => {
    network.seed(snapshotEvent({ items: { [CARROT.address]: 3 } }));
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const spendQuery = queriedFilters().find((filter) => filter.kinds?.[0] === INVENTORY_KINDS.spend);
    expect(spendQuery).toEqual({ kinds: [INVENTORY_KINDS.spend], authors: [OWNER], '#a': [`31633:${OWNER}:farm:main`] });
    expect(spendQuery?.since).toBeUndefined();
  });

  it('does not subtract a spend the snapshot already folded', async () => {
    network.seed(foldEvent({ id: M1, spends: [S1] }));
    network.seed(spendEvent({ id: S1, item: CARROT.address, quantity: 1 }));
    network.seed(snapshotEvent({ items: { [CARROT.address]: 2 }, fold: { eventId: M1 } }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.produce).toEqual([{ definition: CARROT, quantity: 2 }]);
  });

  it('reports unresolved, with no produce, when the referenced manifest cannot be found', async () => {
    network.seed(snapshotEvent({ items: { [CARROT.address]: 3 }, fold: { eventId: M1, relay: 'wss://hint.example' } }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.status).toBe('unresolved');
    expect(result.current.data?.produce).toEqual([]);
    expect(result.current.data?.inventory).toBeNull();
    expect(result.current.data?.problems[0]).toMatch(/not among the supplied events/);
    // It did try the id on the relays before giving up.
    expect(queriedFilters().some((filter) => filter.ids?.includes(M1))).toBe(true);
  });

  it('is empty, and ready, when the player has no inventory', async () => {
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ status: 'ready', snapshot: null, inventory: null, produce: [] });
    expect(queriedFilters().some((filter) => filter.kinds?.[0] === INVENTORY_KINDS.spend)).toBe(false);
  });

  it('updates the rendered quantity when another game publishes a spend, without a refetch', async () => {
    network.seed(snapshotEvent({ items: { [PUMPKIN.address]: 4 } }));
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.data?.produce).toEqual([{ definition: PUMPKIN, quantity: 4 }]));
    const queries = network.queries.length;

    act(() => network.publish(spendEvent({ id: S1, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 })));

    await waitFor(() => expect(result.current.data?.produce).toEqual([{ definition: PUMPKIN, quantity: 2 }]));
    expect(network.queries.length).toBe(queries);
    expect(network.openSubscriptions).toBe(2);
  });

  it('keeps the balance continuous when the Farm folds the spend into a new snapshot', async () => {
    network.seed(snapshotEvent({ createdAt: 1_000, items: { [PUMPKIN.address]: 4 } }));
    network.seed(spendEvent({ id: S1, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 }));
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.data?.produce).toEqual([{ definition: PUMPKIN, quantity: 2 }]));

    act(() => {
      network.publish(foldEvent({ id: M1, spends: [S1], createdAt: 3_000 }));
      network.publish(snapshotEvent({ id: eventId('snap2'), createdAt: 3_001, items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));
    });

    await waitFor(() => expect(result.current.data?.pending).toEqual({ applied: 0, rejected: 0 }));
    expect(result.current.data?.produce).toEqual([{ definition: PUMPKIN, quantity: 2 }]);
  });

  it('opens the live subscriptions before the bootstrap read goes out, so a spend landing in that window is counted', async () => {
    network.seed(snapshotEvent({ items: { [PUMPKIN.address]: 4 } }));
    // The authoritative read cannot complete until we say so.
    network.holdQueries();
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });

    await waitFor(() => expect(network.queries.length).toBeGreaterThan(0));
    // Every REQ was open when the very first read was sent — not after.
    expect(network.queries[0].openSubscriptionsAtCall).toBe(2);
    expect(network.openSubscriptions).toBe(2);

    // Another game spends while the read is still out.
    act(() => network.publish(spendEvent({ id: S1, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 })));
    expect(result.current.data).toBeUndefined(); // nothing partial

    network.releaseQueries();
    await waitFor(() => expect(result.current.data?.produce).toEqual([{ definition: PUMPKIN, quantity: 2 }]));
    expect(result.current.data?.ledger.spends.has(S1)).toBe(true);

    // One authoritative read at mount, not one per party: the snapshot filter
    // went to each relay exactly once.
    expect(network.queries.filter((q) => q.filters[0].kinds?.[0] === INVENTORY_KINDS.inventory)).toHaveLength(2);
    for (const query of network.queries) expect(query.openSubscriptionsAtCall).toBe(2);
  });

  it('switching players cancels the previous player\'s pending missing-manifest retry', async () => {
    vi.useFakeTimers();
    try {
      network.seed(snapshotEvent({ items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1 } }));
      const { result, rerender } = renderHook(({ owner }: { owner: string }) => useFarmInventory(owner), {
        wrapper,
        initialProps: { owner: OWNER },
      });
      await vi.waitFor(() => expect(result.current.data?.status).toBe('unresolved'));
      const byId = () => network.queries.filter((q) => q.filters[0].ids?.includes(M1)).length;
      expect(byId()).toBeGreaterThan(0);

      act(() => rerender({ owner: STRANGER }));
      await vi.waitFor(() => expect(result.current.data?.status).toBe('ready'));
      const after = byId();
      await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
      expect(byId()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches players cleanly: the previous player\'s subscriptions are closed and their state does not carry over', async () => {
    network.seed(snapshotEvent({ items: { [PUMPKIN.address]: 4 } }));
    const { result, rerender } = renderHook(({ owner }: { owner: string }) => useFarmInventory(owner), {
      wrapper,
      initialProps: { owner: OWNER },
    });
    await waitFor(() => expect(result.current.data?.produce).toEqual([{ definition: PUMPKIN, quantity: 4 }]));

    rerender({ owner: STRANGER });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.produce).toEqual([]);
    expect(result.current.data?.snapshot).toBeNull();
    expect(network.openSubscriptions).toBe(2);
    for (const sub of network.subscriptions.slice(-2)) for (const f of sub.filters) expect(f.authors).toEqual([STRANGER]);

    // The old player's spend reaches nobody's view.
    act(() => network.publish(spendEvent({ id: S1, item: PUMPKIN.address, quantity: 2, createdAt: 2_000 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.data?.produce).toEqual([]);
  });
  it('keeps the resolution it derived the balance from on the view', async () => {
    network.seed(snapshotEvent({ items: { [CARROT.address]: 3 } }));
    network.seed(spendEvent({ id: S1, item: CARROT.address, quantity: 1 }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const resolution = result.current.data?.resolution;
    expect(resolution?.status).toBe('ready');
    if (resolution?.status !== 'ready') throw new Error('expected a ready resolution');
    // The same object the counts came from, not a second derivation.
    expect(resolution.inventory).toBe(result.current.data?.inventory);
    expect(resolution.state.applied.map((spend) => spend.id)).toEqual([S1]);
  });
});
