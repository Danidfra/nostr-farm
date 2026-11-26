import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CREATE_FARM, ERRORS, RESTORE_FARM } from '@/components/farm/copy';
import type { FarmLookup } from '@/hooks/farm/farm-lookup';
import { TestApp } from '@/test/TestApp';
import { FARM_OWNER, worldEvent } from '@/test/farm-fixtures';
import { parseWorldState } from '@/nostr/world-state';

/**
 * The gate in front of the field, driven by what the lookup reported.
 *
 * The one rule under test: the Create button exists only for a CONFIRMED
 * absence. Every other state shows something that cannot publish a world.
 */

let lookup: { data?: FarmLookup; isLoading: boolean; isError: boolean; error?: Error };
const createFarm = vi.fn();

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: FARM_OWNER, signer: {} } }),
}));
vi.mock('@/hooks/farm/useFarm', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks/farm/useFarm')>();
  return { ...original, useFarm: () => ({ ...lookup, refetch: vi.fn() }) };
});
vi.mock('@/hooks/farm/useCreateFarm', () => ({
  useCreateFarm: () => ({ createFarm, isCreating: false }),
}));
vi.mock('@/hooks/farm/useFarmSlots', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks/farm/useFarmSlots')>();
  return { ...original, useFarmSlots: () => ({ data: undefined }) };
});
vi.mock('@/hooks/farm/useFarmInventory', () => ({
  useFarmInventory: () => ({ data: undefined, isPending: true }),
}));
vi.mock('@/hooks/farm/useProduceChanges', () => ({ useProduceChanges: () => [] }));
vi.mock('@/hooks/farm/useRenderpack', () => ({
  useRenderpack: () => ({ data: undefined, isLoading: true, isError: false }),
}));

const { default: FarmPage } = await import('./FarmPage');

function renderPage(state: typeof lookup) {
  lookup = state;
  return render(
    <TestApp>
      <FarmPage />
    </TestApp>
  );
}

const createButton = () => screen.queryByRole('button', { name: CREATE_FARM.action });

beforeEach(() => {
  createFarm.mockReset();
});

describe('the farm gate', () => {
  it('offers to create a farm only when absence is confirmed', () => {
    renderPage({ data: { status: 'absent' }, isLoading: false, isError: false });
    expect(createButton()).not.toBeNull();
    expect(screen.getByLabelText('Farm name')).toBeInTheDocument();
  });

  it('shows a retry and no Create button while the lookup is unconfirmed', () => {
    renderPage({ data: { status: 'unknown', reason: 'unreachable', detail: 'wss://relay.primal.net: closed' }, isLoading: false, isError: false });
    expect(screen.getByText(ERRORS.farmUnknownTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ERRORS.retry })).toBeInTheDocument();
    expect(createButton()).toBeNull();
    expect(screen.queryByLabelText('Farm name')).toBeNull();
  });

  it('shows no Create button while loading or after a thrown error', () => {
    const { unmount } = renderPage({ data: undefined, isLoading: true, isError: false });
    expect(createButton()).toBeNull();
    unmount();

    renderPage({ data: undefined, isLoading: false, isError: true, error: new Error('unknown map definition') });
    expect(screen.getByText(ERRORS.farmTitle)).toBeInTheDocument();
    expect(createButton()).toBeNull();
  });

  it('offers only to restore the field, without a name, when the world exists and the field does not', () => {
    const world = parseWorldState(worldEvent({ name: 'Willow Patch' }))!;
    renderPage({ data: { status: 'field-missing', world }, isLoading: false, isError: false });

    expect(screen.getByText(RESTORE_FARM.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: RESTORE_FARM.action })).toBeInTheDocument();
    expect(createButton()).toBeNull();
    expect(screen.queryByLabelText('Farm name')).toBeNull();
  });

  it('shows the field, not a gate, when the farm was found', () => {
    const world = parseWorldState(worldEvent({ name: 'Willow Patch' }))!;
    const farm = {
      world,
      map: { event: world.event, id: 'farm.field', version: '2', owner: FARM_OWNER, worldId: 'farm', definitionId: 'farm.field' },
      definition: { id: 'farm.field', name: 'Farm Field', revision: 1 },
    } as unknown as NonNullable<Extract<FarmLookup, { status: 'found' }>['farm']>;
    renderPage({ data: { status: 'found', farm }, isLoading: false, isError: false });

    expect(createButton()).toBeNull();
    expect(screen.queryByText(RESTORE_FARM.title)).toBeNull();
    expect(screen.queryByText(ERRORS.farmUnknownTitle)).toBeNull();
    expect(screen.getByText('Willow Patch')).toBeInTheDocument();
  });
});
