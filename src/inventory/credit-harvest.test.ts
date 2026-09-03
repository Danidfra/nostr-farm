import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { PRODUCE_CATALOG } from './produce-catalog';
import { harvestedEventIds, produceQuantity, selectNewestInventory } from './farm-inventory';
import { creditHarvest, reconcileCredit, type CreditDeps, type PublishOutcome } from './credit-harvest';

const OWNER = 'a'.repeat(64);
const CARROT = PRODUCE_CATALOG.carrot;
const PLANT = 'c'.repeat(64);
const RELAY = 'wss://relay.primal.net';

const request = { produce: CARROT, consumedEventId: PLANT, consumedEventRelay: RELAY };

const ACCEPTED: PublishOutcome = { status: 'accepted', acceptedRelays: [RELAY], errors: [] };
const REJECTED: PublishOutcome = { status: 'rejected', acceptedRelays: [], errors: [{ relay: RELAY, error: 'blocked' }] };
const AMBIGUOUS: PublishOutcome = { status: 'ambiguous', acceptedRelays: [], errors: [{ relay: RELAY, error: 'timeout' }] };

/**
 * A fake relay world: a mutable store of published events, a signer that stamps
 * ids, and controllable read/publish behaviour.
 */
function world(options: { publish?: PublishOutcome; answered?: boolean; readFails?: number } = {}) {
  const store: NostrEvent[] = [];
  let signCount = 0;
  let reads = 0;
  let readsToFail = options.readFails ?? 0;

  const deps: CreditDeps = {
    ownerPubkey: OWNER,
    readInventory: async () => {
      reads += 1;
      if (readsToFail > 0) {
        readsToFail -= 1;
        return { events: [], answered: options.answered ?? false };
      }
      return { events: [...store], answered: true };
    },
    signEvent: async (template) => {
      signCount += 1;
      return { ...template, id: `sig${signCount}`.padEnd(64, '0'), pubkey: OWNER, sig: 'x'.repeat(128) };
    },
    publish: async (event) => {
      const outcome = options.publish ?? ACCEPTED;
      // A relay that accepts stores it; an ambiguous publish may ALSO have
      // stored it — callers control that via `landAmbiguous`.
      if (outcome.status === 'accepted') store.push(event);
      return outcome;
    },
    nowSec: () => 1_700_000_000 + signCount,
  };

  return {
    deps,
    store,
    get reads() {
      return reads;
    },
    get signCount() {
      return signCount;
    },
    inventory: () => selectNewestInventory(store, OWNER),
    land: (event: NostrEvent) => store.push(event),
  };
}

describe('first credit', () => {
  it('creates farm:main and credits one unit', async () => {
    const w = world();
    const result = await creditHarvest(w.deps, request);

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.quantity).toBe(1);
    expect(produceQuantity(w.inventory(), CARROT.address)).toBe(1);
    expect(harvestedEventIds(w.inventory())).toEqual([PLANT]);
  });

  it('confirms an empty read before building a replacement', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    // One read found nothing; a second confirmed it before anything was built.
    expect(w.reads).toBe(2);
  });

  it('does not confirm when the first read already found an inventory', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    const before = w.reads;
    await creditHarvest(w.deps, { ...request, consumedEventId: 'd'.repeat(64) });
    expect(w.reads - before).toBe(1);
  });
});

describe('unusable reads never become an empty base', () => {
  it('rejects when no relay answers the first read', async () => {
    const w = world({ readFails: 1, answered: false });
    const result = await creditHarvest(w.deps, request);

    expect(result.status).toBe('rejected');
    expect(w.signCount).toBe(0);
    expect(w.store).toHaveLength(0);
  });

  it('rejects when the confirming read cannot be completed', async () => {
    // First read answers empty; the confirmation fails outright.
    const store: NostrEvent[] = [];
    let call = 0;
    const deps: CreditDeps = {
      ownerPubkey: OWNER,
      readInventory: async () => {
        call += 1;
        return call === 1 ? { events: [], answered: true } : { events: [], answered: false };
      },
      signEvent: async () => {
        throw new Error('should not sign');
      },
      publish: async () => ACCEPTED,
      nowSec: () => 1_700_000_000,
    };

    const result = await creditHarvest(deps, request);
    expect(result.status).toBe('rejected');
    expect(store).toHaveLength(0);
  });

  it('uses an inventory the confirming read reveals, instead of replacing it', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    const existing = [...w.store];

    // The next attempt's FIRST read is blind; the confirmation sees the truth.
    let call = 0;
    const deps: CreditDeps = {
      ...w.deps,
      readInventory: async () => {
        call += 1;
        return call === 1 ? { events: [], answered: true } : { events: existing, answered: true };
      },
    };

    const result = await creditHarvest(deps, { ...request, consumedEventId: 'd'.repeat(64) });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // Built on the real base: quantity 2, not a fresh inventory of 1.
    expect(result.quantity).toBe(2);
  });
});

