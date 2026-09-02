import { describe, expect, it } from 'vitest';

import { CROP_CATALOG, CROP_IDS, getCrop } from './catalog';
import { normalizeCropDefinition } from './defaults';

describe('normalizeCropDefinition', () => {
  it('fills every field for a crop authored with no overrides', () => {
    expect(normalizeCropDefinition('carrot')).toEqual({
      id: 'carrot',
      stages: 4,
      harvestStage: 3,
      stageDurationSec: 300,
      waterDurationSec: 300,
      maxWetBufferSec: 600,
      rotAfterDrySec: 600,
    });
  });

  it('clamps harvestStage into the available stages', () => {
    expect(normalizeCropDefinition('x', { stages: 3, harvestStage: 99 }).harvestStage).toBe(2);
  });

  it('never allows a zero-length stage', () => {
    expect(normalizeCropDefinition('x', { stageDurationSec: 0 }).stageDurationSec).toBe(300);
  });

  it('guarantees one watering is always fully absorbable', () => {
    const crop = normalizeCropDefinition('x', { waterDurationSec: 600, maxWetBufferSec: 10 });
    expect(crop.maxWetBufferSec).toBeGreaterThanOrEqual(crop.waterDurationSec);
  });

  it('guarantees a wet plant can never be rotten', () => {
    expect(normalizeCropDefinition('x', { rotAfterDrySec: 0 }).rotAfterDrySec).toBeGreaterThan(0);
  });

  it('rejects nonsense numbers without throwing', () => {
    const crop = normalizeCropDefinition('x', {
      stages: Number.NaN,
      stageDurationSec: -1,
      waterDurationSec: Number.POSITIVE_INFINITY,
    });
    expect(crop.stages).toBeGreaterThanOrEqual(1);
    expect(crop.stageDurationSec).toBeGreaterThanOrEqual(1);
    expect(crop.waterDurationSec).toBeGreaterThanOrEqual(1);
  });

  it('truncates fractional durations to whole seconds', () => {
    expect(normalizeCropDefinition('x', { stageDurationSec: 90.9 }).stageDurationSec).toBe(90);
  });
});

describe('CROP_CATALOG', () => {
  it('exposes the four V1 crops', () => {
    expect(CROP_IDS).toEqual(['carrot', 'parsnip', 'pumpkin', 'strawberry']);
  });

  it('keeps every V1 crop on identical timings (balance deferred)', () => {
    const timings = CROP_IDS.map((id) => {
      const { id: _id, ...rest } = CROP_CATALOG[id];
      return JSON.stringify(rest);
    });
    expect(new Set(timings).size).toBe(1);
  });

  it('returns undefined for unknown crops instead of throwing', () => {
    expect(getCrop('turnip')).toBeUndefined();
    expect(getCrop(undefined)).toBeUndefined();
  });
});
