import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { plantSeed } from '@/farm/growth/evaluate';
import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { mapRef, slotAddress } from './identifiers';
import { KIND_SLOT_STATE } from './kinds';
import { buildSlotState, collectOwnedSlots, parseSlotState } from './slot-state';

const OWNER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const MAP_ID = 'farm.field';
const T0 = 1_800_000_000;

function sign(template: { kind: number; content: string; tags: string[][] }, pubkey = OWNER, createdAt = T0, id = '0'.repeat(64)): NostrEvent {
  return { ...template, id, pubkey, created_at: createdAt, sig: 'x'.repeat(128) };
}

const plantedSlot: FarmSlot = { coord: { x: 3, y: 2 }, content: { type: 'plant', plant: plantSeed('carrot', T0) } };

describe('slot state round trip', () => {
  it('preserves a planted slot exactly', () => {
    const event = sign(buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: plantedSlot }));
    const parsed = parseSlotState(event);

    expect(parsed?.slot).toEqual(plantedSlot);
    expect(parsed?.mapId).toBe(MAP_ID);
    expect(parsed?.id).toBe(slotAddress(MAP_ID, 3, 2));
  });

  it('preserves an empty slot with its harvest timestamp', () => {
    const slot = emptySlot({ x: 0, y: 0 }, T0 + 42);
    const parsed = parseSlotState(sign(buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot })));

    expect(parsed?.slot).toEqual(slot);
  });

  it('writes no derived fields', () => {
    const tags = buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: plantedSlot }).tags.map(([name]) => name);

    for (const derived of ['stage', 'ready_at', 'expires_at', 'watered_at', 'water_count', 'status']) {
      expect(tags).not.toContain(derived);
    }
  });
});

describe('personal-farm authority', () => {
  it('rejects a slot whose parent map belongs to somebody else', () => {
    const template = buildSlotState({ mapId: MAP_ID, ownerPubkey: STRANGER, slot: plantedSlot });
    expect(parseSlotState(sign(template, OWNER))).toBeNull();
  });

  it('rejects a slot with no addressable parent reference', () => {
    const template = buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: plantedSlot });
    template.tags = template.tags.filter(([name]) => name !== 'a');
    expect(parseSlotState(sign(template))).toBeNull();
  });

  it('rejects a slot whose `slot` tag disagrees with its address', () => {
    const template = buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: plantedSlot });
    template.tags = template.tags.map((tag) => (tag[0] === 'slot' ? ['slot', '9', '9'] : tag));
    expect(parseSlotState(sign(template))).toBeNull();
  });

  it('rejects a slot address that does not name its own parent map', () => {
    const template = buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: plantedSlot });
    template.tags = template.tags.map((tag) => (tag[0] === 'd' ? ['d', slotAddress('other.map', 3, 2)] : tag));
    expect(parseSlotState(sign(template))).toBeNull();
  });

  it('rejects a map id containing a colon, which would make the address ambiguous', () => {
    const template = buildSlotState({ mapId: 'a:b', ownerPubkey: OWNER, slot: plantedSlot });
    expect(parseSlotState(sign(template))).toBeNull();
  });
});

describe('collectOwnedSlots', () => {
  const ownerEvent = sign(buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: plantedSlot }), OWNER, T0, '1'.repeat(64));

  it('ignores events authored by anyone but the owner', () => {
    const impostor = sign(
      buildSlotState({ mapId: MAP_ID, ownerPubkey: STRANGER, slot: { coord: { x: 3, y: 2 }, content: { type: 'plant', plant: plantSeed('pumpkin', T0) } } }),
      STRANGER,
      T0 + 10_000,
      '2'.repeat(64)
    );

    const owned = collectOwnedSlots([ownerEvent, impostor], OWNER, MAP_ID);
    expect(owned.size).toBe(1);

    const slot = owned.get(slotAddress(MAP_ID, 3, 2));
    expect(slot?.slot.content).toEqual({ type: 'plant', plant: plantSeed('carrot', T0) });
  });

  it('keeps the newest event per address', () => {
    const newer = sign(
      buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: { coord: { x: 3, y: 2 }, content: { type: 'plant', plant: plantSeed('pumpkin', T0) } } }),
      OWNER,
      T0 + 60,
      '3'.repeat(64)
    );

    const owned = collectOwnedSlots([ownerEvent, newer], OWNER, MAP_ID);
    const slot = owned.get(slotAddress(MAP_ID, 3, 2));
    expect((slot?.slot.content as { plant: { cropId: string } }).plant.cropId).toBe('pumpkin');
  });

  it('breaks a created_at tie on the lowest event id, as NIP-01 requires', () => {
    const tie = sign(
      buildSlotState({ mapId: MAP_ID, ownerPubkey: OWNER, slot: { coord: { x: 3, y: 2 }, content: { type: 'plant', plant: plantSeed('pumpkin', T0) } } }),
      OWNER,
      T0,
      '0'.repeat(64)
    );

    const owned = collectOwnedSlots([ownerEvent, tie], OWNER, MAP_ID);
    expect((owned.get(slotAddress(MAP_ID, 3, 2))?.slot.content as { plant: { cropId: string } }).plant.cropId).toBe('pumpkin');
  });

  it('ignores slots belonging to another map', () => {
    expect(collectOwnedSlots([ownerEvent], OWNER, 'other.map').size).toBe(0);
  });

  it('ignores events of the wrong kind', () => {
    const wrongKind = { ...ownerEvent, kind: KIND_SLOT_STATE + 1 };
    expect(collectOwnedSlots([wrongKind], OWNER, MAP_ID).size).toBe(0);
  });
});

describe('map reference helper', () => {
  it('builds an addressable coordinate', () => {
    expect(mapRef(OWNER, MAP_ID)).toBe(`31416:${OWNER}:${MAP_ID}`);
  });
});
