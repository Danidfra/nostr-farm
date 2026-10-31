import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GAME_RELAY } from '@/nostr/relays';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { FARM_OWNER, mapEvent, worldEvent } from '@/test/farm-fixtures';

let network = new FakeRelayNetwork();

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: network.pool }),
}));

vi.mock('./farm-lookup', async (importOriginal) => {
  const original = await importOriginal<typeof import('./farm-lookup')>();
  return {
    ...original,
    farmLookupDeps: (...args: Parameters<typeof original.farmLookupDeps>) => ({
      ...original.farmLookupDeps(...args),
      wait: async () => undefined,
    }),
  };
});

const { useFarm, foundFarm } = await import('./useFarm');

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  network = new FakeRelayNetwork();
});

describe('useFarm', () => {
  it('reports a found farm, and foundFarm unwraps it', async () => {
    network.seed(worldEvent({ name: 'Willow Patch' }), mapEvent());

    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.status).toBe('found');
    expect(foundFarm(result.current.data)?.world.name).toBe('Willow Patch');
  });

  it('reports a confirmed absence as absent', async () => {
    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ status: 'absent' });
    expect(foundFarm(result.current.data)).toBeUndefined();
  });

  it('reports an empty read that closed before EOSE as unknown, which the page shows as an error with retry', async () => {
    network.closeBeforeEose(DEFAULT_GAME_RELAY);

    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ status: 'unknown', reason: 'unreachable' });
    expect(foundFarm(result.current.data)).toBeUndefined();
  });

  it('does nothing without a pubkey', () => {
    const { result } = renderHook(() => useFarm(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(network.subscriptions).toHaveLength(0);
  });
});
