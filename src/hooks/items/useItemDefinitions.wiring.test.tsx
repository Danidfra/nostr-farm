import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';

/** What every relay will answer with on the next query. */
let relayEvents: NostrEvent[] = [];
let relayFails = false;

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async () => {
          if (relayFails) throw new Error('refused');
          return relayEvents;
        },
      }),
    },
  }),
}));

const { useItemDefinitions, collectDefinitions, reconcileDefinitions } = await import('./useItemDefinitions');

function definition(name: string, createdAt: number): NostrEvent {
  return {
    id: `${createdAt}`.padEnd(64, '0'),
    pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
    created_at: createdAt,
    kind: 31632,
    tags: [['d', 'farm:produce:carrot'], ['name', name], ['type', 'consumable']],
    content: '',
    sig: 'x'.repeat(128),
  };
}

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  relayEvents = [];
  relayFails = false;
});

describe('the read pipeline the query runs', () => {
  const original = definition('Carrot', 1_700_000_000);
  const updated = definition('Heirloom Carrot', 1_700_000_100);
  const cached = (event: NostrEvent) => collectDefinitions([{ relay: 'local', events: [event] }]);

  it('keeps a newer cached record when the relays still serve the old one', () => {
    // Exactly the post-publish race: the update is in the cache, the relays
    // have not indexed it yet. Replacing outright would undo the edit on screen.
    const rows = reconcileDefinitions(cached(updated), [{ relay: 'wss://a', events: [original] }]);

    expect(rows).toHaveLength(1);
    expect(rows[0].definition.name).toBe('Heirloom Carrot');
  });

  it('accepts the relay version once it is genuinely newer', () => {
    const rows = reconcileDefinitions(cached(original), [{ relay: 'wss://a', events: [updated] }]);
    expect(rows[0].definition.name).toBe('Heirloom Carrot');
  });

  it('never yields two rows for one address', () => {
    const rows = reconcileDefinitions(cached(original), [
      { relay: 'wss://a', events: [updated] },
      { relay: 'wss://b', events: [original] },
    ]);
    expect(rows).toHaveLength(1);
  });

  it('still fails when every relay failed, cache or not', () => {
    expect(() =>
      reconcileDefinitions(cached(original), [{ relay: 'wss://a', events: [], error: 'refused' }])
    ).toThrow();
  });
});

describe('useItemDefinitions wiring', () => {
  it('surfaces an error when every relay fails', async () => {
    const { wrapper } = harness();
    relayFails = true;

    const { result } = renderHook(() => useItemDefinitions('farm'), { wrapper });
    // The hook retries once before giving up, so allow for both attempts.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
  });

  it('reports a genuinely empty registry as an empty list', async () => {
    const { wrapper } = harness();
    relayEvents = [];

    const { result } = renderHook(() => useItemDefinitions('farm'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});
