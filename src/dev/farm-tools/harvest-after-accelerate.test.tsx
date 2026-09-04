import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { plantSeed } from '@/farm/growth/evaluate';
import { systemClock } from '@/farm/time';
import { INVENTORY_KINDS, KIND_GAME_INVENTORY } from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { FARM_HARVEST_MARKER } from '@/inventory/farm-inventory';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import type { FarmSlotRecord } from '@/hooks/farm/useFarmSlots';

/**
 * The whole developer flow against the real harvest pipeline:
 *
 *   plant (normal) → Make harvestable (dev) → Harvest (normal)
 *
 * The dev step publishes one kind:31417 and nothing else. The harvest that
 * follows is `useFarmActions` untouched: it credits `farm:main` through
 * `creditHarvest`, marks the consumed plant event, and only then clears the
 * slot. A second harvest of the same crop finds the marker and adds nothing.
 */
vi.mock('@/dev/enabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/dev/enabled')>()),
  DEV_TOOLS_ENABLED: true,
}));

const OWNER = FARM_OFFICIAL_ISSUER_PUBKEY;
const MAP = 'farm.field';

/** kind:31417 events published through the world-state path. */
const slotPublishes: NostrEvent[] = [];
/** What the inventory relays hold, by kind. */
const inventoryStore: NostrEvent[] = [];
const foldStore: NostrEvent[] = [];
const spendStore: NostrEvent[] = [];
/** Every distinct event offered to the inventory relays, by kind, in order. */
const inventoryPublishes: number[] = [];
const offered = new Set<string>();

let signed = 0;
const sign = async (t: { kind: number; content: string; tags: string[][]; created_at?: number }): Promise<NostrEvent> => ({
  kind: t.kind,
  content: t.content,
  tags: t.tags,
  created_at: t.created_at ?? systemClock.now(),
  id: `${t.kind}-${++signed}`.padEnd(64, '0'),
  pubkey: OWNER,
  sig: 'x'.repeat(128),
});

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: OWNER, signer: { signEvent: sign } } }),
}));

vi.mock('@/hooks/useNostrPublish', () => ({
  useNostrPublish: () => ({
    mutateAsync: async (template: { kind: number; content: string; tags: string[][] }) => {
      const event = await sign(template);
      slotPublishes.push(event);
      return event;
    },
  }),
}));

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async ([filter]: { kinds?: number[]; ids?: string[] }[]) => {
          const kind = filter.kinds?.[0];
          const source = kind === INVENTORY_KINDS.spend ? spendStore : kind === INVENTORY_KINDS.fold ? foldStore : inventoryStore;
          return source.filter((event) => !filter.ids || filter.ids.includes(event.id));
        },
        event: async (event: NostrEvent) => {
          if (!offered.has(event.id)) {
            offered.add(event.id);
            inventoryPublishes.push(event.kind);
          }
          const store = event.kind === INVENTORY_KINDS.fold ? foldStore : inventoryStore;
          if (!store.some((existing) => existing.id === event.id)) store.push(event);
        },
      }),
    },
  }),
}));

vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: () => undefined }) }));

const { useAccelerateCrop } = await import('./useAccelerateCrop');
const { useFarmActions } = await import('@/hooks/farm/useFarmActions');

let client: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const strawberryQuantity = () => {
  const tag = inventoryStore.at(-1)?.tags.find((t) => t[0] === 'a' && t[1] === PRODUCE_CATALOG.strawberry.address);
  return tag ? Number(tag[3]) : 0;
};
const harvestMarkers = () =>
  (inventoryStore.at(-1)?.tags ?? []).filter((t) => t[0] === 'e' && t[3] === FARM_HARVEST_MARKER).map((t) => t[1]);

beforeEach(() => {
  vi.stubGlobal('navigator', {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  slotPublishes.length = 0;
  inventoryStore.length = 0;
  foldStore.length = 0;
  spendStore.length = 0;
  inventoryPublishes.length = 0;
  offered.clear();
  signed = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('harvest after developer acceleration', () => {
  it('runs the normal harvest pipeline once, for exactly one unit', async () => {
    // A strawberry planted normally a moment ago, confirmed on the relay.
    const planted: FarmSlotRecord = {
      slot: { coord: { x: 2, y: 1 }, content: { type: 'plant', plant: plantSeed('strawberry', systemClock.now() - 10) } },
      sourceEventId: 'p'.repeat(64),
    };

    // Dev step: one kind:31417, no inventory event of any kind.
    const accelerate = renderHook(() => useAccelerateCrop(), { wrapper });
    const ready = await accelerate.result.current.mutateAsync({ mapId: MAP, record: planted });
    expect(slotPublishes).toHaveLength(1);
    expect(slotPublishes[0].kind).toBe(KIND_SLOT_STATE);
    expect(inventoryPublishes).toEqual([]);
    expect(inventoryStore).toHaveLength(0);

    // Normal step: the field harvests the record the cache now holds.
    const record: FarmSlotRecord = { slot: ready.slot, sourceEventId: ready.eventId };
    const actions = renderHook(() => useFarmActions(), { wrapper });
    const result = await actions.result.current.act({ mapId: MAP, record, type: 'harvest' });

    expect(result?.harvest).toMatchObject({ cropId: 'strawberry', quantity: 1 });
    expect(result?.produce?.address).toBe(PRODUCE_CATALOG.strawberry.address);

    // Exactly one kind:31633, crediting +1 of the ordinary Strawberry, marked
    // with the accelerated plant event as the consumed harvest.
    expect(inventoryPublishes).toEqual([KIND_GAME_INVENTORY]);
    expect(inventoryStore).toHaveLength(1);
    expect(strawberryQuantity()).toBe(1);
    expect(harvestMarkers()).toEqual([ready.eventId]);

    // And only then the empty slot, through the same world-state path.
    expect(slotPublishes).toHaveLength(2);
    expect(slotPublishes[1].kind).toBe(KIND_SLOT_STATE);
    expect(slotPublishes[1].tags).toContainEqual(['type', 'empty']);
  });

  it('cannot credit the same accelerated crop twice', async () => {
    const planted: FarmSlotRecord = {
      slot: { coord: { x: 2, y: 1 }, content: { type: 'plant', plant: plantSeed('strawberry', systemClock.now() - 10) } },
      sourceEventId: 'p'.repeat(64),
    };
    const accelerate = renderHook(() => useAccelerateCrop(), { wrapper });
    const ready = await accelerate.result.current.mutateAsync({ mapId: MAP, record: planted });
    const record: FarmSlotRecord = { slot: ready.slot, sourceEventId: ready.eventId };

    const actions = renderHook(() => useFarmActions(), { wrapper });
    await actions.result.current.act({ mapId: MAP, record, type: 'harvest' });
    // A retry with the stale record (crop still ripe, same plant event).
    await actions.result.current.act({ mapId: MAP, record, type: 'harvest' });

    expect(inventoryStore).toHaveLength(1);
    expect(strawberryQuantity()).toBe(1);
    expect(harvestMarkers()).toEqual([ready.eventId]);
  });
});
