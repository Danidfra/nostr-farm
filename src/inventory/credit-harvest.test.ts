import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import {
  CARROT,
  OWNER,
  RELAY,
  STRAWBERRY,
  eventId,
  foldEvent,
  foldRefs,
  foldTag,
  parseSnapshot,
  snapshotEvent,
  spendEvent,
} from '@/test/inventory-fixtures';
import { INVENTORY_KINDS, KIND_GAME_INVENTORY } from './package';
import { harvestedEventIds, produceQuantity, selectNewestInventory } from './farm-inventory';
import { resolveFarmInventory } from './effective-inventory';
import { creditHarvest, isSameManifest, reconcileCredit, type CreditDeps, type PublishOutcome } from './credit-harvest';

const PLANT = 'c'.repeat(64);
const PLANT_2 = 'd'.repeat(64);

const request = { produce: CARROT, consumedEventId: PLANT, consumedEventRelay: RELAY };
const strawberryRequest = { produce: STRAWBERRY, consumedEventId: PLANT, consumedEventRelay: RELAY };

const ACCEPTED: PublishOutcome = { status: 'accepted', acceptedRelays: [RELAY], errors: [] };
const REJECTED: PublishOutcome = { status: 'rejected', acceptedRelays: [], errors: [{ relay: RELAY, error: 'blocked' }] };
const AMBIGUOUS: PublishOutcome = { status: 'ambiguous', acceptedRelays: [], errors: [{ relay: RELAY, error: 'timeout' }] };

const S1 = eventId('s1');
const S2 = eventId('s2');
const M1 = eventId('m1');

/** Ids are unique across every fake world, like real signatures over distinct events. */
let globalSignatures = 0;

interface WorldOptions {
  /** Outcome for kind:31633 publishes. */
  publish?: PublishOutcome;
  /** Outcome for kind:1417 publishes (defaults to `publish`). */
  publishFold?: PublishOutcome;
  /** An ambiguous manifest publish that did in fact land. */
  foldLandsOnAmbiguous?: boolean;
  answered?: boolean;
  readFails?: number;
  spendsAnswered?: boolean;
}

/**
 * A fake relay world: mutable stores of published snapshots, manifests and
 * spends, a signer that stamps ids, and controllable read/publish behaviour.
 */
