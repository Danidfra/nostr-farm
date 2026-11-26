import { describe, expect, it } from 'vitest';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { readFromRelays } from '@/nostr/query';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { AUTHOR_BLOCK_MS, createRelaySync, deliveryFromError, ownEventsOfKinds } from './relay-sync';

/**
 * Carrying events between relays, against in-memory relays and synthetic
 * events only. Nothing here opens a socket.
 */
const PRIMARY = 'wss://primary.example';
const SECOND = 'wss://second.example';
const THIRD = 'wss://third.example';
const RELAYS = [PRIMARY, SECOND, THIRD];

const OWNER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const PILOT_REFUSAL = 'blocked: this relay is in pilot mode; author is not on the write list';

let serial = 0;
function plot(d: string, createdAt: number, pubkey = OWNER, extraTags: string[][] = []): NostrEvent {
  serial += 1;
  return {
    id: `${serial}`.padStart(64, '0'),
    kind: KIND_SLOT_STATE,
    pubkey,
    created_at: createdAt,
    content: '',
    sig: 'x'.repeat(128),
    tags: [['d', d], ...extraTags],
  };
}

const FILTER: NostrFilter = { kinds: [KIND_SLOT_STATE], authors: [OWNER, STRANGER], limit: 500 };

function harness(options: { filter?: NostrFilter; consent?: boolean } = {}) {
  const network = new FakeRelayNetwork();
  let clock = 1_000_000;
  const sync = createRelaySync({ now: () => clock, primary: PRIMARY });
  // These suites are about WHAT is carried once the account has said yes; the consent itself is tested below.
  if (options.consent !== false) sync.consent.enable(OWNER, RELAYS);
  const filter = options.filter ?? FILTER;
  const pass = async () => {
    const read = await readFromRelays(network.pool, RELAYS, [filter], { timeoutMs: 50 });
    return sync.carryMissing(network.pool, {
      account: OWNER,
      reads: read.reads,
      filters: [filter],
      allows: ownEventsOfKinds(OWNER, [KIND_SLOT_STATE]),
      destinations: RELAYS,
    });
  };
  return { network, sync, pass, advance: (ms: number) => (clock += ms) };
}

const offeredTo = (network: FakeRelayNetwork, relay: string) => network.offers.filter((o) => o.relay === relay).map((o) => o.event.id);

describe('carrying an event to the relays that lack it', () => {
  it('offers an event only the secondaries hold to the primary relay, as the original event', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);

    await h.pass();

    expect(h.network.offers).toEqual([{ relay: PRIMARY, event, accepted: true }]);
    // Same object, same id, same signature: nothing was rebuilt or re-signed.
    expect(h.network.offers[0].event).toBe(event);
  });

  it('offers an event only the primary relay holds to the secondaries', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(SECOND, event.id);
    h.network.withhold(THIRD, event.id);

    await h.pass();

    expect(h.network.offers.map((o) => o.relay).sort()).toEqual([SECOND, THIRD]);
    expect(offeredTo(h.network, PRIMARY)).toEqual([]);
  });

  it('carries only the winning revision of an addressable event, to the relay holding the older one', async () => {
    const h = harness();
    const older = plot('slot:farm.field:1:1', 100);
    const newer = plot('slot:farm.field:1:1', 200);
    h.network.seed(older, newer);
    h.network.withhold(PRIMARY, newer.id);
    h.network.withhold(SECOND, older.id);
    h.network.withhold(THIRD, older.id);

    await h.pass();

    expect(h.network.offers).toEqual([{ relay: PRIMARY, event: newer, accepted: true }]);
  });

  it('offers nothing once every relay holds the event, and nothing a second time', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);

    await h.pass();
    await h.pass();
    await h.pass();

    expect(h.network.offers).toHaveLength(1);
  });
});

