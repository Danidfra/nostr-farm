import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { plantSeed, waterPlant } from '@/farm/growth/evaluate';
import { CROP_CATALOG } from '@/farm/crops/catalog';
import { systemClock } from '@/farm/time';
import type { FarmSlot } from '@/farm/slots/types';
import { INVENTORY_KINDS, KIND_GAME_INVENTORY } from '@/inventory/package';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { eventId, foldEvent, foldRefs, foldTag, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';
import { buildSlotState } from '@/nostr/slot-state';
import { reqOverStore } from '@/test/fake-relay';

const OWNER = 'a'.repeat(64);
const MAP = 'farm.field';
const PLANT_EVENT = 'c'.repeat(64);

/** Events published through the SLOT path (kind 31417). */
const slotPublishes: { kind?: number; tags?: string[][] }[] = [];
/** What the GAME relays hold for kind:31417: seeded by `record()`, extended by every slot publish. */
const slotStore: NostrEvent[] = [];
let slotEvents = 0;
/** Whether a slot read reaches EOSE; false models a relay that closes the subscription first. */
let slotReadEose = true;
/** Events published through the INVENTORY path (kind 31633). */
const inventoryStore: NostrEvent[] = [];
/** kind:1417 manifests on the relays. */
const foldStore: NostrEvent[] = [];
/** kind:1416 spends on the relays (published by another game, never by the Farm). */
const spendStore: NostrEvent[] = [];
/** Every distinct event offered to the inventory relays, in order, by kind. */
const inventoryPublishes: number[] = [];
const offered = new Set<string>();
function recordPublish(event: NostrEvent) {
  if (offered.has(event.id)) return;
  offered.add(event.id);
  inventoryPublishes.push(event.kind);
}

let slotPublishFails = false;
let inventoryPublishOutcome: 'accepted' | 'rejected' | 'ambiguous' = 'accepted';
let inventoryAmbiguousLands = false;

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: OWNER,
      signer: {
        signEvent: async (t: { kind: number; content: string; tags: string[][]; created_at: number }) => ({
          ...t,
          id: `${t.kind}-${offered.size}`.padEnd(64, '0'),
          pubkey: OWNER,
          sig: 'x'.repeat(128),
        }),
      },
    },
  }),
}));

vi.mock('@/hooks/useNostrPublish', () => ({
  useNostrPublish: () => ({
    mutateAsync: async (template: { kind?: number; tags?: string[][] }) => {
      if (slotPublishFails) throw new Error('slot relay refused');
      slotPublishes.push(template);
      slotEvents += 1;
      const event: NostrEvent = {
        kind: template.kind ?? 0,
        content: '',
        tags: template.tags ?? [],
        id: `slot-${slotEvents}`.padEnd(64, '0'),
        pubkey: OWNER,
        created_at: systemClock.now() + slotEvents,
        sig: 'x'.repeat(128),
      };
      slotStore.push(event);
      return event;
    },
  }),
}));

vi.mock('@nostrify/react', () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        req: reqOverStore(() => slotStore, () => ({ eose: slotReadEose })),
        query: async ([filter]: { kinds?: number[]; ids?: string[] }[]) => {
          const kind = filter.kinds?.[0];
          const source =
            kind === INVENTORY_KINDS.spend ? spendStore : kind === INVENTORY_KINDS.fold ? foldStore : inventoryStore;
          return source.filter((event) => !filter.ids || filter.ids.includes(event.id));
        },
        event: async (event: NostrEvent) => {
          // Manifests are published to the same relays through the same path;
          // in this fake they always land, so the snapshot's outcome is what
          // the scenario controls.
          recordPublish(event);
          if (event.kind === INVENTORY_KINDS.fold) {
            if (!foldStore.some((existing) => existing.id === event.id)) foldStore.push(event);
            return;
          }
          // Three relays receive the same event; the fake store keeps one copy,
          // the way a reader that de-duplicates by id would see it.
          const store = (e: NostrEvent) => {
            if (!inventoryStore.some((existing) => existing.id === e.id)) inventoryStore.push(e);
          };
          if (inventoryPublishOutcome === 'accepted') {
            store(event);
            return;
          }
          if (inventoryPublishOutcome === 'ambiguous' && inventoryAmbiguousLands) store(event);
          const error = new Error(inventoryPublishOutcome === 'ambiguous' ? 'timeout' : 'blocked');
          error.name = inventoryPublishOutcome === 'ambiguous' ? 'TimeoutError' : 'Error';
          throw error;
        },
      }),
    },
  }),
}));

