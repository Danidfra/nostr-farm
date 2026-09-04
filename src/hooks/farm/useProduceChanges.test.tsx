import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveFarmInventoryView } from '@/hooks/farm/useFarmInventory';
import { ledgerFromEvents } from '@/inventory/ledger';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { OWNER, eventId, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';
import type { NostrEvent } from '@nostrify/nostrify';
import { useProduceChanges } from './useProduceChanges';

const PUMPKIN = PRODUCE_CATALOG.pumpkin;
const CARROT = PRODUCE_CATALOG.carrot;
const view = (events: NostrEvent[]) => deriveFarmInventoryView(ledgerFromEvents(OWNER, events));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useProduceChanges', () => {
  it('raises a notice for an external spend and lets it expire', () => {
    const snapshot = snapshotEvent({ items: { [PUMPKIN.address]: 4 } });
    const first = view([snapshot]);
    const { result, rerender } = renderHook(({ v }) => useProduceChanges(v, 1000), { initialProps: { v: first } });
    expect(result.current).toEqual([]);

    const second = view([snapshot, spendEvent({ id: eventId('s1'), item: PUMPKIN.address, quantity: 2 })]);
    rerender({ v: second });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ definition: PUMPKIN, from: 4, to: 2, cause: 'external-spend', client: 'another-game' });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toEqual([]);
  });

  it('does not announce the player\'s own harvest, which the field already does', () => {
    const marker = (id: string) => ['e', id, '', 'farm-harvest'];
    const first = view([snapshotEvent({ id: eventId('a'), items: { [CARROT.address]: 1 }, extraTags: [marker(eventId('h1'))] })]);
    const { result, rerender } = renderHook(({ v }) => useProduceChanges(v), { initialProps: { v: first } });

    const second = view([
      snapshotEvent({ id: eventId('b'), createdAt: 1_700_000_100, items: { [CARROT.address]: 2 }, extraTags: [marker(eventId('h1')), marker(eventId('h2'))] }),
    ]);
    rerender({ v: second });

    expect(result.current).toEqual([]);
  });
});
