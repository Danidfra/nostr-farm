import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';

import { selectNewestInventory, produceQuantity } from '@/inventory/farm-inventory';
import { PRODUCE_CATALOG, PRODUCE_CROP_IDS, type ProduceDefinition } from '@/inventory/produce-catalog';
import type { GameInventory } from '@/inventory/package';
import { readFarmInventory } from './inventory-relays';

export const FARM_INVENTORY_KEY = 'farm-inventory';

export function farmInventoryQueryKey(ownerPubkey: string | undefined) {
  return [FARM_INVENTORY_KEY, ownerPubkey ?? null] as const;
}

export interface FarmInventoryView {
  /** The parsed inventory, or `null` when the reads found none. */
  inventory: GameInventory | null;
  /** Official produce held, in catalog order. Zero quantities are omitted. */
  produce: { definition: ProduceDefinition; quantity: number }[];
}

/**
 * Read the player's own `farm:main` inventory.
 *
 * READ ONLY — it never publishes and never creates an inventory. A resolved
 * `null` here is display state; it is emphatically NOT the base a write may
 * build a replacement from. `creditHarvest` does its own confirmed read inside
 * the write lock for exactly that reason.
 */
export function useFarmInventory(ownerPubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<FarmInventoryView>({
    queryKey: farmInventoryQueryKey(ownerPubkey),
    enabled: !!ownerPubkey,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      if (!ownerPubkey) return { inventory: null, produce: [] };

      const read = await readFarmInventory(nostr, ownerPubkey, signal)();
      if (!read.answered) throw new Error('Could not reach any relay to read your produce.');

      return toView(selectNewestInventory(read.events, ownerPubkey));
    },
  });
}

export function toView(inventory: GameInventory | null): FarmInventoryView {
  const produce = PRODUCE_CROP_IDS.map((cropId) => PRODUCE_CATALOG[cropId])
    .map((definition) => ({ definition, quantity: produceQuantity(inventory, definition.address) }))
    .filter((entry) => entry.quantity > 0);

  return { inventory, produce };
}

/**
 * Show a freshly published inventory immediately, without waiting for relays to
 * serve it back. Never moves the view backwards in time.
 */
export function setFarmInventory(
  queryClient: QueryClient,
  ownerPubkey: string,
  inventory: GameInventory | null
): void {
  queryClient.setQueryData<FarmInventoryView>(farmInventoryQueryKey(ownerPubkey), (previous) => {
    if (previous?.inventory && inventory && previous.inventory.event.created_at > inventory.event.created_at) {
      return previous;
    }
    return toView(inventory);
  });
}