function world(options: WorldOptions = {}) {
  const store: NostrEvent[] = [];
  const folds: NostrEvent[] = [];
  const spends: NostrEvent[] = [];
  const published: number[] = [];
  let signCount = 0;
  let reads = 0;
  let readsToFail = options.readFails ?? 0;

  const deps: CreditDeps = {
    ownerPubkey: OWNER,
    relayHint: RELAY,
    readInventory: async () => {
      reads += 1;
      if (readsToFail > 0) {
        readsToFail -= 1;
        return { events: [], answered: options.answered ?? false };
      }
      return { events: [...store], answered: true };
    },
    readSpends: async () => ({ events: [...spends], answered: options.spendsAnswered ?? true }),
    readFolds: async () => ({ events: [...folds], answered: true }),
    readFoldsById: async (references) => ({
      events: folds.filter((fold) => references.some((reference) => reference.eventId === fold.id)),
      answered: true,
    }),
    signEvent: async (template) => {
      signCount += 1;
      globalSignatures += 1;
      return { ...template, id: `sig${globalSignatures}`.padEnd(64, '0'), pubkey: OWNER, sig: 'x'.repeat(128) };
    },
    publish: async (event) => {
      published.push(event.kind);
      const isFold = event.kind === INVENTORY_KINDS.fold;
      const outcome = isFold ? (options.publishFold ?? options.publish ?? ACCEPTED) : (options.publish ?? ACCEPTED);
      const target = isFold ? folds : store;
      const landed = outcome.status === 'accepted' || (isFold && outcome.status === 'ambiguous' && options.foldLandsOnAmbiguous);
      if (landed && !target.some((existing) => existing.id === event.id)) target.push(event);
      return outcome;
    },
    nowSec: () => 1_700_000_000 + signCount,
  };

  return {
    deps,
    store,
    folds,
    spends,
    /** Kinds in publish order. */
    published,
    get reads() {
      return reads;
    },
    get signCount() {
      return signCount;
    },
    inventory: () => selectNewestInventory(store, OWNER),
    land: (event: NostrEvent) => (event.kind === INVENTORY_KINDS.fold ? folds : store).push(event),
    seed: (event: NostrEvent) => store.push(event),
    spend: (spec: Parameters<typeof spendEvent>[0]) => spends.push(spendEvent(spec)),
    /** What a reader derives from the relays right now. */
    effective: () => {
      const snapshot = selectNewestInventory(store, OWNER);
      if (!snapshot) return null;
      return resolveFarmInventory({ snapshot, folds, spends });
    },
    effectiveQuantity(address: string) {
      const r = this.effective();
      return r && r.status === 'ready' ? produceQuantity(r.inventory, address) : NaN;
    },
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
    await creditHarvest(w.deps, { ...request, consumedEventId: PLANT_2 });
    expect(w.reads - before).toBe(1);
  });

  it('publishes no manifest when there is nothing to settle', async () => {
    const w = world();
    await creditHarvest(w.deps, request);
    expect(w.folds).toHaveLength(0);
    expect(foldTag(w.store.at(-1))).toBeUndefined();
    expect(w.published).toEqual([KIND_GAME_INVENTORY]);
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
    const w = world();
    let call = 0;
    const deps: CreditDeps = {
      ...w.deps,
      readInventory: async () => {
        call += 1;
        return call === 1 ? { events: [], answered: true } : { events: [], answered: false };
      },
      signEvent: async () => {
        throw new Error('should not sign');
      },
    };

    const result = await creditHarvest(deps, request);
    expect(result.status).toBe('rejected');
    expect(w.store).toHaveLength(0);
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

    const result = await creditHarvest(deps, { ...request, consumedEventId: PLANT_2 });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const next = parseSnapshot(result.event);
    expect(produceQuantity(next, CARROT.address)).toBe(2);
    expect(harvestedEventIds(next)).toEqual([PLANT, PLANT_2]);
    expect(next.revision).toBe(2);
  });

  it('rejects when the spends cannot be read, rather than crediting blind', async () => {
    const w = world({ spendsAnswered: false });
    w.seed(snapshotEvent({ items: { [CARROT.address]: 1 } }));
    const result = await creditHarvest(w.deps, request);
    expect(result.status).toBe('rejected');
    expect(w.signCount).toBe(0);
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
    const other = await creditHarvest(w.deps, { ...request, consumedEventId: PLANT_2 });

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
    const deps = {
      ownerPubkey: OWNER,
      readInventory: async () => ({ events: [], answered: false }),
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

describe('folding pending spends while writing', () => {
  it('settles an applied spend in a manifest published BEFORE the snapshot that references it', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 }, revision: 4 }));
    w.spend({ id: S1 });

    // Read side, before any write: 3 − 1.
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(2);

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    // Manifest first, then the snapshot.
    expect(w.published).toEqual([INVENTORY_KINDS.fold, KIND_GAME_INVENTORY]);
    expect(w.folds).toHaveLength(1);
    const manifest = w.folds[0];
    expect(foldRefs(manifest, 'spend')).toEqual([S1]);
    expect(foldRefs(manifest, 'void')).toEqual([]);
    expect(foldRefs(manifest, 'previous')).toEqual([]);
    expect(manifest.tags[0]).toEqual(['a', `31633:${OWNER}:farm:main`, RELAY, 'inventory']);
    expect(manifest.pubkey).toBe(OWNER);

    // The snapshot: (3 − 1) + 1, referencing the manifest with the accepting relay.
    const next = parseSnapshot(result.event);
    expect(produceQuantity(next, STRAWBERRY.address)).toBe(3);
    expect(foldTag(result.event)).toEqual(['e', manifest.id, RELAY, 'fold']);
    expect(next.revision).toBe(5);
    expect(harvestedEventIds(next)).toEqual([PLANT]);
    expect(result.fold?.id).toBe(manifest.id);
    expect(result.quantity).toBe(3);

    // A reader now derives the same number: S1 is folded, not subtracted twice.
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(3);
  });

  it('a spend rejected against the pre-harvest balance is voided, not revived by the harvest', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [CARROT.address]: 5 } }));
    // No strawberries at all; this spend overdraws.
    w.spend({ id: S1, item: STRAWBERRY.address, quantity: 1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    expect(foldRefs(w.folds[0], 'void')).toEqual([S1]);
    expect(foldRefs(w.folds[0], 'spend')).toEqual([]);
    // 0 + 1 harvested = 1. NOT 0 (harvest first, then S1 applying).
    expect(produceQuantity(parseSnapshot(result.event), STRAWBERRY.address)).toBe(1);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(1);

    // And it stays void on every later write, whatever the balance.
    const later = await creditHarvest(w.deps, { ...strawberryRequest, consumedEventId: PLANT_2 });
    expect(later.status).toBe('accepted');
    expect(w.folds).toHaveLength(1);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(2);
  });

  it('a spend against an inventory that does not exist yet is voided by the first snapshot', async () => {
    const w = world();
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    expect(w.reads).toBe(2); // the empty read was still confirmed
    expect(foldRefs(w.folds[0], 'void')).toEqual([S1]);
    const next = parseSnapshot(result.event);
    expect(next.revision).toBe(1);
    expect(produceQuantity(next, STRAWBERRY.address)).toBe(1);
    expect(next.fold?.eventId).toBe(w.folds[0].id);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(1);
  });

  it('concurrent overdraw: the winner is folded and the loser voided in the same manifest', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 1 } }));
    const loser = eventId('f');
    const winner = eventId('0');
    w.spend({ id: loser, createdAt: 1_700_000_000 });
    w.spend({ id: winner, createdAt: 1_700_000_000 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');

    expect(foldRefs(w.folds[0], 'spend')).toEqual([winner]);
    expect(foldRefs(w.folds[0], 'void')).toEqual([loser]);
    // (1 − 1) + 1
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(1);
  });

  it('chains the new manifest to the snapshot\'s current fold and does not re-fold settled spends', async () => {
    const w = world();
    w.land(foldEvent({ id: M1, spends: [S1] }));
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 2 }, fold: { eventId: M1, relay: RELAY }, revision: 1 }));
    w.spend({ id: S1 });
    w.spend({ id: S2 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const manifest = w.folds.find((fold) => fold.id !== M1)!;
    expect(foldRefs(manifest, 'previous')).toEqual([M1]);
    expect(manifest.tags.find((tag) => tag[3] === 'previous')?.[2]).toBe(RELAY);
    expect(foldRefs(manifest, 'spend')).toEqual([S2]);
    expect(foldTag(result.event)?.[1]).toBe(manifest.id);
    // 2 − S2 + harvest
    expect(produceQuantity(parseSnapshot(result.event), STRAWBERRY.address)).toBe(2);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(2);
  });

  it('with no new pending spends, keeps the existing fold reference and publishes no manifest', async () => {
    const w = world();
    w.land(foldEvent({ id: M1, spends: [S1] }));
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 2 }, fold: { eventId: M1, relay: RELAY }, revision: 1 }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    expect(w.folds).toHaveLength(1);
    expect(w.published).toEqual([KIND_GAME_INVENTORY]);
    expect(foldTag(result.event)).toEqual(['e', M1, RELAY, 'fold']);
    expect(parseSnapshot(result.event).revision).toBe(2);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(3);
  });

  it('a later harvest does not fold the same spend twice', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });

    await creditHarvest(w.deps, strawberryRequest);
    await creditHarvest(w.deps, { ...strawberryRequest, consumedEventId: PLANT_2 });

    expect(w.folds).toHaveLength(1);
    expect(foldTag(w.store.at(-1))?.[1]).toBe(w.folds[0].id);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(4);
  });

  it('preserves unmanaged tags and earlier harvest markers through a folding write', async () => {
    const w = world();
    w.seed(
      snapshotEvent({
        items: { [STRAWBERRY.address]: 3 },
        revision: 2,
        extraTags: [
          ['e', PLANT_2, RELAY, 'farm-harvest'],
          ['e', 'f'.repeat(64), '', 'some-other-marker'],
          ['future_tag', 'keep-me'],
        ],
      })
    );
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    if (result.status !== 'accepted') throw new Error(result.status);

    const tags = result.event.tags;
    expect(tags).toContainEqual(['e', PLANT_2, RELAY, 'farm-harvest']);
    expect(tags).toContainEqual(['e', PLANT, RELAY, 'farm-harvest']);
    expect(tags).toContainEqual(['e', 'f'.repeat(64), '', 'some-other-marker']);
    expect(tags).toContainEqual(['future_tag', 'keep-me']);
    expect(tags.filter((tag) => tag[0] === 'e' && tag[3] === 'fold')).toHaveLength(1);
    expect(harvestedEventIds(parseSnapshot(result.event))).toEqual([PLANT_2, PLANT]);
  });

  it('a stack the package refuses to grow fails before any manifest is published', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: Number.MAX_SAFE_INTEGER } }));
    w.spend({ id: S1, item: CARROT.address });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('rejected');
    expect(w.published).toEqual([]);
    expect(w.signCount).toBe(0);
  });
});

