import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRODUCE_CATALOG } from '@/inventory/produce-catalog';
import { TestApp } from '@/test/TestApp';

// The HUD decides what to show from who is signed in. TestApp has no signer,
// so the current user is stubbed here and flipped per test.
let currentUser: { pubkey: string } | undefined;
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: currentUser, users: currentUser ? [currentUser] : [], metadata: { name: 'Quick Jaguar' } }),
}));

const { FarmHud } = await import('./FarmHud');

const CARROT = PRODUCE_CATALOG.carrot;
const PUMPKIN = PRODUCE_CATALOG.pumpkin;
const ABOUT = {
  farmName: 'Jaguar Hollow',
  mapName: 'Farm Field',
  mapDefinitionId: 'farm.field',
  mapRevision: 1,
  renderpack: { id: 'cozy-pixel-v1', version: '1.0.0' },
};

beforeEach(() => {
  currentUser = { pubkey: 'a'.repeat(64) };
});

describe('FarmHud', () => {
  it('keeps the app name and the farm name on the rail together', () => {
    render(
      <TestApp>
        <FarmHud farmName="Jaguar Hollow" about={ABOUT} produce={[]} produceStatus="ready" />
      </TestApp>
    );

    expect(screen.getByText('Nostr Farm')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Jaguar Hollow' })).toBeInTheDocument();
  });

  it('never prints the artwork version on the rail', () => {
    render(
      <TestApp>
        <FarmHud farmName="Jaguar Hollow" about={ABOUT} produce={[{ definition: CARROT, quantity: 3 }]} produceStatus="ready" />
      </TestApp>
    );

    expect(screen.queryByText(/cozy-pixel-v1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/1\.0\.0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/31633|kind:/)).not.toBeInTheDocument();
  });

  it('names each produce item in words with its count', () => {
    render(
      <TestApp>
        <FarmHud
          farmName="Jaguar Hollow"
          about={ABOUT}
          produce={[
            { definition: CARROT, quantity: 14 },
            { definition: PUMPKIN, quantity: 2 },
          ]}
          produceStatus="ready"
        />
      </TestApp>
    );

    expect(screen.getByRole('img', { name: '14 Carrot' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2 Pumpkin' })).toBeInTheDocument();
  });

  it('shows "Produce unavailable" instead of numbers when the inventory is unresolved', () => {
    render(
      <TestApp>
        <FarmHud farmName="Jaguar Hollow" about={ABOUT} produce={[]} produceStatus="unresolved" />
      </TestApp>
    );

    expect(screen.getByText('Produce unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Carrot/ })).not.toBeInTheDocument();
  });

  it('drops the produce tray to its own full-width row below the sm breakpoint', () => {
    render(
      <TestApp>
        <FarmHud farmName="Jaguar Hollow" about={ABOUT} produce={[{ definition: CARROT, quantity: 1 }]} produceStatus="ready" />
      </TestApp>
    );

    const tray = screen.getByTestId('produce-tray');
    // Full width and last in order on phones; inline and auto-width from sm up.
    expect(tray.className).toMatch(/\border-last\b/);
    expect(tray.className).toMatch(/\bw-full\b/);
    expect(tray.className).toMatch(/\bsm:order-none\b/);
    expect(tray.className).toMatch(/\bsm:w-auto\b/);
  });

  it('shows the tagline and no tray when nobody is signed in', () => {
    currentUser = undefined;
    render(
      <TestApp>
        <FarmHud />
      </TestApp>
    );

    expect(screen.getByText('Nostr Farm')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /cozy farming game/i })).toBeInTheDocument();
    expect(screen.queryByTestId('produce-tray')).not.toBeInTheDocument();
  });
});
