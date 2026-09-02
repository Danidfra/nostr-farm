import { describe, expect, it } from 'vitest';

import { normalizeCropDefinition } from '../crops/defaults';
import {
  accruedGrowthSec,
  canAbsorbWater,
  evaluatePlant,
  growthStage,
  isHarvestable,
  isRotten,
  isWet,
  needsWater,
  normalizePlantState,
  plantPhase,
  plantSeed,
  rotsAt,
  totalGrowthSec,
  waterPlant,
} from './evaluate';
import type { PlantState } from './types';

/**
 * Test crop with deliberately round numbers:
 * - 4 stages, harvestable at stage 3 => 900 growth seconds to ripen
 * - one watering grants 300 wet seconds, at most 600 may be stacked
 * - rots after 600 consecutive dry seconds
 */
const CROP = normalizeCropDefinition('testcrop', {
  stages: 4,
  harvestStage: 3,
  stageDurationSec: 300,
  waterDurationSec: 300,
  maxWetBufferSec: 600,
  rotAfterDrySec: 600,
});

const T0 = 1_800_000_000;

/** Plant at T0 then water it, so the plant is wet for [T0, T0+300). */
function wateredAt(t: number, plant: PlantState = plantSeed('testcrop', T0)): PlantState {
  return waterPlant(plant, t, CROP);
}

/** Keep a plant continuously wet from T0 until it has banked `growthSec`. */
function grownTo(growthSec: number): PlantState {
  let plant = plantSeed('testcrop', T0);
  let t = T0;
  while (totalGrowthSec(plant, t) < growthSec) {
    plant = waterPlant(plant, t, CROP);
    t += CROP.waterDurationSec;
  }
  return { ...plant, growthSec, growthUpdatedAt: t, wetUntil: Math.max(plant.wetUntil, t) };
}

describe('planting', () => {
  it('creates a plant at stage zero with no banked growth', () => {
    const plant = plantSeed('testcrop', T0);

    expect(plant).toEqual({
      cropId: 'testcrop',
      plantedAt: T0,
      growthSec: 0,
      growthUpdatedAt: T0,
      wetUntil: T0,
    });
    expect(growthStage(plant, T0, CROP)).toBe(0);
    expect(totalGrowthSec(plant, T0)).toBe(0);
  });

  it('starts DRY, so a freshly planted seed needs water immediately', () => {
    const plant = plantSeed('testcrop', T0);

    expect(isWet(plant, T0)).toBe(false);
    expect(needsWater(plant, T0, CROP)).toBe(true);
    expect(plantPhase(plant, T0, CROP)).toBe('growing');
  });

  it('truncates a fractional planting timestamp to whole seconds', () => {
    expect(plantSeed('testcrop', T0 + 0.75).plantedAt).toBe(T0);
  });
});

describe('dry behaviour', () => {
  it('does not grow at all while dry', () => {
    const plant = plantSeed('testcrop', T0);

    expect(totalGrowthSec(plant, T0 + 10_000)).toBe(0);
    expect(growthStage(plant, T0 + 10_000, CROP)).toBe(0);
  });

  it('never banks dry time: a long dry gap yields no progress after watering', () => {
    const seed = plantSeed('testcrop', T0);
    const dryFor = 500; // less than rotAfterDrySec, so the seed survives
    const watered = waterPlant(seed, T0 + dryFor, CROP);

    // Immediately after watering, still zero growth.
    expect(totalGrowthSec(watered, T0 + dryFor)).toBe(0);
    // One second of wetness buys exactly one second of growth.
    expect(totalGrowthSec(watered, T0 + dryFor + 1)).toBe(1);
  });

  it('stops accruing the moment wetness expires', () => {
    const plant = wateredAt(T0);

    expect(totalGrowthSec(plant, T0 + 299)).toBe(299);
    expect(totalGrowthSec(plant, T0 + 300)).toBe(300);
    // Dry from here on: further wall-clock time adds nothing.
    expect(totalGrowthSec(plant, T0 + 301)).toBe(300);
    expect(totalGrowthSec(plant, T0 + 100_000)).toBe(300);
  });

  it('accrues nothing between growthUpdatedAt and a wetUntil already in the past', () => {
    const plant: PlantState = { cropId: 'testcrop', plantedAt: T0, growthSec: 120, growthUpdatedAt: T0 + 500, wetUntil: T0 + 100 };

    expect(accruedGrowthSec(plant, T0 + 900)).toBe(0);
    expect(totalGrowthSec(plant, T0 + 900)).toBe(120);
  });
});

