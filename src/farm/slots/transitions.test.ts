import { describe, expect, it } from 'vitest';

import { normalizeCropDefinition } from '../crops/defaults';
import type { CropCatalog } from '../crops/types';
import { plantSeed, totalGrowthSec, waterPlant } from '../growth/evaluate';
import { applyFarmAction } from './transitions';
import { emptySlot, type FarmSlot } from './types';

const CROP = normalizeCropDefinition('testcrop', {
  stages: 4,
  harvestStage: 3,
  stageDurationSec: 300,
  waterDurationSec: 300,
  maxWetBufferSec: 600,
  rotAfterDrySec: 600,
});

const CATALOG: CropCatalog = { testcrop: CROP };
const T0 = 1_800_000_000;
const COORD = { x: 2, y: 1 };

function planted(at = T0): FarmSlot {
  return { coord: COORD, content: { type: 'plant', plant: plantSeed('testcrop', at) } };
}

/** A slot whose crop is ripe at `T0 + 900` and rots at `T0 + 1500`. */
function ripe(): FarmSlot {
  let plant = plantSeed('testcrop', T0);
  for (let t = T0; t < T0 + 900; t += 300) plant = waterPlant(plant, t, CROP);
  return { coord: COORD, content: { type: 'plant', plant } };
}

describe('plant', () => {
  it('plants into an empty slot', () => {
    const result = applyFarmAction(emptySlot(COORD), { type: 'plant', nowSec: T0, cropId: 'testcrop' }, CATALOG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot.content).toEqual({ type: 'plant', plant: plantSeed('testcrop', T0) });
    expect(result.slot.coord).toEqual(COORD);
  });

  it('refuses to plant on top of an existing crop', () => {
    expect(applyFarmAction(planted(), { type: 'plant', nowSec: T0, cropId: 'testcrop' }, CATALOG)).toEqual({
      ok: false,
      action: 'plant',
      reason: 'slot_occupied',
    });
  });

  it('refuses an unknown crop', () => {
    expect(applyFarmAction(emptySlot(COORD), { type: 'plant', nowSec: T0, cropId: 'turnip' }, CATALOG)).toEqual({
      ok: false,
      action: 'plant',
      reason: 'unknown_crop',
    });
  });

  it('refuses a plant action with no crop at all', () => {
    expect(applyFarmAction(emptySlot(COORD), { type: 'plant', nowSec: T0 }, CATALOG)).toMatchObject({ ok: false, reason: 'unknown_crop' });
  });

  it('does not mutate the input slot', () => {
    const slot = emptySlot(COORD);
    const frozen = JSON.stringify(slot);
    applyFarmAction(slot, { type: 'plant', nowSec: T0, cropId: 'testcrop' }, CATALOG);
    expect(JSON.stringify(slot)).toBe(frozen);
  });
});

describe('water', () => {
  it('waters a dry crop', () => {
    const result = applyFarmAction(planted(), { type: 'water', nowSec: T0, cropId: undefined }, CATALOG);

    expect(result.ok).toBe(true);
    if (!result.ok || result.slot.content.type !== 'plant') return;
    expect(result.slot.content.plant.wetUntil).toBe(T0 + 300);
  });

  it('refuses to water an empty slot', () => {
    expect(applyFarmAction(emptySlot(COORD), { type: 'water', nowSec: T0 }, CATALOG)).toEqual({
      ok: false,
      action: 'water',
      reason: 'slot_empty',
    });
  });

  it('refuses to water a rotten crop', () => {
    expect(applyFarmAction(planted(), { type: 'water', nowSec: T0 + 600 }, CATALOG)).toEqual({
      ok: false,
      action: 'water',
      reason: 'plant_rotten',
    });
  });

  it('refuses a watering that would be entirely discarded by the buffer cap', () => {
    let slot = applyFarmAction(planted(), { type: 'water', nowSec: T0 }, CATALOG);
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;
    slot = applyFarmAction(slot.slot, { type: 'water', nowSec: T0 }, CATALOG);
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    expect(applyFarmAction(slot.slot, { type: 'water', nowSec: T0 }, CATALOG)).toEqual({
      ok: false,
      action: 'water',
      reason: 'already_saturated',
    });
  });

  it('allows watering a ripe crop to postpone rot', () => {
    const result = applyFarmAction(ripe(), { type: 'water', nowSec: T0 + 900 }, CATALOG);

    expect(result.ok).toBe(true);
    if (!result.ok || result.slot.content.type !== 'plant') return;
    expect(result.slot.content.plant.wetUntil).toBe(T0 + 1200);
  });

  it('refuses to water a crop whose definition is missing', () => {
    expect(applyFarmAction(planted(), { type: 'water', nowSec: T0 }, {})).toEqual({
      ok: false,
      action: 'water',
      reason: 'unknown_crop',
    });
  });
});