const toasts: { title?: string; variant?: string }[] = [];
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: (t: { title?: string; variant?: string }) => toasts.push(t) }),
}));

const { useFarmActions, forgetObservedRevisions } = await import('./useFarmActions');
const { farmInventoryQueryKey } = await import('./useFarmInventory');
type FarmInventoryView = import('./useFarmInventory').FarmInventoryView;

function readyCarrot(coord = { x: 1, y: 1 }, plantedAt = systemClock.now() - 10_000): FarmSlot {
  const crop = CROP_CATALOG.carrot;
  const now = systemClock.now();
  let plant = plantSeed('carrot', plantedAt);
  // Water enough to be ripe right now, and still wet so it has not rotted.
  plant = { ...plant, growthSec: crop.harvestStage * crop.stageDurationSec, growthUpdatedAt: now };
  plant = waterPlant(plant, now, crop);
  return { coord, content: { type: 'plant', plant } };
}

/** Put `slot` on the game relays under `id`, replacing any earlier event with that id. */
function onRelay(slot: FarmSlot, id: string, createdAt = systemClock.now() - 1000): NostrEvent {
  const event: NostrEvent = { ...buildSlotState({ mapId: MAP, ownerPubkey: OWNER, slot }), id, pubkey: OWNER, created_at: createdAt, sig: 'x'.repeat(128) };
  const existing = slotStore.findIndex((e) => e.id === id);
  if (existing >= 0) slotStore.splice(existing, 1);
  slotStore.push(event);
  return event;
}

let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A slot record as the field holds it; a confirmed one is also put on the relays. */
const record = (slot: FarmSlot, sourceEventId: string | null = PLANT_EVENT) => {
  if (sourceEventId) onRelay(slot, sourceEventId);
  return { slot, sourceEventId: sourceEventId ?? undefined };
};

const inventoryTags = () => inventoryStore.at(-1)?.tags ?? [];
const carrotQuantity = () => {
  const tag = inventoryTags().find((t) => t[0] === 'a' && t[1] === PRODUCE_CATALOG.carrot.address);
  return tag ? Number(tag[3]) : 0;
};
const harvestMarkers = () => inventoryTags().filter((t) => t[0] === 'e' && t[3] === 'farm-harvest').map((t) => t[1]);

beforeEach(() => {
  vi.stubGlobal('navigator', {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  slotPublishes.length = 0;
  inventoryStore.length = 0;
  foldStore.length = 0;
  spendStore.length = 0;
  inventoryPublishes.length = 0;
  offered.clear();
  toasts.length = 0;
  slotPublishFails = false;
  inventoryPublishOutcome = 'accepted';
  inventoryAmbiguousLands = false;
  slotStore.length = 0;
  slotEvents = 0;
  slotReadEose = true;
  forgetObservedRevisions();
});

afterEach(() => vi.unstubAllGlobals());

describe('harvest ordering', () => {
  it('credits the inventory before clearing the slot', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });

    expect(inventoryStore).toHaveLength(1);
    expect(inventoryStore[0].kind).toBe(KIND_GAME_INVENTORY);
    expect(carrotQuantity()).toBe(1);
    expect(harvestMarkers()).toEqual([PLANT_EVENT]);

    // And only then the empty slot.
    expect(slotPublishes).toHaveLength(1);
    expect(slotPublishes[0].tags).toContainEqual(['type', 'empty']);
  });

  it('leaves the crop planted when the inventory credit is rejected', async () => {
    inventoryPublishOutcome = 'rejected';
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' })
    ).rejects.toThrow();

    expect(slotPublishes).toHaveLength(0);
    expect(inventoryStore).toHaveLength(0);
  });

  it('leaves the crop planted when the credit is ambiguous and unresolved', async () => {
    inventoryPublishOutcome = 'ambiguous';
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' })
    ).rejects.toThrow(/may or may not/i);

    expect(slotPublishes).toHaveLength(0);
  });

  it('completes when an ambiguous credit actually landed', async () => {
    inventoryPublishOutcome = 'ambiguous';
    inventoryAmbiguousLands = true;
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });

    // Reconciliation found the marker, so the slot clear proceeded.
    expect(carrotQuantity()).toBe(1);
    expect(slotPublishes).toHaveLength(1);
  });

  it('keeps the item credited when the slot clear fails', async () => {
    slotPublishFails = true;
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' })
    ).rejects.toThrow(/clearing the crop failed/i);

    expect(carrotQuantity()).toBe(1);
    expect(slotPublishes).toHaveLength(0);
  });

  it('a retry after a failed slot clear does not credit again', async () => {
    slotPublishFails = true;
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();

    await expect(result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' })).rejects.toThrow();
    expect(carrotQuantity()).toBe(1);

    slotPublishFails = false;
    await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });

    expect(carrotQuantity()).toBe(1);
    expect(harvestMarkers()).toEqual([PLANT_EVENT]);
    expect(slotPublishes).toHaveLength(1);
  });
});

