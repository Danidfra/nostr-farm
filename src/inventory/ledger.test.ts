import { describe, expect, it } from 'vitest';

import { OWNER, OTHER_GAME_ADDRESS, STRANGER, CARROT, eventId, foldEvent, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';
import { admitLedgerEvent, admitLedgerEvents, emptyLedger, ledgerFromEvents, mergeLedgers, sameLedgerContents } from './ledger';

const S1 = eventId('s1');
const S2 = eventId('s2');
const M1 = eventId('m1');

describe('ledger admission', () => {
  it('admits the owner\'s own snapshot, spends and manifests', () => {
    const ledger = ledgerFromEvents(OWNER, [
      snapshotEvent({ id: eventId('snap1'), items: { [CARROT.address]: 3 } }),
      spendEvent({ id: S1, item: CARROT.address, quantity: 1 }),
      foldEvent({ id: M1, spends: [S1] }),
    ]);
    expect(ledger.snapshot?.event.id).toBe(eventId('snap1'));
    expect([...ledger.spends.keys()]).toEqual([S1]);
    expect([...ledger.folds.keys()]).toEqual([M1]);
  });

  it('rejects a stranger\'s events at the same d and address, wrong-inventory events, and malformed ones', () => {
    const ledger = ledgerFromEvents(OWNER, [
      // A stranger's farm:main is a different inventory.
      snapshotEvent({ id: eventId('foreign'), pubkey: STRANGER, items: { [CARROT.address]: 99 } }),
      // A spend signed by someone else against the owner's inventory is not a spend.
      spendEvent({ id: eventId('s-foreign'), pubkey: STRANGER, item: CARROT.address, quantity: 1 }),
      // A valid spend of the owner's OTHER game inventory is not ours.
      spendEvent({ id: eventId('s-other'), inventory: OTHER_GAME_ADDRESS, item: CARROT.address, quantity: 1 }),
      // Bad quantity.
      spendEvent({ id: eventId('s-bad'), item: CARROT.address, quantity: -2 }),
      // Manifest by a stranger, and one for another inventory.
      foldEvent({ id: eventId('m-foreign'), pubkey: STRANGER, spends: [S1] }),
      foldEvent({ id: eventId('m-other'), inventory: OTHER_GAME_ADDRESS, spends: [S1] }),
      // Wrong kind entirely.
      { ...spendEvent({ id: eventId('note') }), kind: 1 },
    ]);
    expect(ledger.snapshot).toBeNull();
    expect(ledger.spends.size).toBe(0);
    expect(ledger.folds.size).toBe(0);
  });

  it('reports no change for an event already held', () => {
    const spend = spendEvent({ id: S1 });
    const first = admitLedgerEvent(emptyLedger(OWNER), spend);
    const again = admitLedgerEvent(first.ledger, spend);
    expect(first.changed).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.ledger).toBe(first.ledger);
  });
});

describe('ledger snapshot selection', () => {
  it('keeps the newest snapshot whichever order the events arrive in', () => {
    const older = snapshotEvent({ id: eventId('old'), createdAt: 100, revision: 30 });
    const newer = snapshotEvent({ id: eventId('new'), createdAt: 200, revision: 31 });

    const forward = admitLedgerEvents(emptyLedger(OWNER), [older, newer]);
    const backward = admitLedgerEvents(emptyLedger(OWNER), [newer, older]);
    expect(forward.ledger.snapshot?.revision).toBe(31);
    expect(backward.ledger.snapshot?.revision).toBe(31);
    // Learning the older one after the newer one is not a change.
    expect(admitLedgerEvent(backward.ledger, older).changed).toBe(false);
  });

  it('breaks an exact created_at tie by lowest id, deterministically', () => {
    const a = snapshotEvent({ id: 'a'.repeat(64), createdAt: 100 });
    const b = snapshotEvent({ id: 'b'.repeat(64), createdAt: 100 });
    expect(ledgerFromEvents(OWNER, [a, b]).snapshot?.event.id).toBe(a.id);
    expect(ledgerFromEvents(OWNER, [b, a]).snapshot?.event.id).toBe(a.id);
  });
});

describe('ledger merge', () => {
  it('is monotonic: a stale incoming ledger cannot erase a known spend, fold or newer snapshot', () => {
    const known = ledgerFromEvents(OWNER, [
      snapshotEvent({ id: eventId('rev31'), createdAt: 200, revision: 31 }),
      spendEvent({ id: S1 }),
      foldEvent({ id: M1, spends: [S2] }),
    ]);
    const stale = ledgerFromEvents(OWNER, [snapshotEvent({ id: eventId('rev30'), createdAt: 100, revision: 30 })]);

    const merged = mergeLedgers(known, stale);
    expect(merged.changed).toBe(false);
    expect(merged.ledger).toBe(known);
    expect(merged.ledger.snapshot?.revision).toBe(31);
    expect(merged.ledger.spends.has(S1)).toBe(true);
    expect(merged.ledger.folds.has(M1)).toBe(true);
  });

  it('unions immutable events by id and takes the newer snapshot', () => {
    const a = ledgerFromEvents(OWNER, [snapshotEvent({ id: eventId('rev30'), createdAt: 100 }), spendEvent({ id: S1 })]);
    const b = ledgerFromEvents(OWNER, [snapshotEvent({ id: eventId('rev31'), createdAt: 200 }), spendEvent({ id: S2 })]);

    const ab = mergeLedgers(a, b);
    const ba = mergeLedgers(b, a);
    expect(ab.changed).toBe(true);
    expect([...ab.ledger.spends.keys()].sort()).toEqual([S1, S2]);
    expect(ab.ledger.snapshot?.event.id).toBe(eventId('rev31'));
    expect(ba.ledger.snapshot?.event.id).toBe(eventId('rev31'));
    expect(sameLedgerContents(ab.ledger, ba.ledger)).toBe(true);
  });

  it('refuses to merge two owners\' ledgers', () => {
    expect(() => mergeLedgers(emptyLedger(OWNER), emptyLedger(STRANGER))).toThrow(/different owners/);
  });
});
