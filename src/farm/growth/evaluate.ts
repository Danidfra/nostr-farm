import { toDurationSec, toWholeSeconds, type UnixSeconds } from '../time';
import type { CropDefinition } from '../crops/types';
import type { PlantPhase, PlantState, PlantView } from './types';

/**
 * GROWTH MODEL
 * ============
 *
 * A plant banks "growth seconds". Growth seconds accrue **only while the plant
 * is wet**, and wetness is a single interval that ends at `wetUntil`.
 *
 *   totalGrowth(now) = growthSec + max(0, min(now, wetUntil) - growthUpdatedAt)
 *
 * Consequences, all of them intended:
 *
 * - Dry time is never banked. Time spent past `wetUntil` contributes nothing,
 *   so leaving a crop dry for a week and then watering it does not produce an
 *   instant jump.
 * - Evaluation is deterministic and idempotent. Calling this at `t` any number
 *   of times, or skipping straight from `t0` to `t0 + 10 days`, yields the same
 *   answer. Nothing has to "tick", so there is no host processor and no drift.
 * - Watering resumes progression: it folds the accrued growth into `growthSec`
 *   and pushes `wetUntil` forward. It never credits the dry gap.
 * - Wet plants cannot rot. Rot happens at `wetUntil + rotAfterDrySec`, which is
 *   strictly after the plant goes dry.
 */

/** Growth seconds accrued between `growthUpdatedAt` and `nowSec`. */
export function accruedGrowthSec(plant: PlantState, nowSec: UnixSeconds): number {
  const wetEnd = Math.min(nowSec, plant.wetUntil);
  return Math.max(0, wetEnd - plant.growthUpdatedAt);
}

/** Total growth seconds banked at `nowSec`. */
export function totalGrowthSec(plant: PlantState, nowSec: UnixSeconds): number {
  return Math.max(0, plant.growthSec) + accruedGrowthSec(plant, nowSec);
}

/** A plant is wet while `now < wetUntil`. At exactly `wetUntil` it is dry. */
export function isWet(plant: PlantState, nowSec: UnixSeconds): boolean {
  return nowSec < plant.wetUntil;
}

/** Seconds until the plant dries out; 0 when already dry. */
export function secondsUntilDry(plant: PlantState, nowSec: UnixSeconds): number {
  return Math.max(0, plant.wetUntil - nowSec);
}

/** Instant at which an unwatered plant rots. */
export function rotsAt(plant: PlantState, crop: CropDefinition): UnixSeconds {
  return plant.wetUntil + crop.rotAfterDrySec;
}

/**
 * A plant is rotten once it has been dry for `rotAfterDrySec`.
 * The boundary is inclusive: at exactly `rotsAt` the plant is rotten.
 */
export function isRotten(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): boolean {
  return nowSec >= rotsAt(plant, crop);
}

/**
 * Current growth stage.
 *
 * The boundary is inclusive: exactly `n * stageDurationSec` banked growth means
 * stage `n`. Clamped to `[0, harvestStage]` — a crop never grows past harvest.
 */
export function growthStage(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): number {
  const raw = Math.floor(totalGrowthSec(plant, nowSec) / crop.stageDurationSec);
  return Math.max(0, Math.min(raw, crop.harvestStage));
}

/** Lifecycle phase at `nowSec`. Rot takes precedence over readiness. */
export function plantPhase(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): PlantPhase {
  if (isRotten(plant, nowSec, crop)) return 'rotten';
  if (growthStage(plant, nowSec, crop) >= crop.harvestStage) return 'ready';
  return 'growing';
}

/** A crop can be harvested once it reaches its harvest stage and has not rotted. */
export function isHarvestable(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): boolean {
  return plantPhase(plant, nowSec, crop) === 'ready';
}

/**
 * Whether watering would help right now: the plant is alive, still growing and
 * currently dry. A ready crop does not need water to grow, but watering it is
 * still permitted (see `waterPlant`) because it postpones rot.
 */