describe('harvest guards', () => {
  it('grants nothing for a crop with no official produce', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();
    const unmapped: FarmSlot = {
      ...slot,
      content: { type: 'plant', plant: { ...(slot.content as { plant: ReturnType<typeof plantSeed> }).plant, cropId: 'moonfruit' } },
    };

    await expect(result.current.act({ mapId: MAP, record: record(unmapped), type: 'harvest' })).rejects.toThrow();
    expect(inventoryStore).toHaveLength(0);
    expect(slotPublishes).toHaveLength(0);
  });

  it('grants nothing when the crop is not ready', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const unripe: FarmSlot = { coord: { x: 1, y: 1 }, content: { type: 'plant', plant: plantSeed('carrot', systemClock.now()) } };

    await expect(result.current.act({ mapId: MAP, record: record(unripe), type: 'harvest' })).rejects.toThrow();
    expect(inventoryStore).toHaveLength(0);
    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses to harvest a crop with no confirmed source event', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot(), null), type: 'harvest' })
    ).rejects.toThrow(/not been confirmed/i);
    expect(inventoryStore).toHaveLength(0);
  });

  it('credits once for a same-tick double click', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const input = { mapId: MAP, record: record(readyCarrot()), type: 'harvest' as const };

    await Promise.all([result.current.act(input), result.current.act(input)]);

    expect(carrotQuantity()).toBe(1);
    expect(harvestMarkers()).toEqual([PLANT_EVENT]);
  });
});

describe('non-harvest actions still work', () => {
  it('plants without touching the inventory', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({
      mapId: MAP,
      record: record({ coord: { x: 0, y: 0 }, content: { type: 'empty' } }, null),
      type: 'plant',
      cropId: 'carrot',
    });

    expect(slotPublishes).toHaveLength(1);
    expect(inventoryStore).toHaveLength(0);
  });

  it('waters without touching the inventory', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const dry: FarmSlot = { coord: { x: 0, y: 0 }, content: { type: 'plant', plant: plantSeed('carrot', systemClock.now()) } };

    await result.current.act({ mapId: MAP, record: record(dry), type: 'water' });

    expect(slotPublishes).toHaveLength(1);
    expect(inventoryStore).toHaveLength(0);
  });

  it('clearing a rotten crop grants no produce', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const crop = CROP_CATALOG.carrot;
    const now = systemClock.now();
    const rotten: FarmSlot = {
      coord: { x: 0, y: 0 },
      content: {
        type: 'plant',
        plant: { cropId: 'carrot', plantedAt: now - 100_000, growthSec: 0, growthUpdatedAt: now - 100_000, wetUntil: now - crop.rotAfterDrySec - 10 },
      },
    };

    await result.current.act({ mapId: MAP, record: record(rotten), type: 'clear' });

    expect(slotPublishes).toHaveLength(1);
    expect(inventoryStore).toHaveLength(0);
    await waitFor(() => expect(toasts.some((t) => t.title?.startsWith('+1'))).toBe(false));
  });
});