describe('presence that is not determined is left alone', () => {
  it('does not offer to a relay that closed the subscription before EOSE', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);
    h.network.closeBeforeEose(PRIMARY);

    await h.pass();

    expect(h.network.offers).toEqual([]);
  });

  it('does not offer to a relay that never answered', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);
    h.network.silence(PRIMARY);

    await h.pass();

    expect(h.network.offers).toEqual([]);
  });

  it('does not offer when the relay filled the filter limit, because the event may simply have been cut off', async () => {
    const filter = { ...FILTER, limit: 2 };
    const h = harness({ filter });
    const missing = plot('slot:farm.field:0:0', 100);
    // The primary returns two other plots: as many as the limit asked for.
    h.network.seed(missing, plot('slot:farm.field:1:1', 300), plot('slot:farm.field:2:2', 200));
    h.network.withhold(PRIMARY, missing.id);

    await h.pass();

    expect(offeredTo(h.network, PRIMARY)).toEqual([]);
  });

  it('needs two relays that finished: one answer alone proves nothing is missing anywhere', async () => {
    const h = harness();
    h.network.seed(plot('slot:farm.field:1:1', 100));
    h.network.closeBeforeEose(SECOND);
    h.network.closeBeforeEose(THIRD);

    await h.pass();

    expect(h.network.offers).toEqual([]);
  });
});

describe('what a flow does not allow is never carried', () => {
  it('leaves an event signed by somebody else where it is', async () => {
    const h = harness();
    const foreign = plot('slot:farm.field:1:1', 100, STRANGER);
    h.network.seed(foreign);
    h.network.withhold(PRIMARY, foreign.id);

    await h.pass();

    expect(h.network.offers).toEqual([]);
  });

  it('leaves expiring and relay-bound events where they are', async () => {
    const h = harness();
    const expiring = plot('slot:farm.field:1:1', 100, OWNER, [['expiration', '9999999999']]);
    const bound = plot('slot:farm.field:2:2', 100, OWNER, [['-']]);
    h.network.seed(expiring, bound);
    h.network.withhold(PRIMARY, expiring.id, bound.id);

    await h.pass();

    expect(h.network.offers).toEqual([]);
  });
});

describe('a relay that refuses', () => {
  it('reads the pilot write-list refusal as a definite rejection, not as silence', () => {
    expect(deliveryFromError(PRIMARY, new Error(PILOT_REFUSAL)).verdict).toBe('rejected');
    expect(deliveryFromError(PRIMARY, new Error('invalid: event too large')).verdict).toBe('rejected');
    const timeout = new Error('The operation timed out');
    timeout.name = 'TimeoutError';
    expect(deliveryFromError(PRIMARY, timeout).verdict).toBe('retry');
  });

  it('is offered ONE event of a refused author, not one per plot, and none again on later reads', async () => {
    const h = harness();
    const plots = [1, 2, 3, 4, 5].map((n) => plot(`slot:farm.field:${n}:0`, 100 + n));
    h.network.seed(...plots);
    h.network.withhold(PRIMARY, ...plots.map((p) => p.id));
    h.network.refuseWrites(PRIMARY, PILOT_REFUSAL);

    await h.pass();
    await h.pass();
    await h.pass();

    expect(offeredTo(h.network, PRIMARY)).toHaveLength(1);
    expect(h.sync.status()).toMatchObject({ state: 'refused', refused: 1, message: PILOT_REFUSAL });
  });

  it('is tried again for that author only after the block has lapsed, and again with a single event', async () => {
    const h = harness();
    const plots = [1, 2, 3].map((n) => plot(`slot:farm.field:${n}:0`, 100 + n));
    h.network.seed(...plots);
    h.network.withhold(PRIMARY, ...plots.map((p) => p.id));
    h.network.refuseWrites(PRIMARY, PILOT_REFUSAL);

    await h.pass();
    h.advance(AUTHOR_BLOCK_MS + 1);
    await h.pass();
    await h.pass();

    expect(offeredTo(h.network, PRIMARY)).toHaveLength(2);
    expect(new Set(offeredTo(h.network, PRIMARY)).size).toBe(2);
  });

  it('does not offer the same refused event again while its refusal stands', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);
    // Refused for what the event is (too large), not for who signed it.
    h.network.refuseWrites(PRIMARY, 'invalid: event too large');

    await h.pass();
    h.advance(AUTHOR_BLOCK_MS + 1);
    await h.pass();

    expect(offeredTo(h.network, PRIMARY)).toEqual([event.id]);
  });
});

