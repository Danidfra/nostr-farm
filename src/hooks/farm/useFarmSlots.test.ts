import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { plantSeed } from '@/farm/growth/evaluate';
import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { buildSlotState, collectOwnedSlots } from '@/nostr/slot-state';
import { slotAddress } from '@/nostr/identifiers';
import { readSlot, readSlotRecord, type FarmSlots } from './useFarmSlots';

const OWNER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const MAP = 'farm.field';
const T0 = 1_700_000_000;

const planted: FarmSlot = { coord: { x: 3, y: 2 }, content: { type: 'plant', plant: plantSeed('carrot', T0) } };

function event(slot: FarmSlot, pubkey: string, createdAt: number, id: string): NostrEvent {
  return {
    ...buildSlotState({ mapId: MAP, ownerPubkey: pubkey, slot }),
    id,
    pubkey,
    created_at: createdAt,
    sig: 'x'.repeat(128),
  };
}

/** Exactly what the query builds from the collected events. */
function toSlots(events: NostrEvent[]): FarmSlots {
  const owned = collectOwnedSlots(events, OWNER, MAP);
  const byAddress = new Map<string, { slot: FarmSlot; sourceEventId?: string }>();
  for (const [address, state] of owned) byAddress.set(address, { slot: state.slot, sourceEventId: state.event.id });
  return { byAddress };
}

describe('source event identity in the read model', () => {
  it('retains the id of the authoritative event', () => {
    const slots = toSlots([event(planted, OWNER, T0, 'e'.repeat(64))]);
    expect(readSlotRecord(slots, MAP, 3, 2).sourceEventId).toBe('e'.repeat(64));
  });

  it('retains the NEWEST event id, which is the one harvest consumes', () => {
    const slots = toSlots([
      event(planted, OWNER, T0, '1'.repeat(64)),
      event(planted, OWNER, T0 + 100, '2'.repeat(64)),
    ]);
    expect(readSlotRecord(slots, MAP, 3, 2).sourceEventId).toBe('2'.repeat(64));
  });

  it('still rejects events authored by anybody but the owner', () => {
    const slots = toSlots([event(planted, STRANGER, T0 + 999, 'f'.repeat(64))]);
    expect(slots.byAddress.size).toBe(0);
    expect(readSlotRecord(slots, MAP, 3, 2).sourceEventId).toBeUndefined();
  });

  it('prefers the owner event even when a stranger published a newer one', () => {
    const slots = toSlots([
      event(planted, OWNER, T0, '1'.repeat(64)),
      event(planted, STRANGER, T0 + 999, 'f'.repeat(64)),
    ]);
    expect(readSlotRecord(slots, MAP, 3, 2).sourceEventId).toBe('1'.repeat(64));
  });

  it('has no source id for a cell that was never written', () => {
    const record = readSlotRecord(toSlots([]), MAP, 0, 0);
    expect(record.sourceEventId).toBeUndefined();
    expect(record.slot).toEqual(emptySlot({ x: 0, y: 0 }));
  });

  it('keys records by the full slot address', () => {
    const slots = toSlots([event(planted, OWNER, T0, 'e'.repeat(64))]);
    expect([...slots.byAddress.keys()]).toEqual([slotAddress(MAP, 3, 2)]);
  });
});

describe('readSlot still returns the pure domain value', () => {
  it('gives the plant for rendering, with no event metadata attached', () => {
    const slots = toSlots([event(planted, OWNER, T0, 'e'.repeat(64))]);
    const slot = readSlot(slots, MAP, 3, 2);

    expect(slot.content.type).toBe('plant');
    expect(Object.keys(slot).sort()).toEqual(['content', 'coord']);
  });
});