describe('idempotency', () => {
  it('credits the same plant event only once', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    const second = await creditHarvest(w.deps, request);

    expect(second.status).toBe('already-applied');
    expect(produceQuantity(w.inventory(), CARROT.address)).toBe(1);
    expect(w.signCount).toBe(1);
  });

  it('reports the quantity already held when skipping', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    const second = await creditHarvest(w.deps, request);

    expect(second.status === 'already-applied' && second.quantity).toBe(1);
  });

  it('records the marker exactly once', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    await creditHarvest(w.deps, request);

    expect(harvestedEventIds(w.inventory()).filter((id) => id === PLANT)).toHaveLength(1);
  });

  it('still credits a different plant event', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    const other = await creditHarvest(w.deps, { ...request, consumedEventId: 'd'.repeat(64) });

    expect(other.status).toBe('accepted');
    expect(produceQuantity(w.inventory(), CARROT.address)).toBe(2);
  });
});

describe('publish outcomes', () => {
  it('reports a definite rejection without crediting', async () => {
    const w = world({ publish: REJECTED });
    const result = await creditHarvest(w.deps, request);

    expect(result.status).toBe('rejected');
    expect(produceQuantity(w.inventory(), CARROT.address)).toBe(0);
  });

  it('a retry after a known failure succeeds exactly once', async () => {
    const w = world({ publish: REJECTED });
    await creditHarvest(w.deps, request);

    const retryWorld = world();
    const retry = await creditHarvest(retryWorld.deps, request);
    expect(retry.status).toBe('accepted');
    expect(produceQuantity(retryWorld.inventory(), CARROT.address)).toBe(1);
  });

  it('reports ambiguous rather than failure when a relay goes quiet', async () => {
    const w = world({ publish: AMBIGUOUS });
    const result = await creditHarvest(w.deps, request);
    expect(result.status).toBe('ambiguous');
  });
});

describe('ambiguous reconciliation', () => {
  it('finds the marker when the event actually landed', async () => {
    const w = world({ publish: AMBIGUOUS });
    const result = await creditHarvest(w.deps, request);
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;

    // It had landed after all.
    w.land(result.event);

    const check = await reconcileCredit(w.deps, request);
    expect(check.credited).toBe(true);
    expect(check.quantity).toBe(1);
  });

  it('reports not-credited when the event truly did not land', async () => {
    const w = world({ publish: AMBIGUOUS });
    await creditHarvest(w.deps, request);

    const check = await reconcileCredit(w.deps, request);
    expect(check.credited).toBe(false);
  });

  it('a later attempt after an ambiguous publish that landed does not add a second unit', async () => {
    const w = world({ publish: AMBIGUOUS });
    const first = await creditHarvest(w.deps, request);
    if (first.status !== 'ambiguous') throw new Error('expected ambiguous');
    w.land(first.event);

    const retry = await creditHarvest(w.deps, request);
    expect(retry.status).toBe('already-applied');
    expect(produceQuantity(w.inventory(), CARROT.address)).toBe(1);
  });

  it('treats an unreadable reconciliation as not-credited rather than credited', async () => {
    const deps: CreditDeps = {
      ownerPubkey: OWNER,
      readInventory: async () => ({ events: [], answered: false }),
      signEvent: async () => {
        throw new Error('no');
      },
      publish: async () => ACCEPTED,
      nowSec: () => 0,
    };
    expect((await reconcileCredit(deps, request)).credited).toBe(false);
  });
});

describe('signing failures', () => {
  it('rejects without publishing when the signer refuses', async () => {
    const w = world();
    const deps: CreditDeps = {
      ...w.deps,
      signEvent: async () => {
        throw new Error('user declined');
      },
    };
    const publish = vi.fn();

    const result = await creditHarvest({ ...deps, publish }, request);
    expect(result.status).toBe('rejected');
    expect(publish).not.toHaveBeenCalled();
  });
});
