/**
 * The one place `@nostr-games/inventory` may ever be imported.
 *
 * Every protocol concern for kind:31632 — parsing, validation, primary-image
 * resolution, address building, filters and event construction — lives in that
 * package and is shared with the other games in the ecosystem. The Farm does
 * not carry a second implementation of any of it; this file is a re-export
 * surface so that swapping, upgrading or stubbing the protocol touches one
 * module, and so `src/inventory/boundary.test.ts` can enforce that.
 *
 * Nothing game-specific belongs here. Farm facts live in `./constants.ts`.
 */

export {
  // Kind + address identity. An item is `31632:<pubkey>:<d>`; a `d` alone is
  // never globally unique.
  KIND_GAME_ITEM_DEFINITION,
  buildGameItemAddress,
  parseGameItemAddress,
  BASED_ON_MARKER,

  // Parsing and validation.
  parseGameItemDefinition,
  parseGameItemDefinitionResult,
  validateGameItemDefinition,

  // Images: the spec's primary-image resolution rule, not a local copy of it.
  GAME_ITEM_IMAGE_MARKERS,
  selectPrimaryGameItemImage,
  getPrimaryItemImage,
  getItemImageByMarker,
  isGameItemImageMarker,

  // Event construction and querying.
  buildGameItemDefinitionEvent,
  buildGameItemDefinitionFilter,

  // kind:31633 inventories. The Farm writes exactly one context, `farm:main`.
  KIND_GAME_INVENTORY,
  buildGameInventoryAddress,
  parseGameInventoryAddress,
  parseGameInventory,
  parseGameInventoryResult,
  validateGameInventory,
  buildGameInventoryEvent,
  buildGameInventoryFilter,
  // The safe rewrite path: kind:31633 is replaceable, so anything the builder
  // does not regenerate and the caller does not preserve is destroyed for every
  // other client too.
  toBuildGameInventoryInput,
  addInventoryItemQuantity,
  setInventoryItemQuantity,
  getInventoryItemQuantity,
  getInventoryItems,
  compareGameInventoryRevisions,
  INVENTORY_REVISION_TAG,
} from '@nostr-games/inventory';

export type {
  GameItemDefinition,
  GameItemImage,
  GameItemImageMarker,
  GameItemImageMarkerValue,
  GameItemBasedOnReference,
  GameItemAddress,
  BuildGameItemDefinitionInput,
  BuildGameItemDefinitionFilterOptions,
  GameItemDefinitionFilter,
  ItemDefinitionValidationResult,
  ItemDefinitionValidationIssue,
  UnsignedEventTemplate,
  ParseWarning,

  GameInventory,
  GameInventoryItem,
  GameInventoryAddress,
  GameInventoryFilter,
  BuildGameInventoryInput,
  BuildGameInventoryItemInput,
  GameInventoryRevisionStatus,
  GameInventoryRevisionCandidate,
  InventoryValidationResult,
} from '@nostr-games/inventory';

/** Kinds defined by the inventory protocol. */
export const INVENTORY_KINDS = {
  /** Item definition (addressable). Implemented by the Item Registry. */
  itemDefinition: 31632,
  /** Per-context inventory (addressable). Not implemented yet. */
  inventory: 31633,
  /** Placement / equipment / decoration (addressable). Not implemented yet. */
  placement: 31634,
} as const;

/**
 * Inventories are per-context, never global. The Farm owns exactly one
 * inventory context and must never read or write another game's.
 */
export const FARM_INVENTORY_CONTEXT = 'farm:main';

export interface InventoryPackageStatus {
  installed: boolean;
  reason: string;
}

export function inventoryPackageStatus(): InventoryPackageStatus {
  return {
    installed: true,
    reason:
      '@nostr-games/inventory provides kind:31632 for the Item Registry and kind:31633 for the farm:main produce inventory.',
  };
}
