import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { plantSeed, waterPlant } from '@/farm/growth/evaluate';
import { CROP_CATALOG } from '@/farm/crops/catalog';
import { systemClock } from '@/farm/time';
import type { FarmSlot } from '@/farm/slots/types';
import { INVENTORY_KINDS, KIND_GAME_INVENTORY } from '@/inventory/package';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { eventId, foldEvent, foldRefs, foldTag, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';
import { buildSlotState } from '@/nostr/slot-state';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { reqOverStore } from '@/test/fake-relay';

const OWNER = 'a'.repeat(64);
const MAP = 'farm.field';
const PLANT_EVENT = 'c'.repeat(64);

/** Events published through the SLOT path (kind 31417). */
const slotPublishes: { kind?: number; tags?: string[][]; replaces?: { created_at: number } }[] = [];
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
/** When set, inventory reads fail (no relay answers). */
let inventoryReadFails = false;
/** Run once, right after the next accepted kind:31633 lands: what "another device" does meanwhile. */
let afterCreditLands: (() => void) | null = null;

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
    mutateAsync: async (template: { kind?: number; tags?: string[][]; replaces?: { created_at: number } }) => {
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
        // Every read is a REQ read until EOSE. Plot reads and ledger reads
        // fail independently, the way the scenarios need them to.
        req: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => {
          if (filters[0].kinds?.[0] === KIND_SLOT_STATE) {
            return reqOverStore(() => slotStore, () => ({ eose: slotReadEose }))(filters, opts);
          }
          if (inventoryReadFails) {
            return (async function* (): AsyncGenerator<never> {
              yield* [];
              throw new Error('relay down');
            })();
          }
          return reqOverStore(() => [...inventoryStore, ...foldStore, ...spendStore])(filters, opts);
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
          // The scenario decides the outcome once per event, not once per relay.
          if (inventoryStore.some((existing) => existing.id === event.id)) return;
          if (inventoryPublishOutcome === 'accepted') {
            store(event);
            const meanwhile = afterCreditLands;
            afterCreditLands = null;
            meanwhile?.();
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
  inventoryReadFails = false;
  afterCreditLands = null;
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

describe('feedback for a harvest that was already credited (F-05)', () => {
  it('a retry that only finishes the clear says so instead of showing +1', async () => {
    slotPublishFails = true;
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const slot = readyCarrot();
    await expect(result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' })).rejects.toThrow();
    slotPublishFails = false;
    toasts.length = 0;

    const outcome = await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });

    expect(outcome?.alreadyCredited).toBe(true);
    expect(carrotQuantity()).toBe(1);
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0].title?.startsWith('+1')).toBe(false);
    expect((toasts[0] as { description?: string }).description).toMatch(/Already in your basket/);
  });

  it('a first harvest still shows +1', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    const outcome = await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });

    expect(outcome?.alreadyCredited).toBeUndefined();
    await waitFor(() => expect(toasts.some((t) => t.title?.startsWith('+1'))).toBe(true));
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

describe('slot writes name the event they replace, so the publish can stamp after it', () => {
  it('a watering names the plot event it re-read, not the older one this device had', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const dry: FarmSlot = { coord: { x: 0, y: 0 }, content: { type: 'plant', plant: plantSeed('carrot', systemClock.now()) } };
    const onRelays = onRelay(dry, PLANT_EVENT, systemClock.now() + 7);

    await result.current.act({ mapId: MAP, record: { slot: dry, sourceEventId: PLANT_EVENT, sourceCreatedAt: onRelays.created_at - 100 }, type: 'water' });

    expect(slotPublishes[0].replaces?.created_at).toBe(onRelays.created_at);
  });

  it('a planting names the bare plot event the relays hold', async () => {
    const bare = onRelay({ coord: { x: 3, y: 3 }, content: { type: 'empty' } }, 'b'.repeat(64), systemClock.now());
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: { slot: { coord: { x: 3, y: 3 }, content: { type: 'empty' } } }, type: 'plant', cropId: 'carrot' });

    expect(slotPublishes[0].replaces?.created_at).toBe(bare.created_at);
  });

  it('the clear after a harvest names the plant event it re-read', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });
    const ripe = record(readyCarrot());
    const onRelays = slotStore.find((event) => event.id === PLANT_EVENT)!;

    await result.current.act({ mapId: MAP, record: ripe, type: 'harvest' });

    expect(slotPublishes[0].replaces?.created_at).toBe(onRelays.created_at);
  });
});

