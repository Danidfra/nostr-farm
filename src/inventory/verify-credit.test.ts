import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { CARROT, OWNER, PUMPKIN_ADDRESS, RELAY, eventId, snapshotEvent } from '@/test/inventory-fixtures';
import { verifyCredit } from './verify-credit';

const PLOT = 'slot:farm.field:3:2';
const identity = { consumedEventId: 'c'.repeat(64), planting: { slotD: PLOT, plantedAt: 1_699_990_000 } };

/** The snapshot "we" wrote: revision 2, with our record. */
const written = snapshotEvent({
  id: eventId('ours'),
  createdAt: 1_700_000_100,
  revision: 2,
  items: { [CARROT.address]: 1 },
  extraTags: [['e', identity.consumedEventId, RELAY, 'farm-harvest'], ['harvest', PLOT, String(identity.planting.plantedAt)]],
});

function relays(events: NostrEvent[], answered = true) {
  return { ownerPubkey: OWNER, readInventory: async () => ({ events, answered, anchored: answered, complete: answered }) };
}

describe('verifyCredit', () => {
  it('confirms when the relays\' newest snapshot is the one we wrote', async () => {
    expect((await verifyCredit(relays([written]), written, identity)).status).toBe('confirmed');
  });

  it('confirms when a later snapshot carries our record, however it got there', async () => {
    const later = snapshotEvent({
      id: eventId('later'),
      createdAt: 1_700_000_200,
      revision: 3,
      items: { [CARROT.address]: 1, [PUMPKIN_ADDRESS]: 1 },
      extraTags: [['harvest', PLOT, String(identity.planting.plantedAt)]],
    });
    expect((await verifyCredit(relays([written, later]), written, identity)).status).toBe('confirmed');
  });

  it('confirms when a later snapshot credits a newer cycle of the same plot', async () => {
    const later = snapshotEvent({
      id: eventId('later'),
      createdAt: 1_700_000_200,
      revision: 3,
      items: { [CARROT.address]: 2 },
      extraTags: [['harvest', PLOT, String(identity.planting.plantedAt + 5)]],
    });
    expect((await verifyCredit(relays([later]), written, identity)).status).toBe('confirmed');
  });

  it('reports overwritten when a newer snapshot lacks our record', async () => {
    const competing = snapshotEvent({ id: eventId('race'), createdAt: 1_700_000_105, revision: 2, items: { [PUMPKIN_ADDRESS]: 1 } });
    const result = await verifyCredit(relays([written, competing]), written, identity);
    expect(result.status).toBe('overwritten');
    if (result.status === 'overwritten') expect(result.newest.event.id).toBe(eventId('race'));
  });

  it('is uncertain, not overwritten, when the relays return an older snapshot', async () => {
    const older = snapshotEvent({ id: eventId('old'), createdAt: 1_700_000_000, revision: 1 });
    const result = await verifyCredit(relays([older]), written, identity);
    expect(result).toMatchObject({ status: 'uncertain', reason: expect.stringMatching(/older/) });
  });

  it('is uncertain when a same-time snapshot carries a lower revision', async () => {
    const lower = snapshotEvent({ id: eventId('low'), createdAt: 1_700_000_100, revision: 1 });
    expect((await verifyCredit(relays([lower]), written, identity)).status).toBe('uncertain');
  });

  it('is uncertain when nothing came back, or no relay answered, or the read threw', async () => {
    expect((await verifyCredit(relays([]), written, identity)).status).toBe('uncertain');
    expect((await verifyCredit(relays([written], false), written, identity)).status).toBe('uncertain');
    const throwing = { ownerPubkey: OWNER, readInventory: async (): Promise<never> => { throw new Error('socket closed'); } };
    expect(await verifyCredit(throwing, written, identity)).toMatchObject({ status: 'uncertain', reason: 'socket closed' });
  });
});
