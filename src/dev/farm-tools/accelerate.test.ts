import { describe, expect, it } from 'vitest';

import { CROP_CATALOG } from '@/farm/crops/catalog';
import { DEFAULT_STAGE_DURATION_SEC } from '@/farm/crops/defaults';
import { evaluatePlant, plantSeed, waterPlant } from '@/farm/growth/evaluate';
import { applyFarmAction } from '@/farm/slots/transitions';
import type { FarmSlot } from '@/farm/slots/types';
import { acceleratedToReady } from './accelerate';

const NOW = 1_800_000_000;
const strawberry = CROP_CATALOG.strawberry;

describe('acceleratedToReady', () => {
  it('turns a freshly planted seed into a harvestable, wet crop', () => {
    const seed = plantSeed('strawberry', NOW - 30);
    const plant = acceleratedToReady(seed, strawberry, NOW);
    const view = evaluatePlant(plant, NOW, strawberry);

    expect(view.harvestable).toBe(true);
    expect(view.phase).toBe('ready');
    expect(view.stage).toBe(strawberry.harvestStage);
    expect(view.wet).toBe(true);
    expect(plant.cropId).toBe('strawberry');
    expect(plant.plantedAt).toBe(seed.plantedAt);
  });

  it('is exactly the state the real growth would reach, then one normal watering', () => {
    const seed = plantSeed('strawberry', NOW - 30);
    const plant = acceleratedToReady(seed, strawberry, NOW);

    expect(plant.growthSec).toBe(strawberry.harvestStage * strawberry.stageDurationSec);
    expect(plant.growthUpdatedAt).toBe(NOW);
    // Wet for one watering from now, as `waterPlant` would grant a dry crop.
    expect(plant.wetUntil).toBe(NOW + strawberry.waterDurationSec);
  });

  it('is harvested by the ordinary transition for the ordinary quantity', () => {
    const slot: FarmSlot = {
      coord: { x: 2, y: 1 },
      content: { type: 'plant', plant: acceleratedToReady(plantSeed('strawberry', NOW), strawberry, NOW) },
    };
    const result = applyFarmAction(slot, { type: 'harvest', nowSec: NOW + 5 }, CROP_CATALOG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harvest).toMatchObject({ cropId: 'strawberry', quantity: 1 });
    expect(result.slot.content).toEqual({ type: 'empty', lastHarvestedAt: NOW + 5 });
  });

  it('refuses a rotten crop rather than resurrecting it', () => {
    const seed = plantSeed('strawberry', NOW - strawberry.rotAfterDrySec - 1);
    expect(evaluatePlant(seed, NOW, strawberry).phase).toBe('rotten');
    expect(() => acceleratedToReady(seed, strawberry, NOW)).toThrow(/rotten/i);
  });

  it('leaves the normal crop timing untouched', () => {
    // The catalog is the production balance; acceleration reads it, never edits it.
    for (const crop of Object.values(CROP_CATALOG)) {
      expect(crop.stageDurationSec).toBe(DEFAULT_STAGE_DURATION_SEC);
      expect(crop.harvestStage).toBe(3);
    }
    expect(Object.isFrozen(CROP_CATALOG)).toBe(true);
    expect(Object.isFrozen(strawberry)).toBe(true);

    // A normally planted and watered strawberry still needs every wet second.
    const needed = strawberry.harvestStage * strawberry.stageDurationSec;
    let plant = plantSeed('strawberry', NOW);
    let t = NOW;
    while (t - NOW < needed - 1) {
      plant = waterPlant(plant, t, strawberry);
      t += strawberry.waterDurationSec;
    }
    expect(evaluatePlant(plant, NOW + needed - 1, strawberry).harvestable).toBe(false);
    expect(evaluatePlant(plant, NOW + needed, strawberry).harvestable).toBe(true);
  });
});
