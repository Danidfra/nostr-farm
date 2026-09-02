import type { UnixSeconds } from '../time';

/**
 * Authoritative persisted state of one planted crop.
 *
 * The whole growth model is derivable from these five fields plus `nowSec`.
 * There is no "current stage" field: stage is always computed, so no processor
 * has to tick anything and two clients always agree.
 */
export interface PlantState {
  /** Crop identifier, resolved against the crop catalog. */
  cropId: string;
  /** When the seed went into the ground. */
  plantedAt: UnixSeconds;
  /** Growth seconds already banked as of `growthUpdatedAt`. */
  growthSec: number;
  /** Reference point for accruing further growth. */
  growthUpdatedAt: UnixSeconds;
  /** The plant is wet while `now < wetUntil`. Growth accrues only while wet. */
  wetUntil: UnixSeconds;
}

/** Coarse lifecycle phase of a planted crop. */
export type PlantPhase = 'growing' | 'ready' | 'rotten';

/** Fully derived, render-ready view of a plant at a given instant. */
export interface PlantView {
  cropId: string;
  phase: PlantPhase;
  /** Current stage index, clamped to `[0, harvestStage]`. */
  stage: number;
  /** Stage index at which the crop can be harvested. */
  harvestStage: number;
  /** `true` while `now < wetUntil`. */
  wet: boolean;
  /** Total growth seconds banked at `nowSec`. */
  growthSec: number;
  /** Growth seconds accrued inside the current stage. */
  stageProgressSec: number;
  /** Growth seconds one stage costs. */
  stageDurationSec: number;
  /** Seconds until the plant dries out, or 0 if already dry. */
  secondsUntilDry: number;
  /** Growth seconds still needed to reach the next stage, or null at max stage. */
  growthSecUntilNextStage: number | null;
  /** Growth seconds still needed to become harvestable, or null if already there. */
  growthSecUntilReady: number | null;
  /**
   * Wall-clock seconds until the next stage assuming no further watering.
   * `null` when the plant will dry out first (i.e. it needs water to get there).
   */
  etaSecUntilNextStage: number | null;
  /** Wall-clock seconds until harvestable assuming no further watering, else null. */
  etaSecUntilReady: number | null;
  /** Timestamp at which the plant rots if it is not watered again. */
  rotsAt: UnixSeconds;
  /** Seconds until rot, 0 once rotten. */
  secondsUntilRot: number;
  /** `true` when the crop can be harvested right now. */
  harvestable: boolean;
  /** `true` when watering would meaningfully help right now. */
  needsWater: boolean;
}