describe('watering and clearing re-read the plot first (F-02)', () => {
  const coord = { x: 4, y: 4 };
  const seedling = (plantedAt: number): FarmSlot => ({ coord, content: { type: 'plant', plant: plantSeed('carrot', plantedAt) } });
  const rotten = (plantedAt: number): FarmSlot => {
    const crop = CROP_CATALOG.carrot;
    return {
      coord,
      content: { type: 'plant', plant: { cropId: 'carrot', plantedAt, growthSec: 0, growthUpdatedAt: plantedAt, wetUntil: systemClock.now() - crop.rotAfterDrySec - 10 } },
    };
  };

  it('refuses to water, and publishes nothing, when a relay did not finish answering', async () => {
    const mine = record(seedling(systemClock.now() - 60));
    slotReadEose = false;
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(result.current.act({ mapId: MAP, record: mine, type: 'water' })).rejects.toThrow(/did not finish answering/);
    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses to water a stale copy of a planting another device has replaced', async () => {
    // This device still shows the old seedling; meanwhile the plot was
    // harvested and replanted elsewhere. Republishing the old copy would bring
    // the old planting back over the new one.
    const stale = seedling(systemClock.now() - 120);
    onRelay(seedling(systemClock.now() - 30), PLANT_EVENT);
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(result.current.act({ mapId: MAP, record: { slot: stale, sourceEventId: PLANT_EVENT }, type: 'water' })).rejects.toThrow(
      /changed from another device/
    );
    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses to clear a stale rotten copy when the plot holds a newer planting', async () => {
    const stale = rotten(systemClock.now() - 100_000);
    onRelay(seedling(systemClock.now() - 30), PLANT_EVENT);
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(result.current.act({ mapId: MAP, record: { slot: stale, sourceEventId: PLANT_EVENT }, type: 'clear' })).rejects.toThrow(
      /changed from another device/
    );
    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses when every relay answered and none holds the plot', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(
      result.current.act({ mapId: MAP, record: { slot: seedling(systemClock.now() - 60), sourceEventId: PLANT_EVENT }, type: 'water' })
    ).rejects.toThrow(/nothing for this plot/);
    expect(slotPublishes).toHaveLength(0);
  });

  it('waters the planting as the relays hold it', async () => {
    const mine = record(seedling(systemClock.now() - 60));
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: mine, type: 'water' });

    expect(slotPublishes).toHaveLength(1);
    expect(slotPublishes[0].tags).toContainEqual(['type', 'plant']);
  });
});