describe('harvest', () => {
  it('harvests a ripe crop and empties the slot', () => {
    const result = applyFarmAction(ripe(), { type: 'harvest', nowSec: T0 + 900 }, CATALOG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot.content).toEqual({ type: 'empty', lastHarvestedAt: T0 + 900 });
    expect(result.harvest).toEqual({
      cropId: 'testcrop',
      quantity: 1,
      harvestedAt: T0 + 900,
      growthSec: totalGrowthSec((ripe().content as { plant: ReturnType<typeof plantSeed> }).plant, T0 + 900),
    });
  });

  it('refuses to harvest before the crop is ready', () => {
    expect(applyFarmAction(ripe(), { type: 'harvest', nowSec: T0 + 899 }, CATALOG)).toEqual({
      ok: false,
      action: 'harvest',
      reason: 'not_ready',
    });
  });

  it('refuses to harvest a rotten crop', () => {
    expect(applyFarmAction(ripe(), { type: 'harvest', nowSec: T0 + 1500 }, CATALOG)).toEqual({
      ok: false,
      action: 'harvest',
      reason: 'plant_rotten',
    });
  });

  it('refuses to harvest an empty slot', () => {
    expect(applyFarmAction(emptySlot(COORD), { type: 'harvest', nowSec: T0 }, CATALOG)).toEqual({
      ok: false,
      action: 'harvest',
      reason: 'slot_empty',
    });
  });
});

describe('clear', () => {
  it('clears a rotten crop', () => {
    const result = applyFarmAction(planted(), { type: 'clear', nowSec: T0 + 600 }, CATALOG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot.content).toEqual({ type: 'empty', lastHarvestedAt: T0 + 600 });
  });

  it('refuses to clear a living crop', () => {
    expect(applyFarmAction(planted(), { type: 'clear', nowSec: T0 + 100 }, CATALOG)).toEqual({
      ok: false,
      action: 'clear',
      reason: 'plant_not_rotten',
    });
  });

  it('always allows clearing a crop whose definition disappeared', () => {
    expect(applyFarmAction(planted(), { type: 'clear', nowSec: T0 + 100 }, {})).toMatchObject({ ok: true });
  });

  it('refuses to clear an empty slot', () => {
    expect(applyFarmAction(emptySlot(COORD), { type: 'clear', nowSec: T0 }, CATALOG)).toEqual({
      ok: false,
      action: 'clear',
      reason: 'slot_empty',
    });
  });
});

describe('unknown actions', () => {
  it('rejects an action type the domain does not know', () => {
    const result = applyFarmAction(emptySlot(COORD), { type: 'fertilize' as 'plant', nowSec: T0 }, CATALOG);
    expect(result).toEqual({ ok: false, action: 'fertilize', reason: 'unknown_action' });
  });
});

describe('full loop', () => {
  it('plants, waters to ripeness and harvests', () => {
    let slot: FarmSlot = emptySlot(COORD);
    let t = T0;

    const plantResult = applyFarmAction(slot, { type: 'plant', nowSec: t, cropId: 'testcrop' }, CATALOG);
    expect(plantResult.ok).toBe(true);
    if (!plantResult.ok) return;
    slot = plantResult.slot;

    for (let i = 0; i < 3; i++) {
      const watered = applyFarmAction(slot, { type: 'water', nowSec: t }, CATALOG);
      expect(watered.ok).toBe(true);
      if (!watered.ok) return;
      slot = watered.slot;
      t += 300;
    }

    const harvested = applyFarmAction(slot, { type: 'harvest', nowSec: t }, CATALOG);
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) return;
    expect(harvested.harvest?.cropId).toBe('testcrop');
    expect(harvested.slot.content.type).toBe('empty');

    // The freed slot is immediately replantable.
    expect(applyFarmAction(harvested.slot, { type: 'plant', nowSec: t, cropId: 'testcrop' }, CATALOG).ok).toBe(true);
  });
});
