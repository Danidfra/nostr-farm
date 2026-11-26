import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NPool, NostrEvent } from '@nostrify/nostrify';

import { FakeRelayNetwork } from '@/test/fake-relay';
import { CARROT, OWNER, eventId, foldEvent, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';
import { PRIMARY_RELAY_URL } from '@/nostr/relays';
import { relaySync } from '@/nostr/relay-sync';
import { creditHarvest, type CreditDeps } from '@/inventory/credit-harvest';
import { selectNewestInventory } from '@/inventory/farm-inventory';
import {
  INVENTORY_RELAYS,
  INVENTORY_RELAY_HINT,
  INVENTORY_SECONDARY_RELAYS,
  farmInventoryReadDeps,
  isIndefinite,
  publishFarmInventory,
  readFarmInventory,
  readFarmSpends,
} from './inventory-relays';

/**
 * The inventory flow over the primary relay and the cross-client secondaries,
 * against in-memory relays and synthetic events only.
 */
const PILOT_REFUSAL = 'blocked: this relay is in pilot mode; author is not on the write list';

function relays() {
  const network = new FakeRelayNetwork();
  return { network, nostr: network.pool as unknown as NPool };
}

describe('the inventory relay table', () => {
  it('asks the primary relay first and keeps the relays the inventory was always saved on', () => {
    expect(INVENTORY_RELAYS[0]).toBe(PRIMARY_RELAY_URL);
    expect(INVENTORY_RELAYS.slice(1)).toEqual(INVENTORY_SECONDARY_RELAYS);
    expect(INVENTORY_SECONDARY_RELAYS).not.toContain(PRIMARY_RELAY_URL);
  });

  it('hints at a relay the event is certainly on, not at the primary relay', () => {
    expect(INVENTORY_SECONDARY_RELAYS).toContain(INVENTORY_RELAY_HINT);
  });
});

describe('reading farm:main', () => {
  it('returns the newest snapshot even when only a secondary relay holds it', async () => {
    const { network, nostr } = relays();
    const older = snapshotEvent({ id: eventId('old'), revision: 1, createdAt: 100, items: { [CARROT.address]: 1 } });
    const newer = snapshotEvent({ id: eventId('new'), revision: 2, createdAt: 200, items: { [CARROT.address]: 2 } });
    network.seed(older, newer);
    network.withhold(PRIMARY_RELAY_URL, newer.id);

    const read = await readFarmInventory(nostr, OWNER)();

    expect(selectNewestInventory(read.events, OWNER)?.revision).toBe(2);
    expect(read).toMatchObject({ answered: true, anchored: true, complete: true });
  });

  it('does not count a relay that closed the subscription as having answered "empty"', async () => {
    const { network, nostr } = relays();
    for (const relay of INVENTORY_SECONDARY_RELAYS) network.closeBeforeEose(relay);

    const read = await readFarmInventory(nostr, OWNER)();

    // Only the primary relay reached EOSE, and it holds nothing.
    expect(read.events).toEqual([]);
    expect(read).toMatchObject({ answered: true, anchored: false, complete: false });
  });

  it('is unanswered when no relay reached EOSE, whatever arrived before', async () => {
    const { network, nostr } = relays();
    network.seed(snapshotEvent({ id: eventId('snap') }));
    for (const relay of INVENTORY_RELAYS) network.closeBeforeEose(relay);

    const read = await readFarmInventory(nostr, OWNER)();

    expect(read).toMatchObject({ answered: false, anchored: false, complete: false });
  });

  it('keeps every spend, from whichever relay has it: history is merged by id, not replaced', async () => {
    const { network, nostr } = relays();
    const a = spendEvent({ id: eventId('sa'), createdAt: 10 });
    const b = spendEvent({ id: eventId('sb'), createdAt: 20 });
    const c = spendEvent({ id: eventId('sc'), createdAt: 30 });
    network.seed(a, b, c);
    network.withhold(PRIMARY_RELAY_URL, a.id, b.id);
    network.withhold(INVENTORY_SECONDARY_RELAYS[0], c.id);
    network.withhold(INVENTORY_SECONDARY_RELAYS[1], a.id);

    const read = await readFarmSpends(nostr, OWNER)();

    expect(read.events.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });
});

describe('reading the ledger sends nothing until the account turns copying on', () => {
  it('a restored session reads a snapshot, spends and manifests the primary relay lacks, and no relay receives an EVENT', async () => {
    const { network, nostr } = relays();
    const snap = snapshotEvent({ id: eventId('ro-snap'), revision: 3, createdAt: 300, fold: { eventId: eventId('ro-m1') } });
    const fold = foldEvent({ id: eventId('ro-m1'), createdAt: 250, spends: [eventId('ro-s1')] });
    const spend = spendEvent({ id: eventId('ro-s1'), createdAt: 200 });
    network.seed(snap, fold, spend);
    network.withhold(PRIMARY_RELAY_URL, snap.id, fold.id, spend.id);
    const deps = farmInventoryReadDeps(nostr, OWNER);

    const read = await deps.readInventory();
    await deps.readSpends();
    await deps.readFolds();
    await deps.readFoldsById([{ eventId: fold.id, relay: '' }]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(selectNewestInventory(read.events, OWNER)?.revision).toBe(3);
    expect(network.offers).toEqual([]);
  });
});

describe('carrying the ledger to the relays that lack it, once the account turned copying on', () => {
  afterEach(() => relaySync.consent.disable(OWNER));

  it('offers the newest snapshot to the primary relay when only the secondaries hold it', async () => {
    relaySync.consent.enable(OWNER, INVENTORY_RELAYS);
    const { network, nostr } = relays();
    const older = snapshotEvent({ id: eventId('carry-old'), revision: 1, createdAt: 100 });
    const newer = snapshotEvent({ id: eventId('carry-new'), revision: 2, createdAt: 200 });
    network.seed(older, newer);
    network.withhold(PRIMARY_RELAY_URL, older.id, newer.id);

    await readFarmInventory(nostr, OWNER)();

    await vi.waitFor(() => expect(network.acceptedBy(PRIMARY_RELAY_URL)).toEqual([newer]));
    // The superseded revision is never carried, and nothing goes to a relay that has it.
    expect(network.offers).toHaveLength(1);
  });

  it('completes a fold chain on the primary relay: every manifest it lacks is offered', async () => {
    relaySync.consent.enable(OWNER, INVENTORY_RELAYS);
    const { network, nostr } = relays();
    const m1 = foldEvent({ id: eventId('chain-m1'), createdAt: 10, spends: [eventId('chain-s1')] });
    const m2 = foldEvent({ id: eventId('chain-m2'), createdAt: 20, previous: { eventId: m1.id }, spends: [eventId('chain-s2')] });
    network.seed(m1, m2);
    network.withhold(PRIMARY_RELAY_URL, m1.id, m2.id);

    await farmInventoryReadDeps(nostr, OWNER).readFolds();

    await vi.waitFor(() => expect(network.acceptedBy(PRIMARY_RELAY_URL).map((e) => e.id).sort()).toEqual([m1.id, m2.id].sort()));
  });

  it('carries nothing to a relay that did not finish its answer', async () => {
    relaySync.consent.enable(OWNER, INVENTORY_RELAYS);
    const { network, nostr } = relays();
    const snap = snapshotEvent({ id: eventId('carry-closed'), revision: 1, createdAt: 100 });
    network.seed(snap);
    network.withhold(PRIMARY_RELAY_URL, snap.id);
    network.closeBeforeEose(PRIMARY_RELAY_URL);

    await readFarmInventory(nostr, OWNER)();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(network.offers).toEqual([]);
  });

  it("carries nothing that somebody else signed, even when it names this player's inventory", async () => {
    relaySync.consent.enable(OWNER, INVENTORY_RELAYS);
    const { network, nostr } = relays();
    const foreign = spendEvent({ id: eventId('carry-foreign'), pubkey: 'b'.repeat(64) });
    network.seed(foreign);
    network.withhold(PRIMARY_RELAY_URL, foreign.id);

    await readFarmSpends(nostr, OWNER)();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(network.offers).toEqual([]);
  });
});

describe('publishing to the inventory relays', () => {
  const snap = (label: string): NostrEvent => snapshotEvent({ id: eventId(label), revision: 1, createdAt: 100 });

  it('reads the pilot write-list refusal as a definite "no", not as silence', () => {
    expect(isIndefinite(new Error(PILOT_REFUSAL))).toBe(false);
    expect(isIndefinite(new Error('invalid: event too large'))).toBe(false);
    // A refusal stays a refusal whatever words follow the prefix.
    expect(isIndefinite(new Error('blocked: write list lookup timeout'))).toBe(false);
    expect(isIndefinite(new Error('timeout'))).toBe(true);
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(isIndefinite(aborted)).toBe(true);
  });

  it('is accepted when the primary relay refuses the author and the secondaries accept', async () => {
    const { network, nostr } = relays();
    network.refuseWrites(PRIMARY_RELAY_URL, PILOT_REFUSAL);
    const event = snap('pub-pilot');

    const outcome = await publishFarmInventory(nostr)(event);

    expect(outcome.status).toBe('accepted');
    expect(outcome.acceptedRelays.sort()).toEqual([...INVENTORY_SECONDARY_RELAYS].sort());
    expect(outcome.errors).toEqual([{ relay: PRIMARY_RELAY_URL, error: PILOT_REFUSAL }]);
    // Every relay was offered the very same signed event.
    expect(network.offers.map((o) => o.relay).sort()).toEqual([...INVENTORY_RELAYS].sort());
    expect(network.offers.every((o) => o.event === event)).toBe(true);
  });

  it('is accepted when the primary relay finds the snapshot too large: the secondaries hold it', async () => {
    const { network, nostr } = relays();
    network.refuseWrites(PRIMARY_RELAY_URL, 'invalid: event too large (limit 49152 bytes)');

    const outcome = await publishFarmInventory(nostr)(snap('pub-large'));

    expect(outcome.status).toBe('accepted');
  });

  it('does not wait out a primary relay that never answers', async () => {
    const { network, nostr } = relays();
    network.ignoreWrites(PRIMARY_RELAY_URL);

    const started = Date.now();
    const outcome = await publishFarmInventory(nostr)(snap('pub-silent'));

    expect(outcome.status).toBe('accepted');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(outcome.errors).toEqual([{ relay: PRIMARY_RELAY_URL, error: 'no answer yet' }]);
  });

  it('is NOT accepted on the primary relay alone: the write counts once a secondary has it', async () => {
    const { network, nostr } = relays();
    for (const relay of INVENTORY_SECONDARY_RELAYS) network.refuseWrites(relay, 'rate-limited: slow down');

    const outcome = await publishFarmInventory(nostr)(snap('pub-primary-only'));

    // It exists, so it is not "rejected"; the caller looks for it before retrying.
    expect(outcome.status).toBe('ambiguous');
    expect(outcome.acceptedRelays).toEqual([PRIMARY_RELAY_URL]);
  });

  it('is rejected when every relay answered no', async () => {
    const { network, nostr } = relays();
    for (const relay of INVENTORY_RELAYS) network.refuseWrites(relay, 'blocked: nope');

    const outcome = await publishFarmInventory(nostr)(snap('pub-rejected'));

    expect(outcome.status).toBe('rejected');
  });
});

describe('a harvest never recreates farm:main from an unconfirmed absence', () => {
  const request = {
    produce: CARROT,
    consumedEventId: 'c'.repeat(64),
    consumedEventRelay: INVENTORY_RELAY_HINT,
    planting: { slotD: 'slot:farm.field:3:2', plantedAt: 1_699_990_000 },
  };

  function deps(nostr: NPool): CreditDeps & { signed: NostrEvent[] } {
    const signed: NostrEvent[] = [];
    return {
      signed,
      ownerPubkey: OWNER,
      ...farmInventoryReadDeps(nostr, OWNER),
      signEvent: async (template) => {
        const event = { ...template, id: eventId(`signed${signed.length}`), pubkey: OWNER, sig: 'x'.repeat(128) };
        signed.push(event);
        return event;
      },
      publish: publishFarmInventory(nostr),
      nowSec: () => 1_700_000_500,
      relayHint: INVENTORY_RELAY_HINT,
    };
  }

  it('refuses, signing and publishing nothing, when the secondaries time out and the primary relay answers empty', async () => {
    const { network, nostr } = relays();
    // The inventory exists, at revision 7, on the relays it was saved to. They
    // do not answer; the primary relay does, and it has never held it.
    const existing = snapshotEvent({ id: eventId('existing'), revision: 7, createdAt: 500, items: { [CARROT.address]: 7 } });
    network.seed(existing);
    network.withhold(PRIMARY_RELAY_URL, existing.id);
    for (const relay of INVENTORY_SECONDARY_RELAYS) {
      network.withhold(relay, existing.id);
      network.closeBeforeEose(relay);
    }
    const d = deps(nostr);

    const result = await creditHarvest(d, request);

    expect(result.status).toBe('rejected');
    expect(d.signed).toEqual([]);
    expect(network.offers).toEqual([]);
  });

  it('refuses to build on a copy only the primary relay returned while the secondaries are silent', async () => {
    const { network, nostr } = relays();
    // The primary relay holds an OLD revision (it refused the later, larger ones).
    const stale = snapshotEvent({ id: eventId('stale'), revision: 2, createdAt: 200, items: { [CARROT.address]: 2 } });
    const current = snapshotEvent({ id: eventId('current'), revision: 9, createdAt: 900, items: { [CARROT.address]: 9 } });
    network.seed(stale, current);
    network.withhold(PRIMARY_RELAY_URL, current.id);
    for (const relay of INVENTORY_SECONDARY_RELAYS) {
      network.withhold(relay, stale.id, current.id);
      network.closeBeforeEose(relay);
    }
    const d = deps(nostr);

    const result = await creditHarvest(d, request);

    expect(result.status).toBe('rejected');
    expect(d.signed).toEqual([]);
  });

  it('creates the first inventory only when every relay confirmed there is none, twice', async () => {
    const { network, nostr } = relays();
    const d = deps(nostr);

    const result = await creditHarvest(d, request);

    expect(result.status).toBe('accepted');
    expect(d.signed).toHaveLength(1);
    const inventoryReads = network.queries.filter((q) => q.filters[0].kinds?.[0] === 31633);
    expect(inventoryReads).toHaveLength(INVENTORY_RELAYS.length * 2);
  });

  it('credits on top of the existing inventory when the primary relay is empty and a secondary answers', async () => {
    const { network, nostr } = relays();
    const existing = snapshotEvent({ id: eventId('kept'), revision: 7, createdAt: 500, items: { [CARROT.address]: 7 } });
    network.seed(existing);
    network.withhold(PRIMARY_RELAY_URL, existing.id);
    network.refuseWrites(PRIMARY_RELAY_URL, PILOT_REFUSAL);
    const d = deps(nostr);

    const result = await creditHarvest(d, request);

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.quantity).toBe(8);
    expect(selectNewestInventory([result.event], OWNER)?.revision).toBe(8);
  });
});