describe('planting acts on absence, so the absence is confirmed first', () => {
  const empty: FarmSlot = { coord: { x: 2, y: 2 }, content: { type: 'empty' } };

  it('refuses to plant, and publishes nothing, when a relay did not finish answering about the plot', async () => {
    // The plot looks bare on this device, but the relays closed the read
    // before EOSE: "nothing arrived" is not "nothing is planted there".
    slotReadEose = false;
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(result.current.act({ mapId: MAP, record: { slot: empty }, type: 'plant', cropId: 'carrot' })).rejects.toThrow(
      /not known to be free/
    );

    expect(slotPublishes).toHaveLength(0);
  });

  it('refuses to plant over a crop the relays hold, even though this device shows the plot as bare', async () => {
    // Another device (or another relay this device had not read) planted here.
    onRelay({ coord: empty.coord, content: { type: 'plant', plant: plantSeed('strawberry', systemClock.now() - 50) } }, 'd'.repeat(64));
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await expect(result.current.act({ mapId: MAP, record: { slot: empty }, type: 'plant', cropId: 'carrot' })).rejects.toThrow();

    expect(slotPublishes).toHaveLength(0);
  });

  it('plants on a plot every relay confirmed bare', async () => {
    const { result } = renderHook(() => useFarmActions(), { wrapper });

    await result.current.act({ mapId: MAP, record: { slot: empty }, type: 'plant', cropId: 'carrot' });

    expect(slotPublishes).toHaveLength(1);
    expect(slotPublishes[0].tags).toContainEqual(['type', 'plant']);
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

describe('post-write verification', () => {
  const PUMPKIN = PRODUCE_CATALOG.pumpkin.address;
  const verified = () => renderHook(() => useFarmActions({ verifyDelayMs: 0 }), { wrapper });
  const verifyToasts = () => toasts.filter((t) => t.title?.startsWith('Harvest')).map((t) => t.title);
  const newestSnapshot = () => [...inventoryStore].sort((a, b) => b.created_at - a.created_at)[0];

  it('confirms a credit the relays still show, without saying anything more', async () => {
    const { result } = verified();

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });
    await waitFor(() => expect(result.current.lastVerification?.status).toBe('confirmed'));

    expect(verifyToasts()).toEqual([]);
    expect(inventoryStore).toHaveLength(1);
  });

  it('re-credits a harvest another device overwrote, once, under the same identity', async () => {
    const { result } = verified();
    afterCreditLands = () => {
      // Another device, from an older (empty) base, publishes a newer snapshot: ours is gone.
      inventoryStore.push(snapshotEvent({ id: eventId('race'), items: { [PUMPKIN]: 1 }, revision: 1, createdAt: systemClock.now() + 5 }));
    };

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });
    await waitFor(() => expect(result.current.lastVerification?.status).toBe('recredited'));

    expect(verifyToasts()).toEqual(['Harvest saved again']);
    expect(inventoryStore).toHaveLength(3);
    const final = newestSnapshot();
    const quantity = (address: string) => Number(final.tags.find((t) => t[0] === 'a' && t[1] === address)?.[3] ?? 0);
    expect(quantity(PRODUCE_CATALOG.carrot.address)).toBe(1);
    expect(quantity(PUMPKIN)).toBe(1);
    expect(final.tags).toContainEqual(['harvest', `slot:${MAP}:1:1`, expect.any(String)]);
    expect(final.tags.find((t) => t[0] === 'revision')?.[1]).toBe('2');
  });

  it('reports an unconfirmed credit when the relays cannot be read, and never re-credits', async () => {
    const { result } = verified();
    afterCreditLands = () => {
      inventoryReadFails = true;
    };

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });
    await waitFor(() => expect(result.current.lastVerification?.status).toBe('uncertain'));

    expect(verifyToasts()).toEqual(['Harvest not yet confirmed']);
    expect(inventoryStore).toHaveLength(1);
  });

  it('reports a lost harvest when the one re-credit is refused, rather than retrying', async () => {
    const { result } = verified();
    afterCreditLands = () => {
      inventoryStore.push(snapshotEvent({ id: eventId('race'), items: { [PUMPKIN]: 1 }, revision: 1, createdAt: systemClock.now() + 5 }));
      inventoryPublishOutcome = 'rejected';
    };

    await result.current.act({ mapId: MAP, record: record(readyCarrot()), type: 'harvest' });
    await waitFor(() => expect(result.current.lastVerification?.status).toBe('lost'));

    expect(verifyToasts()).toEqual(['Harvest may be missing']);
    expect(toasts.at(-1)?.variant).toBe('destructive');
    expect(inventoryStore).toHaveLength(2);
  });

  it('does not verify a harvest that was already credited, because nothing was written', async () => {
    const { result } = verified();
    const slot = readyCarrot();
    await result.current.act({ mapId: MAP, record: record(slot), type: 'harvest' });
    await waitFor(() => expect(result.current.lastVerification?.status).toBe('confirmed'));
    toasts.length = 0;

    // A zombie of the same planting: cleared without a credit, so no verification follows.
    const plant = (slot.content as { plant: ReturnType<typeof plantSeed> }).plant;
    const zombie: FarmSlot = { ...slot, content: { type: 'plant', plant: waterPlant(plant, systemClock.now(), CROP_CATALOG.carrot) } };
    onRelay(zombie, 'f'.repeat(64), systemClock.now() + 100);
    await result.current.act({ mapId: MAP, record: { slot: zombie, sourceEventId: 'f'.repeat(64) }, type: 'harvest' });

    expect(inventoryStore).toHaveLength(1);
    expect(verifyToasts()).toEqual([]);
  });
});
