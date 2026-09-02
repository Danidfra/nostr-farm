import type { HarvestResult } from '@/farm/harvest/types';
import { FARM_INVENTORY_CONTEXT } from './package';

/**
 * The Farm's view of "an inventory".
 *
 * Narrow on purpose. The application talks to this interface; only
 * `./package.ts` is allowed to know how it is implemented, and `src/farm` does
 * not know it exists at all — a `HarvestResult` is a plain domain value that
 * the application hands over, not something the domain publishes.
 */
export interface InventoryItemRef {
  /** Addressable coordinate of the item definition (kind 31632). */
  definitionAddress: string;
  quantity: number;
}

export interface InventoryAdapter {
  /** Inventory context this adapter writes to, e.g. `farm:main`. */
  readonly context: string;
  /** Whether a real implementation is wired up. */
  isAvailable(): boolean;
  /** Credit a harvest. Resolves to the items credited, or `null` when unavailable. */
  credit(harvest: HarvestResult): Promise<InventoryItemRef[] | null>;
}

/**
 * V1 adapter: records nothing, publishes nothing, and says so.
 *
 * Harvesting stops at the domain result on purpose. The protocol package is now
 * a dependency — the Item Registry uses its kind:31632 half — but kind:31633
 * inventory writes are a separate milestone with their own protocol review, so
 * this stays unavailable until that lands.
 */
export function createNullInventoryAdapter(context: string = FARM_INVENTORY_CONTEXT): InventoryAdapter {
  return {
    context,
    isAvailable: () => false,
    credit: async () => null,
  };
}
