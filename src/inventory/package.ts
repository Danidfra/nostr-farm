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

  // Event construction.
  buildGameItemDefinitionEvent,
} from '@nostr-games/inventory';

export type {
  GameItemDefinition,
  GameItemImage,
  GameItemImageMarker,
  GameItemImageMarkerValue,
  GameItemBasedOnReference,
  GameItemAddress,
  BuildGameItemDefinitionInput,
  ItemDefinitionValidationResult,
  ItemDefinitionValidationIssue,
  UnsignedEventTemplate,
  ParseWarning,
} from '@nostr-games/inventory';

import { KIND_GAME_ITEM_DEFINITION } from '@nostr-games/inventory';

/**
 * A Nostr filter for kind:31632 events.
 *
 * SHIM. `@nostr-games/inventory` has `buildGameItemDefinitionFilter` in its
 * source tree, but the published 0.3.0 does not export it — only the
 * placement equivalent shipped. Rather than depend on an unpublished local
 * checkout, the Farm builds the filter here and deletes this the moment a
 * release exports it. The shape is deliberately identical to the package's.
 *
 * `authors` and `itemIds` intersect, so a single call is only correct for one
 * issuer at a time: several issuers plus several `d` values would also match
 * the cross product — issuer A's definition of issuer B's `d`. Two issuers
 * using the same `d` are two DIFFERENT items, so always verify the resolved
 * address rather than assuming the relay narrowed it.
 */
export interface GameItemDefinitionFilter {
  kinds: [typeof KIND_GAME_ITEM_DEFINITION];
  authors?: string[];
  '#d'?: string[];
  '#t'?: string[];
}

export interface BuildGameItemDefinitionFilterOptions {
  authors?: string[];
  itemIds?: string[];
  topics?: string[];
}

function uniqueNonBlank(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') seen.add(value);
  }
  return [...seen];
}

export function buildGameItemDefinitionFilter(
  options: BuildGameItemDefinitionFilterOptions = {}
): GameItemDefinitionFilter {
  const filter: GameItemDefinitionFilter = { kinds: [KIND_GAME_ITEM_DEFINITION] };

  const authors = uniqueNonBlank(options.authors);
  if (authors.length > 0) filter.authors = authors;

  const itemIds = uniqueNonBlank(options.itemIds);
  if (itemIds.length > 0) filter['#d'] = itemIds;

  const topics = uniqueNonBlank(options.topics);
  if (topics.length > 0) filter['#t'] = topics;

  return filter;
}

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
    reason: '@nostr-games/inventory provides kind:31632 for the Item Registry. Kind 31633 is not wired up yet.',
  };
}