describe('an unresolved chain blocks the write', () => {
  it('signs nothing and reports the problem when the current manifest cannot be found', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 }, fold: { eventId: M1 } }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') return;
    expect(result.problems.map((p) => p.code)).toEqual(['missing-fold']);
    expect(w.signCount).toBe(0);
    expect(w.published).toEqual([]);
  });

  it('proceeds once the manifest becomes retrievable', async () => {
    const w = world();
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 }, fold: { eventId: M1 } }));
    expect((await creditHarvest(w.deps, strawberryRequest)).status).toBe('unresolved');

    w.land(foldEvent({ id: M1, spends: [S1] }));
    expect((await creditHarvest(w.deps, strawberryRequest)).status).toBe('accepted');
  });
});

describe('manifest publish failures', () => {
  it('a rejected manifest prevents the snapshot: nothing credited, nothing signed twice', async () => {
    const w = world({ publishFold: REJECTED });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('rejected');
    expect(w.published).toEqual([INVENTORY_KINDS.fold]);
    expect(w.signCount).toBe(1);
    expect(w.store).toHaveLength(1); // the original snapshot only
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(2); // S1 still pending
  });

  it('an ambiguous manifest that can be found by id is reused, not re-signed', async () => {
    const w = world({ publishFold: AMBIGUOUS, foldLandsOnAmbiguous: true });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(w.folds).toHaveLength(1);
    expect(foldTag(result.event)?.[1]).toBe(w.folds[0].id);
    expect(w.signCount).toBe(2); // one manifest, one snapshot
  });

  it('an ambiguous manifest that cannot be found is reported unconfirmed; nothing is credited', async () => {
    const w = world({ publishFold: AMBIGUOUS });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('fold-unconfirmed');
    expect(w.published).toEqual([INVENTORY_KINDS.fold]);
    expect(w.store).toHaveLength(1);
  });

  it('the retry republishes the same unconfirmed manifest instead of signing a look-alike', async () => {
    const w = world({ publishFold: AMBIGUOUS });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });
    const first = await creditHarvest(w.deps, strawberryRequest);
    if (first.status !== 'fold-unconfirmed') throw new Error(first.status);

    // Relays recover.
    const recovered = world();
    recovered.seed(w.store[0]);
    recovered.spends.push(...w.spends);

    const retry = await creditHarvest(recovered.deps, { ...strawberryRequest, unconfirmedFold: first.fold });
    expect(retry.status).toBe('accepted');
    if (retry.status !== 'accepted') return;
    expect(recovered.folds.map((fold) => fold.id)).toEqual([first.fold.id]);
    expect(foldTag(retry.event)?.[1]).toBe(first.fold.id);
    expect(recovered.signCount).toBe(1); // only the snapshot was signed here
  });

  it('a remembered manifest that no longer matches the pending set is not reused', async () => {
    const w = world({ publishFold: AMBIGUOUS });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });
    const first = await creditHarvest(w.deps, strawberryRequest);
    if (first.status !== 'fold-unconfirmed') throw new Error(first.status);

    const recovered = world();
    recovered.seed(w.store[0]);
    recovered.spends.push(...w.spends);
    recovered.spend({ id: S2 }); // a new spend arrived: a different manifest is needed

    const retry = await creditHarvest(recovered.deps, { ...strawberryRequest, unconfirmedFold: first.fold });
    if (retry.status !== 'accepted') throw new Error(retry.status);
    expect(recovered.folds[0].id).not.toBe(first.fold.id);
    expect(foldRefs(recovered.folds[0], 'spend')).toEqual([S1, S2]);
  });

  it('isSameManifest compares what is settled, not who signed when', () => {
    const template = { kind: INVENTORY_KINDS.fold, content: '', tags: [['a', 'x', '', 'inventory'], ['e', S1, '', 'spend']] };
    expect(isSameManifest({ ...template, id: 'a', pubkey: OWNER, created_at: 1, sig: '' }, template)).toBe(true);
    expect(
      isSameManifest({ ...template, tags: [['a', 'x', '', 'inventory'], ['e', S2, '', 'spend']], id: 'a', pubkey: OWNER, created_at: 1, sig: '' }, template)
    ).toBe(false);
  });
});