describe('harvest with spends from another game', () => {
  const S1 = eventId('s1');
  const M1 = eventId('m1');

  it('folds a pending spend: manifest first, then a snapshot that references it', async () => {
    inventoryStore.push(snapshotEvent({ items: { [PRODUCE_CATALOG.carrot.address]: 3 }, revision: 1 }));
    spendStore.push(spendEvent({ id: S1, item: PRODUCE_CATALOG.carrot.address, quantity: 1 }));
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });

    expect(inventoryPublishes).toEqual([INVENTORY_KINDS.fold, KIND_GAME_INVENTORY]);
    expect(foldStore).toHaveLength(1);
    expect(foldRefs(foldStore[0], 'spend')).toEqual([S1]);
    // (3 − 1) + 1
    expect(carrotQuantity()).toBe(3);
    expect(foldTag(inventoryStore.at(-1))?.[1]).toBe(foldStore[0].id);
    expect(harvestMarkers()).toEqual([PLANT_EVENT]);
    expect(slotPublishes).toHaveLength(1);
  });

  it('the cached view after the write shows the folded balance, not the balance minus the spend again', async () => {
    inventoryStore.push(snapshotEvent({ items: { [PRODUCE_CATALOG.carrot.address]: 3 }, revision: 1 }));
    spendStore.push(spendEvent({ id: S1, item: PRODUCE_CATALOG.carrot.address, quantity: 1 }));
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });

    const view = client.getQueryData<FarmInventoryView>(farmInventoryQueryKey(OWNER));
    expect(view?.status).toBe('ready');
    expect(view?.produce).toEqual([{ definition: PRODUCE_CATALOG.carrot, quantity: 3 }]);
    expect(view?.pending).toEqual({ applied: 0, rejected: 0 });
  });

  it('blocks the harvest, and clears nothing, while the fold chain is unresolved', async () => {
    inventoryStore.push(snapshotEvent({ items: { [PRODUCE_CATALOG.carrot.address]: 3 }, fold: { eventId: M1 } }));
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' })
    ).rejects.toThrow(/could not be verified/i);

    expect(inventoryPublishes).toEqual([]);
    expect(slotPublishes).toHaveLength(0);
    expect(inventoryStore).toHaveLength(1);
  });

  it('harvests normally, with no manifest, when the chain resolves and nothing is pending', async () => {
    foldStore.push(foldEvent({ id: M1, spends: [S1] }));
    spendStore.push(spendEvent({ id: S1, item: PRODUCE_CATALOG.carrot.address, quantity: 1 }));
    inventoryStore.push(snapshotEvent({ items: { [PRODUCE_CATALOG.carrot.address]: 2 }, fold: { eventId: M1 }, revision: 3 }));
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });

    expect(inventoryPublishes).toEqual([KIND_GAME_INVENTORY]);
    expect(foldStore).toHaveLength(1);
    expect(foldTag(inventoryStore.at(-1))?.[1]).toBe(M1);
    expect(carrotQuantity()).toBe(3);
  });

  it('the snapshot after an accepted manifest failing leaves the orphan and reuses it on retry', async () => {
    inventoryStore.push(snapshotEvent({ items: { [PRODUCE_CATALOG.carrot.address]: 3 }, revision: 1 }));
    spendStore.push(spendEvent({ id: S1, item: PRODUCE_CATALOG.carrot.address, quantity: 1 }));
    inventoryPublishOutcome = 'rejected';
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();

    await expect(result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' })).rejects.toThrow();
    expect(foldStore).toHaveLength(1);
    expect(inventoryStore).toHaveLength(1);

    inventoryPublishOutcome = 'accepted';
    await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });

    // Same manifest, referenced now; one credit, one marker.
    expect(foldStore).toHaveLength(1);
    expect(foldTag(inventoryStore.at(-1))?.[1]).toBe(foldStore[0].id);
    expect(carrotQuantity()).toBe(3);
    expect(harvestMarkers()).toEqual([PLANT_EVENT]);
  });
});

describe('harvest identity', () => {
  it('records the planting of the harvested plot next to the event marker', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();

    await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });

    const plantedAt = (slot.content as { plant: { plantedAt: number } }).plant.plantedAt;
    expect(inventoryTags()).toContainEqual(['harvest', `slot:${MAP}:1:1`, String(plantedAt)]);
    expect(harvestMarkers()).toEqual([PLANT_EVENT]);
  });

  it('refuses a stale record of a plot that has since been harvested, without reading the inventory', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();

    await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });
    // A second device still holds the plant under an older event; the relays hold the empty slot.
    await expect(
      result.current.act({ mapId: MAP, record: record(slot, 'e'.repeat(64)), type: 'harvest' })
    ).rejects.toThrow(/another device/);

    expect(carrotQuantity()).toBe(1);
    expect(inventoryStore).toHaveLength(1);
    expect(slotPublishes).toHaveLength(1);
  });
});

