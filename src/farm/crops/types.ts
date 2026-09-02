/**
 * Crop gameplay definitions.
 *
 * Gameplay numbers live in source control (see `catalog.ts`), NOT in the
 * renderpack. The renderpack describes visuals only; mixing the two would let
 * artwork edits silently rebalance the game.
 */

export interface CropDefinition {
  /** Stable crop identifier, e.g. "carrot". */
  id: string;
  /** Number of sprite frames / growth stages, indices `0 .. stages - 1`. */
  stages: number;
  /** Stage index at which the crop becomes harvestable. */
  harvestStage: number;
  /** Wet seconds of growth required to advance one stage. */
  stageDurationSec: number;
  /** Wet seconds granted by a single watering action. */
  waterDurationSec: number;
  /** Hard cap on how far ahead of "now" wetness may be stacked. */
  maxWetBufferSec: number;
  /** Consecutive dry seconds tolerated before the crop rots. */
  rotAfterDrySec: number;
}

/** A crop definition as authored: everything except `id` may be omitted. */
export type CropDefinitionInput = Partial<Omit<CropDefinition, 'id'>>;

export type CropCatalog = Readonly<Record<string, CropDefinition>>;
