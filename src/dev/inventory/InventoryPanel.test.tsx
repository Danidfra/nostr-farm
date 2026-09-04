import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { deriveFarmInventoryView } from '@/hooks/farm/useFarmInventory';
import { ledgerFromEvents } from '@/inventory/ledger';
import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { OWNER, eventId, foldEvent, snapshotEvent, spendEvent } from '@/test/inventory-fixtures';
import type { NostrEvent } from '@nostrify/nostrify';
import { InventoryPanel } from './InventoryPanel';

const PUMPKIN = PRODUCE_CATALOG.pumpkin;
const STRAWBERRY = PRODUCE_CATALOG.strawberry;
const S1 = eventId('s1');
const S2 = eventId('s2');
const M1 = eventId('m1');

const view = (events: NostrEvent[]) => deriveFarmInventoryView(ledgerFromEvents(OWNER, events));
const query = { isPending: false, isFetching: false, dataUpdatedAt: 1_000, error: null };

describe('InventoryPanel', () => {
  it('lays out a ready inventory: raw, pending and effective balances from the shared view', () => {
    const snapshot = snapshotEvent({ id: eventId('snap'), createdAt: 1_700_000_000, revision: 7, items: { [PUMPKIN.address]: 4, [STRAWBERRY.address]: 2 } });
    const spend = spendEvent({ id: S1, item: PUMPKIN.address, quantity: 2, createdAt: 1_700_000_050 });
    const ready = view([snapshot, spend]);

    render(<InventoryPanel ownerPubkey={OWNER} view={ready} query={query} online nowMs={61_000} />);

    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText(`31633:${OWNER}:farm:main`)).toBeInTheDocument();
    expect(screen.getByText(eventId('snap'))).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();

    const pumpkin = within(screen.getByTestId('balance-pumpkin'));
    expect(pumpkin.getByText('4')).toBeInTheDocument();
    expect(pumpkin.getByText('-2')).toBeInTheDocument();
    expect(pumpkin.getByText('2')).toBeInTheDocument();

    const strawberry = within(screen.getByTestId('balance-strawberry'));
    expect(strawberry.getByText('0')).toBeInTheDocument();
    expect(strawberry.getAllByText('2')).toHaveLength(2);

    const applied = screen.getByTestId('spend-applied');
    expect(within(applied).getByText('another-game')).toBeInTheDocument();
    expect(screen.getByText(/applied 1 · rejected 0 · folded 0 · voided 0/)).toBeInTheDocument();
    expect(screen.getByText(/updated 1m ago/)).toBeInTheDocument();
  });

  it('shows the fold chain and classifies settled spends as folded', () => {
    const fold = foldEvent({ id: M1, spends: [S1], voids: [S2] });
    const snapshot = snapshotEvent({ items: { [PUMPKIN.address]: 2 }, fold: { eventId: M1, relay: 'wss://relay.primal.net' } });
    const ready = view([
      snapshot,
      fold,
      spendEvent({ id: S1, item: PUMPKIN.address, quantity: 2 }),
      spendEvent({ id: S2, item: PUMPKIN.address, quantity: 9 }),
    ]);

    render(<InventoryPanel ownerPubkey={OWNER} view={ready} query={query} online />);

    expect(screen.getByText('head')).toBeInTheDocument();
    expect(screen.getByText(M1)).toBeInTheDocument();
    expect(screen.getByTestId('spend-folded')).toBeInTheDocument();
    expect(screen.getByTestId('spend-voided')).toBeInTheDocument();
    expect(screen.getByText(/settled spend ids 2 \(folded 1, voided 1\)/)).toBeInTheDocument();
  });

  it('withholds effective balances and lists the problem when the chain is unresolved', () => {
    const unresolved = view([snapshotEvent({ items: { [PUMPKIN.address]: 4 }, fold: { eventId: M1 } })]);
    expect(unresolved.status).toBe('unresolved');

    render(<InventoryPanel ownerPubkey={OWNER} view={unresolved} query={query} online />);

    expect(screen.getAllByText('unresolved').length).toBeGreaterThan(1);
    expect(screen.getByText('Problems')).toBeInTheDocument();
    expect(screen.getByText('Missing folds')).toBeInTheDocument();
    expect(within(screen.getByTestId('balance-pumpkin')).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByTestId('balance-pumpkin')).getByText('unresolved')).toBeInTheDocument();
    expect(screen.getByText(/effective column is withheld/)).toBeInTheDocument();
  });

  it('says when live-controller internals are not exposed rather than guessing', () => {
    render(<InventoryPanel ownerPubkey={OWNER} view={undefined} query={{ ...query, isPending: true }} online={false} />);
    expect(screen.getByText(/not exposed by the live controller/)).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('no data')).toBeInTheDocument();
  });

  it('offers no way to publish, sign, harvest or fold', () => {
    const ready = view([snapshotEvent({ items: { [PUMPKIN.address]: 1 } }), spendEvent({ id: S1, item: PUMPKIN.address })]);
    render(<InventoryPanel ownerPubkey={OWNER} view={ready} query={query} online />);

    const controls = [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')];
    for (const control of controls) {
      expect(control.textContent).not.toMatch(/publish|sign|harvest|settle|retry|refetch|write|credit/i);
    }
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });
});
