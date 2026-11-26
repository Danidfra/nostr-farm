import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME_RELAY_URLS, PRIMARY_RELAY_URL, REQUIRED_GAME_RELAY_URLS } from '@/nostr/relays';
import { relaySync } from '@/nostr/relay-sync';
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
  relaySync.consent.disable(FARM_OWNER);
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
    for (const relay of GAME_RELAY_URLS) network.closeBeforeEose(relay);

    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ status: 'unknown', reason: 'unreachable' });
    expect(foundFarm(result.current.data)).toBeUndefined();
  });

  it('does not take an empty primary relay for "no farm" while the relay the farm was written to has not answered', async () => {
    // The primary relay is new and holds nothing for this player; the relay a
    // farm would have been written to closes the subscription before EOSE.
    for (const relay of REQUIRED_GAME_RELAY_URLS) network.closeBeforeEose(relay);

    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ status: 'unknown', reason: 'partial' });
    expect(network.offers).toEqual([]);
  });

  it('a restored session finds a farm only a secondary relay holds and sends no EVENT to any relay', async () => {
    const world = worldEvent();
    const map = mapEvent();
    network.seed(world, map);
    network.withhold(PRIMARY_RELAY_URL, world.id, map.id);

    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result.current.data?.status).toBe('found');
    expect(network.offers).toEqual([]);
  });

  it('finds a farm that only a secondary relay holds, and offers it to the primary relay once the account turned copying on', async () => {
    relaySync.consent.enable(FARM_OWNER, GAME_RELAY_URLS);
    const world = worldEvent();
    const map = mapEvent();
    network.seed(world, map);
    network.withhold(PRIMARY_RELAY_URL, world.id, map.id);

    const { result } = renderHook(() => useFarm(FARM_OWNER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.status).toBe('found');
    await waitFor(() => expect(network.acceptedBy(PRIMARY_RELAY_URL).map((e) => e.id).sort()).toEqual([world.id, map.id].sort()));
    // The original events, to the relay that lacked them, and to no other.
    expect(network.offers.every((offer) => offer.relay === PRIMARY_RELAY_URL)).toBe(true);
    expect(network.acceptedBy(PRIMARY_RELAY_URL)).toEqual(expect.arrayContaining([world, map]));
  });

  it('does nothing without a pubkey', () => {
    const { result } = renderHook(() => useFarm(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(network.subscriptions).toHaveLength(0);
  });
});
