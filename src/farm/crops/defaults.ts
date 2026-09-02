import { toDurationSec } from '../time';
import type { CropDefinition, CropDefinitionInput } from './types';

/** Wet seconds required per growth stage when a crop does not say otherwise. */
export const DEFAULT_STAGE_DURATION_SEC = 300;

/** Wet seconds granted per watering when a crop does not say otherwise. */
export const DEFAULT_WATER_DURATION_SEC = DEFAULT_STAGE_DURATION_SEC;

/** Wetness may be stacked at most this far ahead of "now" by default. */
export const DEFAULT_MAX_WET_BUFFER_SEC = 2 * DEFAULT_WATER_DURATION_SEC;

/** Dry seconds tolerated before rot, by default two full stages. */
export const DEFAULT_ROT_AFTER_DRY_SEC = 2 * DEFAULT_STAGE_DURATION_SEC;

/** Sprite frames a crop is assumed to have when unspecified. */
export const DEFAULT_STAGES = 4;

/**
 * Fill in a partially specified crop and clamp it into a coherent shape.
 *
 * Invariants enforced here so the growth model never has to defend itself:
 * - `stages >= 1`
 * - `0 <= harvestStage <= stages - 1`
 * - every duration is a whole number of seconds
 * - `stageDurationSec >= 1` (a zero-length stage would make growth undefined)
 * - `waterDurationSec >= 1` (watering must always make a plant wet)
 * - `maxWetBufferSec >= waterDurationSec` (one watering is always fully applied)
 * - `rotAfterDrySec >= 1` (a wet plant can never be rotten)
 */
export function normalizeCropDefinition(id: string, input: CropDefinitionInput = {}): CropDefinition {
  const stages = Math.max(1, Math.trunc(toDurationSec(input.stages, DEFAULT_STAGES) || DEFAULT_STAGES));

  const harvestStageRaw = input.harvestStage === undefined
    ? stages - 1
    : Math.trunc(toDurationSec(input.harvestStage, stages - 1));
  const harvestStage = Math.max(0, Math.min(harvestStageRaw, stages - 1));

  const stageDurationSec = Math.max(1, toDurationSec(input.stageDurationSec, DEFAULT_STAGE_DURATION_SEC) || DEFAULT_STAGE_DURATION_SEC);
  const waterDurationSec = Math.max(1, toDurationSec(input.waterDurationSec, stageDurationSec) || stageDurationSec);
  const maxWetBufferSec = Math.max(waterDurationSec, toDurationSec(input.maxWetBufferSec, 2 * waterDurationSec));
  const rotAfterDrySec = Math.max(1, toDurationSec(input.rotAfterDrySec, 2 * stageDurationSec) || 2 * stageDurationSec);

  return { id, stages, harvestStage, stageDurationSec, waterDurationSec, maxWetBufferSec, rotAfterDrySec };
}