describe('a relay that does not answer a write', () => {
  it('is offered the event again only after a wait, and the status says sync is pending', async () => {
    const h = harness();
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);

    const failing = {
      relay: (url: string) => ({
        ...h.network.pool.relay(url),
        event: async (e: NostrEvent) => {
          h.network.offers.push({ relay: url, event: e, accepted: false });
          const timeout = new Error('The operation timed out');
          timeout.name = 'TimeoutError';
          throw timeout;
        },
      }),
    };
    const pass = async (pool: typeof failing | typeof h.network.pool) => {
      const read = await readFromRelays(h.network.pool, RELAYS, [FILTER], { timeoutMs: 50 });
      return h.sync.carryMissing(pool, {
        account: OWNER,
        reads: read.reads,
        filters: [FILTER],
        allows: ownEventsOfKinds(OWNER, [KIND_SLOT_STATE]),
        destinations: RELAYS,
      });
    };

    await pass(failing);
    expect(h.sync.status()).toMatchObject({ state: 'pending', pending: 1 });

    await pass(failing);
    expect(h.network.offers).toHaveLength(1); // still inside the backoff

    h.advance(30_001);
    await pass(h.network.pool);
    expect(h.network.offers).toHaveLength(2);
    expect(h.sync.status()).toMatchObject({ state: 'synced', pending: 0 });
  });
});

describe('what the ledger remembers', () => {
  it('survives a reload through storage, so a refused event is not offered again by the next session', async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
    const network = new FakeRelayNetwork();
    const event = plot('slot:farm.field:1:1', 100);
    network.seed(event);
    network.withhold(PRIMARY, event.id);
    network.refuseWrites(PRIMARY, PILOT_REFUSAL);

    for (let session = 0; session < 2; session += 1) {
      const sync = createRelaySync({ now: () => 1_000_000, primary: PRIMARY, storage });
      if (session === 0) sync.consent.enable(OWNER, RELAYS);
      else expect(sync.consent.isEnabled(OWNER)).toBe(true); // the answer was restored too
      const read = await readFromRelays(network.pool, RELAYS, [FILTER], { timeoutMs: 50 });
      await sync.carryMissing(network.pool, {
        account: OWNER,
        reads: read.reads,
        filters: [FILTER],
        allows: ownEventsOfKinds(OWNER, [KIND_SLOT_STATE]),
        destinations: RELAYS,
      });
    }

    expect(network.offers).toHaveLength(1);
  });
});

