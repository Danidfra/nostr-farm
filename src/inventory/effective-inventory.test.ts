import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import {
  CARROT,
  FARM_ADDRESS,
  OTHER_GAME_ADDRESS,
  OWNER,
  STRANGER,
  STRAWBERRY,
  eventId,
  foldEvent,
  snapshot,
  spendEvent,
} from '@/test/inventory-fixtures';
import { produceQuantity } from './farm-inventory';
import {
  loadFarmInventoryState,
  missingFoldReferences,
  resolveFarmInventory,
  type FarmInventoryReadDeps,
} from './effective-inventory';
import type { EventReference } from './relay-io';

const S1 = eventId('s1');
const S2 = eventId('s2');
const M1 = eventId('m1');
const M2 = eventId('m2');

const quantity = (resolution: ReturnType<typeof resolveFarmInventory>, address = STRAWBERRY.address) =>
  resolution.status === 'ready' ? produceQuantity(resolution.inventory, address) : NaN;

describe('read derivation', () => {
  it('no spends: the effective inventory is the snapshot', () => {
    const r = resolveFarmInventory({ snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }), folds: [], spends: [] });
    expect(r.status).toBe('ready');
    expect(quantity(r)).toBe(3);
  });

  it('one pending spend is subtracted before any snapshot is written', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      folds: [],
      spends: [spendEvent({ id: S1 })],
    });
    expect(quantity(r)).toBe(2);
    if (r.status !== 'ready') return;
    expect(r.state.applied.map((s) => s.id)).toEqual([S1]);
    // The raw snapshot is untouched and still available as such.
    expect(produceQuantity(r.snapshot, STRAWBERRY.address)).toBe(3);
  });

  it('several items are debited independently', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3, [CARROT.address]: 2 } }),
      folds: [],
      spends: [spendEvent({ id: S1 }), spendEvent({ id: S2, item: CARROT.address, quantity: 2 })],
    });
    expect(quantity(r)).toBe(2);
    expect(quantity(r, CARROT.address)).toBe(0);
  });

  it('a spend the snapshot already folded is not subtracted again', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 2 }, fold: { eventId: M1 } }),
      folds: [foldEvent({ id: M1, spends: [S1] })],
      // The relay still returns S1; the chain says it is inside the 2 already.
      spends: [spendEvent({ id: S1 })],
    });
    expect(quantity(r)).toBe(2);
    if (r.status !== 'ready') return;
    expect(r.state.folded.map((s) => s.id)).toEqual([S1]);
    expect(r.state.applied).toEqual([]);
  });

  it('a late spend older than the manifest is still pending', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 2 }, fold: { eventId: M1 } }),
      folds: [foldEvent({ id: M1, createdAt: 1_700_000_500, spends: [S1] })],
      spends: [spendEvent({ id: S1, createdAt: 1_700_000_100 }), spendEvent({ id: S2, createdAt: 1_700_000_200 })],
    });
    // S2 predates M1 but is not reachable through it: pending, applied once.
    expect(quantity(r)).toBe(1);
  });

  it('an overdraw is rejected in full, never clamped', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 1 } }),
      folds: [],
      spends: [spendEvent({ id: S1, quantity: 2 })],
    });
    expect(quantity(r)).toBe(1);
    if (r.status !== 'ready') return;
    expect(r.state.rejected.map((s) => s.id)).toEqual([S1]);
  });

  it('two spends in the same second: the lower id wins the last unit', () => {
    const high = eventId('f');
    const low = eventId('0');
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 1 } }),
      folds: [],
      // Supplied high first; order of receipt must not matter.
      spends: [spendEvent({ id: high, createdAt: 1_700_000_000 }), spendEvent({ id: low, createdAt: 1_700_000_000 })],
    });
    if (r.status !== 'ready') throw new Error('expected ready');
    expect(r.state.applied.map((s) => s.id)).toEqual([low]);
    expect(r.state.rejected.map((s) => s.id)).toEqual([high]);
    expect(quantity(r)).toBe(0);
  });

  it('the same spend from several relays is applied once', () => {
    const copy = spendEvent({ id: S1 });
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      folds: [],
      spends: [copy, { ...copy }, { ...copy }],
    });
    expect(quantity(r)).toBe(2);
  });

  it('the same manifest from several relays resolves once', () => {
    const manifest = foldEvent({ id: M1, spends: [S1] });
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 2 }, fold: { eventId: M1 } }),
      folds: [manifest, { ...manifest }],
      spends: [spendEvent({ id: S1 })],
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.chain.chain).toHaveLength(1);
    expect(r.chain.warnings).toEqual([]);
  });

  it('a missing manifest makes the state unresolved, with no balance at all', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 }, fold: { eventId: M1 } }),
      folds: [],
      spends: [spendEvent({ id: S1 })],
    });
    expect(r.status).toBe('unresolved');
    if (r.status !== 'unresolved') return;
    expect(r.problems.map((p) => p.code)).toEqual(['missing-fold']);
    expect('inventory' in r).toBe(false);
  });

  it('a spend signed by somebody else never affects the balance', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      folds: [],
      spends: [spendEvent({ id: S1, pubkey: STRANGER })],
    });
    expect(quantity(r)).toBe(3);
    if (r.status !== 'ready') return;
    expect(r.state.invalid).toHaveLength(1);
    expect(r.state.applied).toEqual([]);
  });

  it('a spend against another inventory of the same player is ignored', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      folds: [],
      spends: [spendEvent({ id: S1, inventory: OTHER_GAME_ADDRESS })],
    });
    expect(quantity(r)).toBe(3);
    if (r.status !== 'ready') return;
    expect(r.state.ignored.map((s) => s.id)).toEqual([S1]);
  });

  it('a manifest scoped to another inventory fails the chain', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 }, fold: { eventId: M1 } }),
      folds: [foldEvent({ id: M1, inventory: OTHER_GAME_ADDRESS, spends: [S1] })],
      spends: [],
    });
    expect(r.status).toBe('unresolved');
  });

  it('a spend of an item the snapshot does not hold is an overdraw, not a new balance', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      folds: [],
      spends: [spendEvent({ id: S1, item: CARROT.address })],
    });
    if (r.status !== 'ready') throw new Error('expected ready');
    expect(r.state.rejected.map((s) => s.id)).toEqual([S1]);
    expect(quantity(r, CARROT.address)).toBe(0);
    expect(r.inventory.items.map((i) => i.address)).toEqual([STRAWBERRY.address]);
  });

  it('an orphan manifest settles nothing', () => {
    const r = resolveFarmInventory({
      // No fold reference on the snapshot…
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      // …so this manifest, however well-formed, is not part of the chain.
      folds: [foldEvent({ id: M2, spends: [S1] })],
      spends: [spendEvent({ id: S1 })],
    });
    expect(quantity(r)).toBe(2);
    if (r.status !== 'ready') return;
    expect(r.state.applied.map((s) => s.id)).toEqual([S1]);
  });

  it('a voided spend never applies again, whatever the balance', () => {
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 10 }, fold: { eventId: M1 } }),
      folds: [foldEvent({ id: M1, voids: [S1] })],
      spends: [spendEvent({ id: S1 })],
    });
    expect(quantity(r)).toBe(10);
    if (r.status !== 'ready') return;
    expect(r.state.voided.map((s) => s.id)).toEqual([S1]);
  });

  it('inventory identity is the full address, not the d tag', () => {
    expect(FARM_ADDRESS).toBe(`31633:${OWNER}:farm:main`);
    const r = resolveFarmInventory({
      snapshot: snapshot({ items: { [STRAWBERRY.address]: 3 } }),
      folds: [],
      // Same d, different owner: a different inventory entirely.
      spends: [spendEvent({ id: S1, pubkey: STRANGER, inventory: `31633:${STRANGER}:farm:main` })],
    });
    expect(quantity(r)).toBe(3);
  });
});