describe('watering', () => {
  it('makes a dry plant wet and resumes progression', () => {
    const plant = wateredAt(T0);

    expect(isWet(plant, T0)).toBe(true);
    expect(plant.wetUntil).toBe(T0 + 300);
    expect(totalGrowthSec(plant, T0 + 150)).toBe(150);
  });

  it('treats wetUntil as exclusive at the exact boundary', () => {
    const plant = wateredAt(T0);

    expect(isWet(plant, T0 + 299)).toBe(true);
    expect(isWet(plant, T0 + 300)).toBe(false);
    expect(needsWater(plant, T0 + 300, CROP)).toBe(true);
  });

  it('extends from the existing wetUntil when watering a plant that is still wet', () => {
    const first = wateredAt(T0);
    const second = waterPlant(first, T0 + 100, CROP);

    // 300 remaining wetness (until T0+300) + 300 more = T0+600, within the cap.
    expect(second.wetUntil).toBe(T0 + 600);
    // The 100 seconds already earned are banked, not lost.
    expect(second.growthSec).toBe(100);
    expect(totalGrowthSec(second, T0 + 600)).toBe(600);
  });

  it('caps stacked wetness at maxWetBufferSec ahead of now', () => {
    let plant = wateredAt(T0);
    plant = waterPlant(plant, T0, CROP); // would be T0+600, exactly the cap
    expect(plant.wetUntil).toBe(T0 + 600);

    plant = waterPlant(plant, T0, CROP); // would be T0+900, clamped back to the cap
    expect(plant.wetUntil).toBe(T0 + 600);
  });

  it('reports saturation instead of silently discarding a watering', () => {
    let plant = wateredAt(T0);
    plant = waterPlant(plant, T0, CROP);

    expect(canAbsorbWater(plant, T0, CROP)).toBe(false);
    // One second later the cap has moved forward, so water is useful again.
    expect(canAbsorbWater(plant, T0 + 1, CROP)).toBe(true);
  });

  it('does not double-count growth when watering repeatedly', () => {
    let plant = plantSeed('testcrop', T0);
    for (let i = 0; i < 5; i++) {
      plant = waterPlant(plant, T0 + i * 300, CROP);
    }

    // Continuously wet for 5 * 300 seconds => exactly 1200 growth at T0+1200.
    expect(totalGrowthSec(plant, T0 + 1200)).toBe(1200);
  });

  it('is idempotent in effect when applied twice at the same instant to a dry plant', () => {
    const once = waterPlant(plantSeed('testcrop', T0), T0, CROP);
    const twice = waterPlant(once, T0, CROP);

    expect(once.wetUntil).toBe(T0 + 300);
    expect(twice.wetUntil).toBe(T0 + 600); // second watering stacks, up to the cap
    expect(twice.growthSec).toBe(0);
  });
});