describe('carrying is off until the account turns it on', () => {
  function memoryStorage() {
    const saved = new Map<string, string>();
    return { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
  }
  const timeout = () => {
    const error = new Error('The operation timed out');
    error.name = 'TimeoutError';
    return error;
  };

  it('sends nothing after a read by default: a relay missing the player\'s events is left as it is', async () => {
    const h = harness({ consent: false });
    const plots = [1, 2, 3].map((n) => plot(`slot:farm.field:${n}:0`, 100 + n));
    h.network.seed(...plots);
    h.network.withhold(PRIMARY, ...plots.map((p) => p.id));

    expect(await h.pass()).toEqual([]);
    expect(await h.pass()).toEqual([]);

    expect(h.network.offers).toEqual([]);
  });

  it('a restored session with owed deliveries in storage sends nothing', async () => {
    const storage = memoryStorage();
    const network = new FakeRelayNetwork();
    const event = plot('slot:farm.field:1:1', 100);
    network.seed(event);
    network.withhold(PRIMARY, event.id);

    // An earlier session published the event; the primary relay never answered.
    const earlier = createRelaySync({ now: () => 1_000_000, primary: PRIMARY, storage });
    earlier.recordDeliveries(event, [
      { relay: PRIMARY, verdict: 'retry', message: 'no answer yet' },
      { relay: SECOND, verdict: 'accepted' },
    ]);
    expect(earlier.ledger.pending(PRIMARY)).toHaveLength(1);

    // The page is reloaded, long after any backoff, and reads.
    const restored = createRelaySync({ now: () => 1_000_000 + 24 * 60 * 60_000, primary: PRIMARY, storage });
    expect(restored.ledger.pending(PRIMARY)).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      const read = await readFromRelays(network.pool, RELAYS, [FILTER], { timeoutMs: 50 });
      await restored.carryMissing(network.pool, {
        account: OWNER,
        reads: read.reads,
        filters: [FILTER],
        allows: ownEventsOfKinds(OWNER, [KIND_SLOT_STATE]),
        destinations: RELAYS,
      });
    }

    expect(network.offers).toEqual([]);
  });

  it('once on, carries only to the relays the account was shown, and to none that already has the event', async () => {
    const h = harness({ consent: false });
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);
    h.network.withhold(THIRD, event.id);
    // The account agreed to the primary and one secondary; THIRD was not on the list it saw.
    h.sync.consent.enable(OWNER, [PRIMARY, SECOND]);

    await h.pass();

    expect(h.network.offers).toEqual([{ relay: PRIMARY, event, accepted: true }]);
    expect(h.sync.consent.uncovered(OWNER, RELAYS)).toEqual([THIRD]);
  });

  it('is per account: one account turning it on carries nothing for a read made for another, or signed out', async () => {
    const h = harness({ consent: false });
    const event = plot('slot:farm.field:1:1', 100);
    h.network.seed(event);
    h.network.withhold(PRIMARY, event.id);
    h.sync.consent.enable(STRANGER, RELAYS);

    await h.pass(); // a read for OWNER, who has not chosen
    const read = await readFromRelays(h.network.pool, RELAYS, [FILTER], { timeoutMs: 50 });
    const request = { reads: read.reads, filters: [FILTER], allows: ownEventsOfKinds(OWNER, [KIND_SLOT_STATE]), destinations: RELAYS };
    // The consenting account reading somebody else's events carries none of them either.
    await h.sync.carryMissing(h.network.pool, { ...request, account: STRANGER });
    await h.sync.carryMissing(h.network.pool, { ...request, account: undefined });

    expect(h.network.offers).toEqual([]);
  });

  it('stops again when the account turns it off', async () => {
    const h = harness();
    const first = plot('slot:farm.field:1:1', 100);
    h.network.seed(first);
    h.network.withhold(PRIMARY, first.id);
    await h.pass();
    expect(h.network.offers).toHaveLength(1);

    h.sync.consent.disable(OWNER);
    const second = plot('slot:farm.field:2:2', 100);
    h.network.seed(second);
    h.network.withhold(PRIMARY, second.id);
    await h.pass();

    expect(h.network.offers).toHaveLength(1);
  });

  it('still finishes a publication of THIS session: an event the player just caused is offered again to the relay that was silent, and only to it', async () => {
    const h = harness({ consent: false });
    const fresh = plot('slot:farm.field:1:1', 100);
    const old = plot('slot:farm.field:2:2', 50);
    h.network.seed(fresh, old);
    h.network.withhold(PRIMARY, fresh.id, old.id);
    h.network.withhold(THIRD, fresh.id);
    // The player's action published `fresh`; the primary relay did not answer. THIRD was simply not reached by it.
    h.sync.recordDeliveries(fresh, [
      { relay: PRIMARY, verdict: 'retry', message: timeout().message },
      { relay: SECOND, verdict: 'accepted' },
    ]);

    await h.pass();
    expect(h.network.offers).toEqual([]); // inside the wait

    h.advance(30_001);
    await h.pass();

    // The fresh event, to the silent relay. Not the old plot, and not a relay with no owed delivery.
    expect(h.network.offers).toEqual([{ relay: PRIMARY, event: fresh, accepted: true }]);
  });

  it('does not offer an event the relay REFUSED in this session again without consent', async () => {
    const h = harness({ consent: false });
    const fresh = plot('slot:farm.field:1:1', 100);
    h.network.seed(fresh);
    h.network.withhold(PRIMARY, fresh.id);
    h.sync.recordDeliveries(fresh, [
      { relay: PRIMARY, verdict: 'rejected', message: PILOT_REFUSAL },
      { relay: SECOND, verdict: 'accepted' },
    ]);

    h.advance(24 * 60 * 60_000);
    await h.pass();

    expect(h.network.offers).toEqual([]);
  });
});