describe('missing fold references', () => {
  it('carries the snapshot hint for the head and the previous-link hint for deeper manifests', () => {
    const head = snapshot({ fold: { eventId: M2, relay: 'wss://hint.head' } });
    const unresolvedHead = resolveFarmInventory({ snapshot: head, folds: [], spends: [] });
    if (unresolvedHead.status !== 'unresolved') throw new Error('expected unresolved');
    expect(missingFoldReferences(head, unresolvedHead.chain)).toEqual([{ eventId: M2, relay: 'wss://hint.head' }]);

    const withHead = resolveFarmInventory({
      snapshot: head,
      folds: [foldEvent({ id: M2, previous: { eventId: M1, relay: 'wss://hint.previous' }, spends: [S2] })],
      spends: [],
    });
    if (withHead.status !== 'unresolved') throw new Error('expected unresolved');
    expect(missingFoldReferences(head, withHead.chain)).toEqual([{ eventId: M1, relay: 'wss://hint.previous' }]);
  });
});

/** A fake network: what each read returns, and which manifests are fetchable by id. */
function network(options: {
  spends?: NostrEvent[];
  spendsAnswered?: boolean;
  folds?: NostrEvent[];
  foldsAnswered?: boolean;
  byId?: NostrEvent[];
}) {
  const byIdCalls: EventReference[][] = [];
  const deps: FarmInventoryReadDeps = {
    readSpends: vi.fn(async () => ({ events: options.spends ?? [], answered: options.spendsAnswered ?? true })),
    readFolds: vi.fn(async () => ({ events: options.folds ?? [], answered: options.foldsAnswered ?? true })),
    readFoldsById: vi.fn(async (references: EventReference[]) => {
      byIdCalls.push(references);
      const ids = new Set(references.map((r) => r.eventId));
      return { events: (options.byId ?? []).filter((e) => ids.has(e.id)), answered: true };
    }),
  };
  return { deps, byIdCalls };
}

