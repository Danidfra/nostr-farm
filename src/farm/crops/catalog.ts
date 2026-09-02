import { normalizeCropDefinition } from './defaults';
import type { CropCatalog, CropDefinition, CropDefinitionInput } from './types';

/**
 * Version of the gameplay balance below. Bump whenever timings change so saved
 * state and bug reports can be attributed to a known balance.
 */
export const CROP_CATALOG_VERSION = '1';

/**
 * Source-controlled crop balance.
 *
 * V1 deliberately keeps every crop on identical timings: this milestone is
 * about architecture, not balance. Sprites for these crops come from the
 * renderpack (see `src/world/renderpack`).
 */
const AUTHORED: Record<string, CropDefinitionInput> = {
  carrot: {},
  parsnip: {},
  pumpkin: {},
  strawberry: {},
};

export const CROP_CATALOG: CropCatalog = Object.freeze(
  Object.fromEntries(
    Object.entries(AUTHORED).map(([id, input]) => [id, Object.freeze(normalizeCropDefinition(id, input))])
  )
);

export const CROP_IDS: readonly string[] = Object.freeze(Object.keys(CROP_CATALOG));

/** Look a crop up by id. Returns `undefined` for unknown crops — never throws. */
export function getCrop(cropId: string | undefined, catalog: CropCatalog = CROP_CATALOG): CropDefinition | undefined {
  if (!cropId) return undefined;
  return catalog[cropId];
}
