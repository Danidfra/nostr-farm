import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CROP_CATALOG } from '@/farm/crops/catalog';
import { evaluatePlant, plantSeed } from '@/farm/growth/evaluate';
import { systemClock } from '@/farm/time';
import { KIND_SLOT_STATE } from '@/nostr/kinds';
import { parseSlotState } from '@/nostr/slot-state';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { slotKey, type FarmSlots } from '@/hooks/farm/useFarmSlots';
import type { NostrEvent } from '@nostrify/nostrify';

/**
 * An opted-in build (`__DEV_TOOLS_ENABLED__ = true`), as
 * `VITE_ENABLE_DEV_TOOLS=true npm run build` or the dev server produce.
 */
vi.mock('@/dev/enabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/dev/enabled')>()),
  DEV_TOOLS_ENABLED: true,
}));

const AUTHORIZED = FARM_OFFICIAL_ISSUER_PUBKEY;
const STRANGER = 'b'.repeat(64);
const MAP = 'farm.field';

let currentPubkey: string | undefined = AUTHORIZED;
const published: NostrEvent[] = [];

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () =>
    currentPubkey
      ? { user: { pubkey: currentPubkey, signer: { signEvent: async (t: unknown) => t } } }
      : { user: undefined },
}));

vi.mock('@/hooks/useNostrPublish', () => ({
  useNostrPublish: () => ({
    mutateAsync: async (template: { kind: number; content: string; tags: string[][] }) => {
      const event: NostrEvent = {
        ...template,
        id: `${published.length + 1}`.padStart(64, '0'),
        pubkey: currentPubkey ?? '',
        created_at: systemClock.now(),
        sig: 'x'.repeat(128),
      };
      published.push(event);
      return event;
    },
  }),
}));

const { default: DevFarmTools } = await import('./DevFarmTools');
const { useAccelerateCrop } = await import('./useAccelerateCrop');

let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function seededSlots(): FarmSlots {
  const byAddress = new Map();
  byAddress.set(slotKey(MAP, 2, 1), {
    slot: { coord: { x: 2, y: 1 }, content: { type: 'plant', plant: plantSeed('strawberry', systemClock.now() - 20) } },
    sourceEventId: 'p'.repeat(64),
  });
  byAddress.set(slotKey(MAP, 0, 0), { slot: { coord: { x: 0, y: 0 }, content: { type: 'empty' } } });
  return { byAddress };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  currentPubkey = AUTHORIZED;
  published.length = 0;
});

describe('DevFarmTools in an opted-in build', () => {
  it('shows the panel to the authorized key, with the selected crop and its stage', () => {
    render(<DevFarmTools mapId={MAP} slots={seededSlots()} nowSec={systemClock.now()} />, { wrapper });

    expect(screen.getByTestId('dev-farm-tools')).toBeInTheDocument();
    expect(screen.getByText(/publish real Nostr events/i)).toBeInTheDocument();
    expect(screen.getByText('strawberry')).toBeInTheDocument();
    expect(screen.getByText(`0 / ${CROP_CATALOG.strawberry.harvestStage}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /make harvestable/i })).toBeEnabled();
  });

  it('publishes nothing merely by being opened', () => {
    render(<DevFarmTools mapId={MAP} slots={seededSlots()} nowSec={systemClock.now()} />, { wrapper });
    expect(published).toHaveLength(0);
  });

  it('makes the crop harvestable through one real kind:31417 replacement', async () => {
    const key = ['farm-slots', AUTHORIZED, MAP];
    client.setQueryData<FarmSlots>(key, seededSlots());

    render(<DevFarmTools mapId={MAP} slots={seededSlots()} nowSec={systemClock.now()} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /make harvestable/i }));

    await waitFor(() => expect(screen.getByTestId('dev-farm-tools-published')).toBeInTheDocument());

    // Exactly one event, of the world-state kind, owner-signed, for that slot.
    expect(published).toHaveLength(1);
    const event = published[0];
    expect(event.kind).toBe(KIND_SLOT_STATE);
    expect(event.pubkey).toBe(AUTHORIZED);
    const parsed = parseSlotState(event);
    expect(parsed?.mapId).toBe(MAP);
    expect(parsed?.slot.coord).toEqual({ x: 2, y: 1 });
    expect(parsed?.slot.content.type).toBe('plant');
    if (parsed?.slot.content.type !== 'plant') return;
    expect(parsed.slot.content.plant.cropId).toBe('strawberry');
    expect(evaluatePlant(parsed.slot.content.plant, systemClock.now(), CROP_CATALOG.strawberry).harvestable).toBe(true);

    // The field will harvest THIS event: the cache now names its id.
    const cached = client.getQueryData<FarmSlots>(key)?.byAddress.get(slotKey(MAP, 2, 1));
    expect(cached?.sourceEventId).toBe(event.id);
    expect(cached?.slot.content.type).toBe('plant');
  });

  it('renders nothing for a different key', () => {
    currentPubkey = STRANGER;
    const { container } = render(<DevFarmTools mapId={MAP} slots={seededSlots()} nowSec={systemClock.now()} />, { wrapper });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /make harvestable/i })).not.toBeInTheDocument();
  });

  it('renders nothing when logged out', () => {
    currentPubkey = undefined;
    const { container } = render(<DevFarmTools mapId={MAP} slots={seededSlots()} nowSec={systemClock.now()} />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it('refuses to accelerate for a different key even when called directly', async () => {
    currentPubkey = STRANGER;
    const { result } = renderHook(() => useAccelerateCrop(), { wrapper });
    const record = seededSlots().byAddress.get(slotKey(MAP, 2, 1))!;

    await expect(result.current.mutateAsync({ mapId: MAP, record })).rejects.toThrow(/not available/i);
    expect(published).toHaveLength(0);
  });

  it('refuses an empty slot and a rotten crop', async () => {
    const { result } = renderHook(() => useAccelerateCrop(), { wrapper });
    const empty = seededSlots().byAddress.get(slotKey(MAP, 0, 0))!;
    await expect(result.current.mutateAsync({ mapId: MAP, record: empty })).rejects.toThrow(/nothing is planted/i);

    const rottenSeed = plantSeed('strawberry', systemClock.now() - CROP_CATALOG.strawberry.rotAfterDrySec - 5);
    const rotten = { slot: { coord: { x: 3, y: 0 }, content: { type: 'plant' as const, plant: rottenSeed } }, sourceEventId: 'r'.repeat(64) };
    await expect(result.current.mutateAsync({ mapId: MAP, record: rotten })).rejects.toThrow(/rotten/i);
    expect(published).toHaveLength(0);
  });
});