describe('growth stages', () => {
  it('stays on the current stage just before the boundary', () => {
    const plant = grownTo(299);
    expect(growthStage(plant, plant.growthUpdatedAt, CROP)).toBe(0);
  });

  it('advances exactly at the stage boundary (inclusive)', () => {
    const plant = grownTo(300);
    expect(growthStage(plant, plant.growthUpdatedAt, CROP)).toBe(1);
  });

  it('progresses one stage per stageDurationSec of wet time', () => {
    expect(growthStage(grownTo(0), T0, CROP)).toBe(0);
    expect(growthStage(grownTo(600), grownTo(600).growthUpdatedAt, CROP)).toBe(2);
    expect(growthStage(grownTo(900), grownTo(900).growthUpdatedAt, CROP)).toBe(3);
  });

  it('clamps at the harvest stage and never grows past it', () => {
    const plant = grownTo(100_000);
    expect(growthStage(plant, plant.growthUpdatedAt, CROP)).toBe(CROP.harvestStage);
  });

  it('is deterministic: repeated evaluation at the same instant never changes the stage', () => {
    const plant = wateredAt(T0);
    const at = T0 + 200;
    const first = growthStage(plant, at, CROP);

    for (let i = 0; i < 10; i++) {
      expect(growthStage(plant, at, CROP)).toBe(first);
    }
  });

  it('gives the same answer whether evaluated in small steps or one big jump', () => {
    // Continuously wet from T0 to T0+900 via three waterings.
    let stepwise = plantSeed('testcrop', T0);
    for (let t = T0; t < T0 + 900; t += 300) {
      stepwise = waterPlant(stepwise, t, CROP);
      // Simulate a client re-evaluating every 30 seconds in between.
      for (let s = t; s < t + 300; s += 30) growthStage(stepwise, s, CROP);
    }

    let jumped = plantSeed('testcrop', T0);
    for (let t = T0; t < T0 + 900; t += 300) jumped = waterPlant(jumped, t, CROP);

    expect(totalGrowthSec(stepwise, T0 + 900)).toBe(totalGrowthSec(jumped, T0 + 900));
    expect(growthStage(stepwise, T0 + 900, CROP)).toBe(growthStage(jumped, T0 + 900, CROP));
  });

  it('reaches the harvest stage after harvestStage x stageDurationSec of wet time', () => {
    let plant = plantSeed('testcrop', T0);
    for (let t = T0; t < T0 + 900; t += 300) plant = waterPlant(plant, t, CROP);

    expect(isHarvestable(plant, T0 + 899, CROP)).toBe(false);
    expect(isHarvestable(plant, T0 + 900, CROP)).toBe(true);
    expect(plantPhase(plant, T0 + 900, CROP)).toBe('ready');
  });

  it('does not require watering once ready', () => {
    const ready = grownTo(900);
    expect(needsWater(ready, ready.growthUpdatedAt, CROP)).toBe(false);
  });
});

describe('rot', () => {
  it('cannot rot while wet', () => {
    const plant = wateredAt(T0);

    for (let t = T0; t < plant.wetUntil; t += 25) {
      expect(isWet(plant, t)).toBe(true);
      expect(isRotten(plant, t, CROP)).toBe(false);
    }
  });

  it('is not rotten before the dry period expires', () => {
    const plant = wateredAt(T0); // dry from T0+300, rots at T0+900

    expect(rotsAt(plant, CROP)).toBe(T0 + 900);
    expect(isRotten(plant, T0 + 899, CROP)).toBe(false);
  });

  it('rots exactly at the expiry boundary (inclusive)', () => {
    const plant = wateredAt(T0);

    expect(isRotten(plant, T0 + 900, CROP)).toBe(true);
    expect(plantPhase(plant, T0 + 900, CROP)).toBe('rotten');
  });

  it('stays rotten forever once rotten', () => {
    const plant = wateredAt(T0);
    expect(isRotten(plant, T0 + 10_000_000, CROP)).toBe(true);
  });

  it('rots an unwatered seed after the dry period from planting', () => {
    const seed = plantSeed('testcrop', T0);

    expect(isRotten(seed, T0 + 599, CROP)).toBe(false);
    expect(isRotten(seed, T0 + 600, CROP)).toBe(true);
  });

  it('watering pushes rot back', () => {
    const seed = plantSeed('testcrop', T0);
    const watered = waterPlant(seed, T0 + 500, CROP);

    expect(rotsAt(seed, CROP)).toBe(T0 + 600);
    expect(rotsAt(watered, CROP)).toBe(T0 + 500 + 300 + 600);
    expect(isRotten(watered, T0 + 600, CROP)).toBe(false);
  });

  it('rots a ripe crop that is left dry, and rot outranks readiness', () => {
    let plant = plantSeed('testcrop', T0);
    for (let t = T0; t < T0 + 900; t += 300) plant = waterPlant(plant, t, CROP);

    expect(plantPhase(plant, T0 + 900, CROP)).toBe('ready');
    // Wet until T0+900, so it rots at T0+1500 if never harvested or watered.
    expect(plantPhase(plant, T0 + 1500, CROP)).toBe('rotten');
    expect(isHarvestable(plant, T0 + 1500, CROP)).toBe(false);
  });
});

