import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEV_TOOLS_ENABLED } from '@/dev/enabled';
import { plantSeed } from '@/farm/growth/evaluate';
import { systemClock } from '@/farm/time';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { slotKey, type FarmSlots } from '@/hooks/farm/useFarmSlots';

/**
 * The default build: no `__DEV_TOOLS_ENABLED__` literal, which is what a
 * production build without `VITE_ENABLE_DEV_TOOLS=true` ships. Even the
 * authorized key gets nothing.
 */
const MAP = 'farm.field';
const published: unknown[] = [];

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, signer: { signEvent: async (t: unknown) => t } } }),
}));

vi.mock('@/hooks/useNostrPublish', () => ({
  useNostrPublish: () => ({
    mutateAsync: async (template: unknown) => {
      published.push(template);
      return template;
    },
  }),
}));

const { default: DevFarmTools } = await import('./DevFarmTools');
const { useAccelerateCrop } = await import('./useAccelerateCrop');

const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function slots(): FarmSlots {
  const byAddress = new Map();
  byAddress.set(slotKey(MAP, 2, 1), {
    slot: { coord: { x: 2, y: 1 }, content: { type: 'plant', plant: plantSeed('strawberry', systemClock.now()) } },
    sourceEventId: 'p'.repeat(64),
  });
  return { byAddress };
}

describe('DevFarmTools in a default build', () => {
  it('is a build without developer tools', () => {
    expect(DEV_TOOLS_ENABLED).toBe(false);
  });

  it('renders nothing for the authorized key', () => {
    const { container } = render(<DevFarmTools mapId={MAP} slots={slots()} nowSec={systemClock.now()} />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it('refuses to accelerate even when the hook is called directly', async () => {
    const { result } = renderHook(() => useAccelerateCrop(), { wrapper });
    const record = slots().byAddress.get(slotKey(MAP, 2, 1))!;
    await expect(result.current.mutateAsync({ mapId: MAP, record })).rejects.toThrow(/not available/i);
    expect(published).toHaveLength(0);
  });
});
