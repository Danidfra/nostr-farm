import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { forgetSessionStamps, MAX_FUTURE_SKEW_SEC } from '@/nostr/created-at';

/** The publish chokepoint's `created_at`, with a disposable key and no relay. */
const OWNER = 'c'.repeat(64);
const NOW = 1_800_000_000;
const signed: NostrEvent[] = [];

vi.mock('@nostrify/react', () => ({ useNostr: () => ({ nostr: {} }) }));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: OWNER,
      signer: {
        signEvent: async (t: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>) => {
          const event = { ...t, id: String(signed.length).padStart(64, '0'), pubkey: OWNER, sig: 'x'.repeat(128) };
          signed.push(event);
          return event;
        },
      },
    },
  }),
}));

vi.mock('@/nostr/publish', () => ({
  publishToRelays: async () => ({ accepted: [], rejected: [] }),
}));

const { useNostrPublish } = await import('./useNostrPublish');

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const plot = (x = 1) => ({ kind: 31417, content: '', tags: [['d', `slot:farm.field:${x}:1`], ['v', '2']] });

beforeEach(() => {
  signed.length = 0;
  forgetSessionStamps();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 250);
});

afterEach(() => vi.restoreAllMocks());

describe('useNostrPublish created_at', () => {
  it('stamps a second write to the same plot in the same second after the first', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    const plant = await result.current.mutateAsync(plot());
    const water = await result.current.mutateAsync(plot());
    expect(plant.created_at).toBe(NOW);
    expect(water.created_at).toBe(NOW + 1);
  });

  it('steps past the replaced event when this device clock is behind it', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    const event = await result.current.mutateAsync({ ...plot(), replaces: { created_at: NOW + 20 } });
    expect(event.created_at).toBe(NOW + 21);
  });

  it('does not chase a replaced event dated far in the future', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    const event = await result.current.mutateAsync({ ...plot(), replaces: { created_at: NOW + 3600 } });
    expect(event.created_at).toBe(NOW);
  });

  it('keeps 50 rapid writes in one second strictly ordered and inside the bound', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    const stamps: number[] = [];
    for (let i = 0; i < 50; i += 1) stamps.push((await result.current.mutateAsync(plot())).created_at);
    expect(new Set(stamps).size).toBe(50);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(Math.max(...stamps)).toBeLessThanOrEqual(NOW + MAX_FUTURE_SKEW_SEC);
  });

  it('stamps concurrent writes to one plot apart', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    const [a, b] = await Promise.all([result.current.mutateAsync(plot()), result.current.mutateAsync(plot())]);
    expect(new Set([a.created_at, b.created_at])).toEqual(new Set([NOW, NOW + 1]));
  });

  it('leaves other plots, regular events and explicit timestamps alone', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    await result.current.mutateAsync(plot(1));
    expect((await result.current.mutateAsync(plot(2))).created_at).toBe(NOW);
    expect((await result.current.mutateAsync({ kind: 1, content: 'hi', tags: [] })).created_at).toBe(NOW);
    expect((await result.current.mutateAsync({ kind: 1, content: 'hi', tags: [] })).created_at).toBe(NOW);
    expect((await result.current.mutateAsync({ ...plot(1), created_at: NOW - 5 })).created_at).toBe(NOW - 5);
  });

  it('never signs the replaces hint', async () => {
    const { result } = renderHook(() => useNostrPublish(), { wrapper });
    await result.current.mutateAsync({ ...plot(), replaces: { created_at: NOW } });
    expect(signed[0]).not.toHaveProperty('replaces');
  });
});
