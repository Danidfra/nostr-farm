import type { CropDefinition } from '@/farm/crops/types';
import { isRotten, waterPlant } from '@/farm/growth/evaluate';
import type { PlantState } from '@/farm/growth/types';
import type { UnixSeconds } from '@/farm/time';

/**
 * The plant state a crop would be in had it been watered all the way to its
 * harvest stage: the same five persisted fields, with the growth banked at
 * exactly `harvestStage × stageDurationSec` and one normal watering applied so
 * the crop is wet and protected from rot for the usual window.
 *
 * Nothing here is a second growth model. The result is ordinary input state
 * that `evaluatePlant` and `applyFarmAction` read like any other; the crop's
 * definition is not consulted for anything but the same numbers the real
 * growth used. A rotten crop is refused: rot is cleared, not undone.
 *
 * Pure. The caller publishes it as a normal kind:31417 replacement.
 */
export function acceleratedToReady(plant: PlantState, crop: CropDefinition, nowSec: UnixSeconds): PlantState {
  if (isRotten(plant, nowSec, crop)) {
    throw new Error('This crop is rotten. Clear it on the field first.');
  }
  const banked: PlantState = {
    ...plant,
    growthSec: crop.harvestStage * crop.stageDurationSec,
    growthUpdatedAt: nowSec,
    wetUntil: Math.min(plant.wetUntil, nowSec),
  };
  return waterPlant(banked, nowSec, crop);
}
