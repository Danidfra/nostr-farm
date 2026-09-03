import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { INVENTORY_KINDS } from '@/inventory/package';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { OWNER, eventId, foldEvent, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';

const inventoryStore: NostrEvent[] = [];
const foldStore: NostrEvent[] = [];
const spendStore: NostrEvent[] = [];
const queried: { kinds?: number[]; ids?: string[]; '#a'?: string[]; authors?: string[]; since?: number }[] = [];

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async ([filter]: (typeof queried)[number][]) => {
          queried.push(filter);
          const kind = filter.kinds?.[0];
          const source =
            kind === INVENTORY_KINDS.spend ? spendStore : kind === INVENTORY_KINDS.fold ? foldStore : inventoryStore;
          return source.filter((event) => !filter.ids || filter.ids.includes(event.id));
        },
      }),
    },
  }),
}));

const { useFarmInventory } = await import('./useFarmInventory');

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const S1 = eventId('s1');
const M1 = eventId('m1');
const CARROT = PRODUCE_CATALOG.carrot;

beforeEach(() => {
  inventoryStore.length = 0;
  foldStore.length = 0;
  spendStore.length = 0;
  queried.length = 0;
});

describe('useFarmInventory', () => {
  it('shows the effective quantity before the Farm has folded anything', async () => {
    inventoryStore.push(snapshotEvent({ items: { [CARROT.address]: 3 } }));
    spendStore.push(spendEvent({ id: S1, item: CARROT.address, quantity: 1 }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.status).toBe('ready');
    expect(result.current.data?.produce).toEqual([{ definition: CARROT, quantity: 2 }]);
    expect(result.current.data?.pending).toEqual({ applied: 1, rejected: 0 });
    // The raw snapshot is still there, as the last consolidated statement.
    expect(result.current.data?.snapshot?.items[0].quantity).toBe(3);
  });

  it('queries spends by owner and full inventory address, never with a since', async () => {
    inventoryStore.push(snapshotEvent({ items: { [CARROT.address]: 3 } }));
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const spendQuery = queried.find((filter) => filter.kinds?.[0] === INVENTORY_KINDS.spend);
    expect(spendQuery).toEqual({ kinds: [INVENTORY_KINDS.spend], authors: [OWNER], '#a': [`31633:${OWNER}:farm:main`] });
    expect(spendQuery?.since).toBeUndefined();
  });

  it('does not subtract a spend the snapshot already folded', async () => {
    foldStore.push(foldEvent({ id: M1, spends: [S1] }));
    spendStore.push(spendEvent({ id: S1, item: CARROT.address, quantity: 1 }));
    inventoryStore.push(snapshotEvent({ items: { [CARROT.address]: 2 }, fold: { eventId: M1 } }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.produce).toEqual([{ definition: CARROT, quantity: 2 }]);
  });

  it('reports unresolved, with no produce, when the referenced manifest cannot be found', async () => {
    inventoryStore.push(snapshotEvent({ items: { [CARROT.address]: 3 }, fold: { eventId: M1, relay: 'wss://hint.example' } }));

    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.status).toBe('unresolved');
    expect(result.current.data?.produce).toEqual([]);
    expect(result.current.data?.inventory).toBeNull();
    expect(result.current.data?.problems[0]).toMatch(/not among the supplied events/);
    // It did try the id on the relays before giving up.
    expect(queried.some((filter) => filter.ids?.includes(M1))).toBe(true);
  });

  it('is empty, and ready, when the player has no inventory', async () => {
    const { result } = renderHook(() => useFarmInventory(OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ status: 'ready', snapshot: null, inventory: null, produce: [] });
    expect(queried.some((filter) => filter.kinds?.[0] === INVENTORY_KINDS.spend)).toBe(false);
  });
});