describe('time and pathological inputs', () => {
  it('handles enormous time jumps without overflow or drift', () => {
    const plant = wateredAt(T0);
    const farFuture = T0 + 100 * 365 * 24 * 3600;

    expect(totalGrowthSec(plant, farFuture)).toBe(300);
    expect(growthStage(plant, farFuture, CROP)).toBe(1);
    expect(isRotten(plant, farFuture, CROP)).toBe(true);
  });

  it('treats a timestamp before the reference point as zero elapsed time', () => {
    const plant = wateredAt(T0);

    expect(accruedGrowthSec(plant, T0 - 10_000)).toBe(0);
    expect(totalGrowthSec(plant, T0 - 10_000)).toBe(0);
    expect(growthStage(plant, T0 - 10_000, CROP)).toBe(0);
  });

  it('never reports negative growth for corrupt banked values', () => {
    const corrupt: PlantState = { cropId: 'testcrop', plantedAt: T0, growthSec: -5000, growthUpdatedAt: T0, wetUntil: T0 + 300 };

    expect(totalGrowthSec(corrupt, T0 + 300)).toBe(300);
    expect(growthStage(corrupt, T0 + 300, CROP)).toBe(1);
  });

  it('normalizes non-finite state into something evaluable', () => {
    const normalized = normalizePlantState(
      { cropId: 'testcrop', plantedAt: Number.NaN, growthSec: Number.POSITIVE_INFINITY, growthUpdatedAt: undefined, wetUntil: Number.NaN },
      T0
    );

    expect(normalized).toEqual({ cropId: 'testcrop', plantedAt: T0, growthSec: 0, growthUpdatedAt: T0, wetUntil: T0 });
    expect(() => evaluatePlant(normalized, T0, CROP)).not.toThrow();
  });

  it('survives a wetUntil far in the future without granting unearned growth', () => {
    // A hand-forged state claiming 10 years of wetness still only grows in real time.
    const forged: PlantState = { cropId: 'testcrop', plantedAt: T0, growthSec: 0, growthUpdatedAt: T0, wetUntil: T0 + 315_360_000 };

    expect(totalGrowthSec(forged, T0 + 100)).toBe(100);
    expect(growthStage(forged, T0 + 100, CROP)).toBe(0);
  });
});

describe('evaluatePlant view', () => {
  it('reports a dry seed as growing, unwatered and thirsty', () => {
    const view = evaluatePlant(plantSeed('testcrop', T0), T0, CROP);

    expect(view).toMatchObject({
      phase: 'growing',
      stage: 0,
      wet: false,
      growthSec: 0,
      stageProgressSec: 0,
      needsWater: true,
      harvestable: false,
      secondsUntilDry: 0,
      growthSecUntilNextStage: 300,
      growthSecUntilReady: 900,
      etaSecUntilNextStage: null,
      etaSecUntilReady: null,
      secondsUntilRot: 600,
    });
  });

  it('gives a wall-clock ETA only when the current wetness can actually get there', () => {
    const plant = wateredAt(T0); // wet for 300s, exactly one stage

    const view = evaluatePlant(plant, T0, CROP);
    expect(view.etaSecUntilNextStage).toBe(300); // reachable on this watering
    expect(view.etaSecUntilReady).toBeNull(); // 900s needed, only 300s of wetness
  });

  it('clamps stage progress to a single stage once ripe', () => {
    let plant = plantSeed('testcrop', T0);
    for (let t = T0; t < T0 + 1200; t += 300) plant = waterPlant(plant, t, CROP);

    const view = evaluatePlant(plant, T0 + 1200, CROP);
    expect(view.stage).toBe(3);
    expect(view.stageProgressSec).toBeLessThanOrEqual(CROP.stageDurationSec);
    expect(view.growthSecUntilNextStage).toBeNull();
    expect(view.growthSecUntilReady).toBeNull();
  });
});