export function needsWater(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): boolean {
  return plantPhase(plant, nowSec, crop) === 'growing' && !isWet(plant, nowSec);
}

/** Create the state of a freshly planted seed. Seeds start DRY and must be watered. */
export function plantSeed(cropId: string, nowSec: UnixSeconds): PlantState {
  const at = toWholeSeconds(nowSec, 0);
  return {
    cropId,
    plantedAt: at,
    growthSec: 0,
    growthUpdatedAt: at,
    // wetUntil === plantedAt means "already dry": nothing grows until watered.
    wetUntil: at,
  };
}

/**
 * Apply one watering.
 *
 * Banks the growth accrued so far, then extends wetness from whichever is
 * later — the existing `wetUntil` or `now` — by `waterDurationSec`, capped at
 * `now + maxWetBufferSec`. The cap is what stops a player from stacking hours
 * of wetness in one sitting.
 */
export function waterPlant(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): PlantState {
  const banked = totalGrowthSec(plant, nowSec);
  const base = Math.max(plant.wetUntil, nowSec);
  const cap = nowSec + crop.maxWetBufferSec;
  const wetUntil = Math.min(base + crop.waterDurationSec, cap);

  return {
    ...plant,
    growthSec: banked,
    growthUpdatedAt: nowSec,
    wetUntil,
  };
}

/** `true` when another watering would actually push `wetUntil` forward. */
export function canAbsorbWater(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): boolean {
  return waterPlant(plant, nowSec, crop).wetUntil > plant.wetUntil;
}

/**
 * Coerce untrusted plant state (relay tags, hand-edited JSON, dev tools) into a
 * coherent `PlantState`. Never throws; unusable numbers fall back to `nowSec`.
 */
export function normalizePlantState(input: Partial<PlantState> & { cropId: string }, nowSec: UnixSeconds): PlantState {
  const plantedAt = toWholeSeconds(input.plantedAt, nowSec);
  const growthUpdatedAt = toWholeSeconds(input.growthUpdatedAt, plantedAt);
  return {
    cropId: input.cropId,
    plantedAt,
    growthSec: toDurationSec(input.growthSec, 0),
    growthUpdatedAt,
    wetUntil: toWholeSeconds(input.wetUntil, growthUpdatedAt),
  };
}

/** Derive everything the UI needs from `(plant, now, crop)`. */
export function evaluatePlant(plant: PlantState, nowSec: UnixSeconds, crop: CropDefinition): PlantView {
  const growthSec = totalGrowthSec(plant, nowSec);
  const stage = growthStage(plant, nowSec, crop);
  const phase = plantPhase(plant, nowSec, crop);
  const wet = isWet(plant, nowSec);
  const untilDry = secondsUntilDry(plant, nowSec);

  const atMaxStage = stage >= crop.harvestStage;
  const growthSecUntilNextStage = atMaxStage ? null : (stage + 1) * crop.stageDurationSec - growthSec;
  const growthSecUntilReady = atMaxStage ? null : crop.harvestStage * crop.stageDurationSec - growthSec;

  // Without further watering, only `untilDry` more growth seconds can accrue.
  const etaFor = (needed: number | null): number | null =>
    needed === null ? null : needed <= untilDry ? needed : null;

  const rotAt = rotsAt(plant, crop);

  return {
    cropId: plant.cropId,
    phase,
    stage,
    harvestStage: crop.harvestStage,
    wet,
    growthSec,
    stageProgressSec: Math.min(growthSec - stage * crop.stageDurationSec, crop.stageDurationSec),
    stageDurationSec: crop.stageDurationSec,
    secondsUntilDry: untilDry,
    growthSecUntilNextStage,
    growthSecUntilReady,
    etaSecUntilNextStage: etaFor(growthSecUntilNextStage),
    etaSecUntilReady: etaFor(growthSecUntilReady),
    rotsAt: rotAt,
    secondsUntilRot: Math.max(0, rotAt - nowSec),
    harvestable: phase === 'ready',
    needsWater: phase === 'growing' && !wet,
  };
}