describe('manifest accepted, snapshot not', () => {
  it('leaves the current snapshot authoritative and the spends pending', async () => {
    const w = world({ publish: REJECTED, publishFold: ACCEPTED });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.fold).toBeDefined();
    expect(w.folds).toHaveLength(1); // the orphan
    expect(w.store).toHaveLength(1);
    // The orphan settles nothing: a reader still subtracts S1 exactly once.
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(2);
    const r = w.effective();
    expect(r?.status === 'ready' && r.state.applied.map((s) => s.id)).toEqual([S1]);
  });

  it('the retry reuses the orphan and credits exactly once', async () => {
    const w = world({ publish: REJECTED, publishFold: ACCEPTED });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });
    const first = await creditHarvest(w.deps, strawberryRequest);
    if (first.status !== 'rejected' || !first.fold) throw new Error('expected rejected with fold');

    const recovered = world();
    recovered.seed(w.store[0]);
    recovered.spends.push(...w.spends);
    recovered.folds.push(...w.folds);

    const retry = await creditHarvest(recovered.deps, { ...strawberryRequest, unconfirmedFold: first.fold });
    expect(retry.status).toBe('accepted');
    if (retry.status !== 'accepted') return;
    expect(recovered.folds.map((fold) => fold.id)).toEqual([first.fold.id]);
    expect(foldTag(retry.event)?.[1]).toBe(first.fold.id);
    expect(produceQuantity(parseSnapshot(retry.event), STRAWBERRY.address)).toBe(3);
    expect(recovered.effectiveQuantity(STRAWBERRY.address)).toBe(3);
  });

  it('a retry that has forgotten the orphan signs a fresh manifest and still credits once', async () => {
    const w = world({ publish: REJECTED, publishFold: ACCEPTED });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });
    await creditHarvest(w.deps, strawberryRequest);

    const recovered = world();
    recovered.seed(w.store[0]);
    recovered.spends.push(...w.spends);
    recovered.folds.push(...w.folds);

    const retry = await creditHarvest(recovered.deps, strawberryRequest);
    expect(retry.status).toBe('accepted');
    if (retry.status !== 'accepted') return;
    // Two manifests exist; only the referenced one counts.
    expect(recovered.folds).toHaveLength(2);
    expect(foldTag(retry.event)?.[1]).not.toBe(w.folds[0].id);
    expect(recovered.effectiveQuantity(STRAWBERRY.address)).toBe(3);
    expect(harvestedEventIds(parseSnapshot(retry.event))).toEqual([PLANT]);
  });

  it('an ambiguous snapshot after an accepted manifest reconciles by marker as before', async () => {
    const w = world({ publish: AMBIGUOUS, publishFold: ACCEPTED });
    w.seed(snapshotEvent({ items: { [STRAWBERRY.address]: 3 } }));
    w.spend({ id: S1 });

    const result = await creditHarvest(w.deps, strawberryRequest);
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.fold).toBeDefined();

    // Did not land: still pending.
    expect((await reconcileCredit(w.deps, strawberryRequest)).credited).toBe(false);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(2);

    // Landed: folded, and a retry credits nothing more.
    w.land(result.event);
    expect((await reconcileCredit(w.deps, strawberryRequest)).credited).toBe(true);
    expect(w.effectiveQuantity(STRAWBERRY.address)).toBe(3);
    expect((await creditHarvest(w.deps, strawberryRequest)).status).toBe('already-applied');
    expect(w.folds).toHaveLength(1);
  });
});
