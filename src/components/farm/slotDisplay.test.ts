import { describe, expect, it } from 'vitest';

import { CROP_CATALOG } from '@/farm/crops/catalog';
import { emptySlot, type FarmSlot } from '@/farm/slots/types';
import { describeGrowTime, describeSlotAction, formatDuration } from './slotDisplay';

const NOW = 1_800_000_000;
const carrot = CROP_CATALOG.carrot;

function planted(overrides: Partial<{ growthSec: number; wetUntil: number; growthUpdatedAt: number; plantedAt: number }>): FarmSlot {
  return {
    coord: { x: 0, y: 0 },
    content: {
      type: 'plant',
      plant: {
        cropId: 'carrot',
        plantedAt: overrides.plantedAt ?? NOW - 60,
        growthSec: overrides.growthSec ?? 0,
        growthUpdatedAt: overrides.growthUpdatedAt ?? NOW - 60,
        wetUntil: overrides.wetUntil ?? NOW - 60,
      },
    },
  };
}

describe('describeSlotAction', () => {
  it('offers to plant in an empty slot', () => {
    expect(describeSlotAction(emptySlot({ x: 0, y: 0 }), NOW)).toEqual({ action: 'plant', label: 'Plant' });
  });

  it('offers to water a growing crop, wet or dry', () => {
    expect(describeSlotAction(planted({}), NOW)).toEqual({ action: 'water', label: 'Water' });
    expect(describeSlotAction(planted({ wetUntil: NOW + 100 }), NOW)).toEqual({ action: 'water', label: 'Water' });
  });

  it('offers to harvest once the crop reaches its harvest stage', () => {
    const grown = planted({ growthSec: carrot.harvestStage * carrot.stageDurationSec, growthUpdatedAt: NOW, wetUntil: NOW + 10 });
    expect(describeSlotAction(grown, NOW)).toEqual({ action: 'harvest', label: 'Harvest' });
  });

  it('offers to clear a rotten crop, and says so', () => {
    const rotten = planted({ wetUntil: NOW - carrot.rotAfterDrySec - 1, growthUpdatedAt: NOW - carrot.rotAfterDrySec - 1 });
    expect(describeSlotAction(rotten, NOW)).toEqual({ action: 'clear', label: 'Clear rotten crop' });
  });

  it('offers to clear a crop the catalog no longer knows', () => {
    const base = planted({});
    const unknown: FarmSlot = {
      ...base,
      content: base.content.type === 'plant' ? { type: 'plant', plant: { ...base.content.plant, cropId: 'durian' } } : base.content,
    };
    expect(describeSlotAction(unknown, NOW).action).toBe('clear');
  });
});

describe('formatDuration', () => {
  it('formats under an hour as m:ss and over as Hhmm', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(272)).toBe('4:32');
    expect(formatDuration(3600 + 5 * 60)).toBe('1h05');
  });
});

describe('describeGrowTime', () => {
  it('derives the seed card hint from the crop balance', () => {
    const minutes = Math.round((carrot.harvestStage * carrot.stageDurationSec) / 60);
    expect(describeGrowTime('carrot')).toBe(`Grows in about ${minutes} min while watered`);
    expect(describeGrowTime('durian')).toBeNull();
  });
});
