import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { plantSeed } from '@/farm/growth/evaluate';
import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { buildSlotState, collectOwnedSlots } from '@/nostr/slot-state';
import { slotAddress } from '@/nostr/identifiers';
import { GAME_RELAY_URLS, PRIMARY_RELAY_URL, REQUIRED_GAME_RELAY_URLS } from '@/nostr/relays';
import { relaySync } from '@/nostr/relay-sync';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { FieldUnreadableError, readFarmField, readSlot, readSlotRecord, type FarmSlots } from './useFarmSlots';

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

describe('readFarmField: the field is read from every game relay, never from the first alone', () => {
  const carrot = event(planted, OWNER, T0, '1'.repeat(64));

  function relays() {
    const network = new FakeRelayNetwork();
    return { network, read: (previous?: FarmSlots) => readFarmField(network.pool, OWNER, MAP, previous) };
  }

  it('shows a crop the primary relay does not hold: an empty primary relay is not a bare field', async () => {
    const { network, read } = relays();
    network.seed(carrot);
    network.withhold(PRIMARY_RELAY_URL, carrot.id);

    const field = await read();

    expect(readSlotRecord(field, MAP, 3, 2).sourceEventId).toBe(carrot.id);
    expect(readSlot(field, MAP, 3, 2).content.type).toBe('plant');
    expect(field.complete).toBe(true);
  });

  it('takes the newest revision of a plot wherever it came from, including a secondary relay', async () => {
    const { network, read } = relays();
    const cleared = event({ coord: planted.coord, content: { type: 'empty' } }, OWNER, T0 + 50, '2'.repeat(64));
    network.seed(carrot, cleared);
    // The primary relay holds only the older planting; the newer state is elsewhere.
    network.withhold(PRIMARY_RELAY_URL, cleared.id);
    for (const relay of REQUIRED_GAME_RELAY_URLS) network.withhold(relay, carrot.id);

    const field = await read();

    expect(readSlotRecord(field, MAP, 3, 2).sourceEventId).toBe(cleared.id);
    expect(readSlot(field, MAP, 3, 2).content.type).toBe('empty');
  });

  it('sends no EVENT while reading: the primary relay lacking a plot is left as it is until the account says otherwise', async () => {
    const { network, read } = relays();
    const lacking = event(planted, OWNER, T0, '8'.repeat(64));
    network.seed(lacking);
    network.withhold(PRIMARY_RELAY_URL, lacking.id);

    const field = await read();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(readSlotRecord(field, MAP, 3, 2).sourceEventId).toBe(lacking.id);
    expect(network.offers).toEqual([]);
  });

  it('once the account turned copying on, offers the primary relay the plot it lacks, and nothing to the relays that have it', async () => {
    relaySync.consent.enable(OWNER, GAME_RELAY_URLS);
    onTestFinished(() => relaySync.consent.disable(OWNER));
    const { network, read } = relays();
    // Its own id: the app's ledger remembers what it already carried, across reads.
    const carried = event(planted, OWNER, T0, '9'.repeat(64));
    network.seed(carried);
    network.withhold(PRIMARY_RELAY_URL, carried.id);

    await read();

    await vi.waitFor(() => expect(network.acceptedBy(PRIMARY_RELAY_URL)).toEqual([carried]));
    expect(network.offers).toHaveLength(1);
  });

  it('is not complete when the primary relay did not answer, so a plot with no record is not proven bare', async () => {
    const { network, read } = relays();
    network.seed(carrot);
    network.closeBeforeEose(PRIMARY_RELAY_URL);

    const field = await read();

    expect(readSlot(field, MAP, 3, 2).content.type).toBe('plant');
    expect(field.complete).toBe(false);
  });

  it('refuses to show an empty field when the relay the farm is written to did not answer', async () => {
    const { network, read } = relays();
    // The primary relay answers, with nothing; the required relay closes first.
    for (const relay of REQUIRED_GAME_RELAY_URLS) network.closeBeforeEose(relay);

    await expect(read()).rejects.toBeInstanceOf(FieldUnreadableError);
  });

  it('keeps the last known field when the relay the farm is written to stops answering', async () => {
    const { network, read } = relays();
    network.seed(carrot);
    const known = await read();

    network.withhold(PRIMARY_RELAY_URL, carrot.id);
    for (const relay of REQUIRED_GAME_RELAY_URLS) {
      network.withhold(relay, carrot.id);
      network.closeBeforeEose(relay);
    }
    const field = await read(known);

    expect(readSlotRecord(field, MAP, 3, 2).sourceEventId).toBe(carrot.id);
    expect(field.complete).toBe(false);
  });

  it('does not let an older copy on the primary relay move a plot backwards while the required relay is silent', async () => {
    const { network, read } = relays();
    const cleared = event({ coord: planted.coord, content: { type: 'empty' } }, OWNER, T0 + 50, '2'.repeat(64));
    network.seed(carrot, cleared);
    const known = await read();
    expect(readSlotRecord(known, MAP, 3, 2).sourceEventId).toBe(cleared.id);

    network.withhold(PRIMARY_RELAY_URL, cleared.id);
    for (const relay of REQUIRED_GAME_RELAY_URLS) network.closeBeforeEose(relay);
    for (const relay of REQUIRED_GAME_RELAY_URLS) network.withhold(relay, carrot.id, cleared.id);
    const field = await read(known);

    expect(readSlotRecord(field, MAP, 3, 2).sourceEventId).toBe(cleared.id);
  });
});