describe('loading the effective state', () => {
  it('does not query manifests at all for a snapshot without a fold reference', async () => {
    const n = network({ spends: [spendEvent({ id: S1 })] });
    const r = await loadFarmInventoryState(n.deps, snapshot({ items: { [STRAWBERRY.address]: 3 } }));
    expect(r.status).toBe('ready');
    expect(n.deps.readFolds).not.toHaveBeenCalled();
    expect(n.deps.readFoldsById).not.toHaveBeenCalled();
  });

  it('fetches a manifest the address query did not return, by id, using the hint', async () => {
    const n = network({ byId: [foldEvent({ id: M1, spends: [S1] })], spends: [spendEvent({ id: S1 })] });
    const r = await loadFarmInventoryState(
      n.deps,
      snapshot({ items: { [STRAWBERRY.address]: 2 }, fold: { eventId: M1, relay: 'wss://hint' } })
    );
    expect(r.status).toBe('ready');
    expect(n.byIdCalls).toEqual([[{ eventId: M1, relay: 'wss://hint' }]]);
    expect(quantity(r as ReturnType<typeof resolveFarmInventory>)).toBe(2);
  });

  it('walks a chain one missing link at a time', async () => {
    const n = network({
      folds: [foldEvent({ id: M2, previous: { eventId: M1 }, spends: [S2] })],
      byId: [foldEvent({ id: M1, spends: [S1] })],
      spends: [spendEvent({ id: S1 }), spendEvent({ id: S2 })],
    });
    const r = await loadFarmInventoryState(n.deps, snapshot({ items: { [STRAWBERRY.address]: 1 }, fold: { eventId: M2 } }));
    expect(r.status).toBe('ready');
    expect(n.byIdCalls.map((call) => call.map((ref) => ref.eventId))).toEqual([[M1]]);
    // Both folded; nothing subtracted.
    expect(quantity(r as ReturnType<typeof resolveFarmInventory>)).toBe(1);
  });

  it('reports unresolved, not a guess, when the manifest is nowhere', async () => {
    const n = network({ spends: [spendEvent({ id: S1 })] });
    const r = await loadFarmInventoryState(n.deps, snapshot({ items: { [STRAWBERRY.address]: 3 }, fold: { eventId: M1 } }));
    expect(r.status).toBe('unresolved');
    // Tried once by id, found nothing new, stopped.
    expect(n.byIdCalls).toHaveLength(1);
  });

  it('is an error, not an empty balance, when no relay answers the spend read', async () => {
    const n = network({ spendsAnswered: false });
    const r = await loadFarmInventoryState(n.deps, snapshot({ items: { [STRAWBERRY.address]: 3 } }));
    expect(r.status).toBe('error');
  });

  it('is an error when the manifests cannot be read for a folded snapshot', async () => {
    const n = network({ foldsAnswered: false });
    const r = await loadFarmInventoryState(n.deps, snapshot({ fold: { eventId: M1 } }));
    expect(r.status).toBe('error');
  });
});
