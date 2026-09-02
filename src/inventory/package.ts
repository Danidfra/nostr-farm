/**
 * The one place `@nostr-games/inventory` may ever be imported.
 *
 * Nothing else in the app — and above all nothing under `src/farm` — may depend
 * on the inventory protocol package. Keeping the import surface to this file
 * means swapping, upgrading or stubbing the protocol touches one module.
 *
 * The package is not installed yet: this milestone builds the boundary, not the
 * integration. When it is added, the imports go here and here only.
 */

/** Kinds defined by the inventory protocol, recorded for documentation. */
export const INVENTORY_KINDS = {
  /** Item definition (addressable). */
  itemDefinition: 31632,
  /** Per-context inventory (addressable). */
  inventory: 31633,
  /** Placement / equipment / decoration (addressable). Not used yet. */
  placement: 31634,
} as const;

/**
 * Inventories are per-context, never global. The Farm owns exactly one context
 * and must never read or write another game's.
 */
export const FARM_INVENTORY_CONTEXT = 'farm:main';

export interface InventoryPackageStatus {
  installed: boolean;
  reason: string;
}

export function inventoryPackageStatus(): InventoryPackageStatus {
  return {
    installed: false,
    reason: '@nostr-games/inventory is not a dependency yet; the Farm has no inventory integration in V1.',
  };
}