describe('the plot is re-read before any credit', () => {
  const crop = CROP_CATALOG.carrot;

  it('harvests the plot as the relays hold it, honouring a watering from another device', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();
    const stale = record(slot, PLANT_EVENT);
    // Another device watered since: the relays' newest event is E2, same planting.
    const watered: FarmSlot = { ...slot, content: { type: 'plant', plant: waterPlant((slot.content as { plant: ReturnType<typeof plantSeed> }).plant, systemClock.now() - 5, crop) } };
    onRelay(watered, 'e'.repeat(64), systemClock.now() - 5);

    await result.current.act({ mapId: MAP, record: stale, type: 'harvest' });

    expect(carrotQuantity()).toBe(1);
    // The credit consumed the fresh event, not the stale one this device held.
    expect(harvestMarkers()).toEqual(['e'.repeat(64)]);
    expect(slotPublishes).toHaveLength(1);
  });

  it('refuses when the plot moved on to a different planting', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();
    const stale = record(slot, PLANT_EVENT);
    onRelay(readyCarrot({ x: 1, y: 1 }, systemClock.now() - 5_000), 'e'.repeat(64), systemClock.now() - 5);

    await expect(result.current.act({ mapId: MAP, record: stale, type: 'harvest' })).rejects.toThrow(/another device/);

    expect(inventoryStore).toHaveLength(0);
    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses when the relays have nothing for the plot', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const stale = record(readyCarrot(), PLANT_EVENT);
    slotStore.length = 0;

    await expect(result.current.act({ mapId: MAP, record: stale, type: 'harvest' })).rejects.toThrow(/nothing for this plot/);

    expect(inventoryStore).toHaveLength(0);
    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses when no relay finished answering, even though the plant was seen', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const confirmed = record(readyCarrot(), PLANT_EVENT);
    slotReadEose = false;

    await expect(result.current.act({ mapId: MAP, record: confirmed, type: 'harvest' })).rejects.toThrow(/did not finish/);

    expect(inventoryStore).toHaveLength(0);
    expect(slotPublishes).toHaveLength(0);
  });

  it('clears a plant that reappears after its harvest without crediting it again', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();
    await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });
    expect(carrotQuantity()).toBe(1);

    // A watering from another device lands AFTER the empty slot: the same planting is back under a new id.
    const plant = (slot.content as { plant: ReturnType<typeof plantSeed> }).plant;
    const zombie: FarmSlot = { ...slot, content: { type: 'plant', plant: waterPlant(plant, systemClock.now(), crop) } };
    onRelay(zombie, 'f'.repeat(64), systemClock.now() + 100);

    await result.current.act({ mapId: MAP, record: { slot: zombie, sourceEventId: 'f'.repeat(64) }, type: 'harvest' });

    expect(carrotQuantity()).toBe(1);
    expect(inventoryStore).toHaveLength(1);
    expect(slotPublishes).toHaveLength(2);
    expect(slotPublishes[1].tags).toContainEqual(['type', 'empty']);
  });

  it('two devices holding different versions of one plant credit it once', async () => {
    const slot = readyCarrot();
    const plant = (slot.content as { plant: ReturnType<typeof plantSeed> }).plant;
    const watered: FarmSlot = { ...slot, content: { type: 'plant', plant: waterPlant(plant, systemClock.now() - 5, crop) } };
    const deviceA = record(slot, PLANT_EVENT);
    const deviceB = { slot: watered, sourceEventId: 'e'.repeat(64) };
    onRelay(watered, 'e'.repeat(64), systemClock.now() - 5);

    const a = renderHook(() => useFarmActions(), { wrapper });
    await a.result.current.act({ mapId: MAP, record: deviceA, type: 'harvest' });

    const b = renderHook(() => useFarmActions(), { wrapper });
    await expect(b.result.current.act({ mapId: MAP, record: deviceB, type: 'harvest' })).rejects.toThrow(/another device/);

    expect(carrotQuantity()).toBe(1);
    expect(inventoryStore).toHaveLength(1);
  });
});

describe('inventory revision floor', () => {
  const PLOT_2 = 'g'.repeat(64);

  it('refuses to build on a read that is behind a revision this session already wrote', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });
    expect(inventoryStore).toHaveLength(1);

    // The relays "lose" the snapshot this session just wrote.
    const written = inventoryStore.splice(0, 1);

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot({ x: 2, y: 2 }), PLOT_2), type: 'harvest' })
    ).rejects.toThrow(/already seen revision 1/);
    expect(inventoryStore).toHaveLength(0);
    expect(slotPublishes).toHaveLength(1);

    // Once they catch up, the same harvest goes through on top of the right base.
    inventoryStore.push(...written);
    await result.current.act({ mapId: MAP, record: record(readyCarrot({ x: 2, y: 2 }), PLOT_2), type: 'harvest' });
    expect(carrotQuantity()).toBe(2);
  });

  it('refuses an older snapshot than the one it has seen', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });
    await result.current.act({ mapId: MAP, record: record(readyCarrot({ x: 2, y: 2 }), PLOT_2), type: 'harvest' });
    expect(inventoryStore).toHaveLength(2);

    inventoryStore.splice(1, 1);

    await expect(
      result.current.act({ mapId: MAP, record: record(readyCarrot({ x: 3, y: 3 }), 'h'.repeat(64)), type: 'harvest' })
    ).rejects.toThrow(/revision 1, but this device has already seen revision 2/);
    expect(inventoryStore).toHaveLength(1);
  });
});
