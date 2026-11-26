import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { KIND_MAP_STATE, KIND_WORLD_STATE } from '@/nostr/kinds';
import { getTag } from '@/nostr/tags';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { FARM_OWNER, mapEvent, worldEvent } from '@/test/farm-fixtures';

let network = new FakeRelayNetwork();
/** Every event the hook published, in order. Each one lands on the fake relays at once. */
const published: NostrEvent[] = [];
const toasts: { title?: string; variant?: string }[] = [];
let publishFails: ((event: NostrEvent) => boolean) | null = null;

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({ nostr: network.pool }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: FARM_OWNER, signer: {} } }),
}));

vi.mock('@/hooks/useNostrPublish', () => ({
  useNostrPublish: () => ({
    mutateAsync: async (template: { kind: number; content: string; tags: string[][] }) => {
      const event: NostrEvent = {
        ...template,
        id: `${template.kind}-${published.length}`.padEnd(64, '0'),
        pubkey: FARM_OWNER,
        created_at: 1_700_000_100 + published.length,
        sig: 'x'.repeat(128),
      };
      if (publishFails?.(event)) throw new Error('relay refused');
      published.push(event);
      network.publish(event);
      return event;
    },
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: (t: { title?: string; variant?: string }) => toasts.push(t) }),
}));

// The production pause between the two confirming reads is two seconds; the
// relays here answer instantly, so the pause only slows the suite down.
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

const { useCreateFarm } = await import('./useCreateFarm');
const { lookupFarm, farmLookupDeps } = await import('./farm-lookup');

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const kinds = () => published.map((event) => event.kind);

beforeEach(() => {
  network = new FakeRelayNetwork();
  published.length = 0;
  toasts.length = 0;
  publishFails = null;
});

describe('useCreateFarm', () => {
  it('publishes a world and then its field once absence is confirmed', async () => {
    const { result } = renderHook(() => useCreateFarm(), { wrapper });

    const outcome = await result.current.createFarm({ name: '  Willow Patch ' });

    expect(outcome).toBe('created');
    expect(kinds()).toEqual([KIND_WORLD_STATE, KIND_MAP_STATE]);
    expect(getTag(published[0], 'name')).toBe('Willow Patch');
    expect(getTag(published[1], 'a')).toBe(`${KIND_WORLD_STATE}:${FARM_OWNER}:farm`);
    expect(toasts[0]?.title).toBe('Farm created');
    await waitFor(() => expect(result.current.isCreating).toBe(false));
  });

  it('publishes nothing when a farm already exists, whatever the page showed', async () => {
    network.seed(worldEvent({ name: 'Old Name' }), mapEvent());
    const { result } = renderHook(() => useCreateFarm(), { wrapper });

    const outcome = await result.current.createFarm({ name: 'New Name' });

    expect(outcome).toBe('existing');
    expect(published).toEqual([]);
    expect(toasts[0]?.title).toBe('Farm found');
  });

  it('refuses when the final check cannot confirm absence, and publishes nothing', async () => {
    network.closeBeforeEose('wss://relay.primal.net');
    const { result } = renderHook(() => useCreateFarm(), { wrapper });

    await expect(result.current.createFarm({ name: 'Willow Patch' })).rejects.toThrow(/cannot tell whether you already have a farm/);

    expect(published).toEqual([]);
    expect(toasts[0]?.variant).toBe('destructive');
  });

  it('does not create a farm that appeared between the page lookup and the click', async () => {
    // What the page saw: nothing, confirmed.
    expect(await lookupFarm(farmLookupDeps(network.pool, FARM_OWNER))).toEqual({ status: 'absent' });

    // Another device creates the farm in the meantime.
    network.seed(worldEvent({ name: 'From The Phone' }), mapEvent());

    const { result } = renderHook(() => useCreateFarm(), { wrapper });
    const outcome = await result.current.createFarm({ name: 'From The Laptop' });

    expect(outcome).toBe('existing');
    expect(published).toEqual([]);
  });

  it('restores only the field when the world exists without one, keeping the world untouched', async () => {
    network.seed(worldEvent({ name: 'Willow Patch' }));
    const { result } = renderHook(() => useCreateFarm(), { wrapper });

    const outcome = await result.current.createFarm({ name: 'Should Be Ignored' });

    expect(outcome).toBe('restored');
    expect(kinds()).toEqual([KIND_MAP_STATE]);
    expect(getTag(published[0], 'd')).toBe('farm.field');
    expect(toasts[0]?.title).toBe('Field restored');
  });

  it('finishes a half-done creation on the next attempt instead of starting over', async () => {
    publishFails = (event) => event.kind === KIND_MAP_STATE;
    const { result } = renderHook(() => useCreateFarm(), { wrapper });

    await expect(result.current.createFarm({ name: 'Willow Patch' })).rejects.toThrow(/relay refused/);
    expect(kinds()).toEqual([KIND_WORLD_STATE]);

    publishFails = null;
    const outcome = await result.current.createFarm({ name: 'A Different Name' });

    expect(outcome).toBe('restored');
    expect(kinds()).toEqual([KIND_WORLD_STATE, KIND_MAP_STATE]);
    // The world kept the name from the first attempt; only the field was added.
    expect(getTag(published[0], 'name')).toBe('Willow Patch');
  });

  it('collapses concurrent attempts into one, and later attempts into no-ops', async () => {
    const { result } = renderHook(() => useCreateFarm(), { wrapper });

    const [first, second] = await Promise.all([
      result.current.createFarm({ name: 'Willow Patch' }),
      result.current.createFarm({ name: 'Willow Patch' }),
    ]);

    expect([first, second]).toEqual(['created', 'created']);
    expect(kinds()).toEqual([KIND_WORLD_STATE, KIND_MAP_STATE]);

    const third = await result.current.createFarm({ name: 'Willow Patch' });

    expect(third).toBe('existing');
    expect(kinds()).toEqual([KIND_WORLD_STATE, KIND_MAP_STATE]);
  });
});
