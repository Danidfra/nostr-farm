import { describe, expect, it } from 'vitest';

import {
  MALFORMED_PRESETS,
  advanceClock,
  createSimState,
  forceDry,
  forceReady,
  forceRotten,
  forceStage,
  forceWet,
  injectMalformed,
  inspectSlot,
  runAction,
  spawnCrop,
  type MalformedPreset,
} from './simulation';

const AT = { x: 1, y: 1 };

describe('dev test lab simulation', () => {
  it('starts with an empty grid', () => {
    const state = createSimState(3, 2);
    expect(Object.keys(state.slots)).toHaveLength(6);
    expect(inspectSlot(state, AT).slot.content.type).toBe('empty');
  });

  it('runs real domain actions and logs rejections', () => {
    let state = createSimState(3, 2);
    state = runAction(state, AT, 'harvest');
    expect(state.log[0]).toContain('rejected: slot_empty');

    state = runAction(state, AT, 'plant', 'carrot');
    expect(inspectSlot(state, AT).slot.content.type).toBe('plant');
  });

  it('advances a virtual clock in both directions', () => {
    const state = advanceClock(advanceClock(createSimState(1, 1), 3600), -600);
    expect(state.nowSec).toBe(createSimState(1, 1).nowSec + 3000);
  });

  it('forces a plant to a specific stage', () => {
    let state = spawnCrop(createSimState(2, 2), AT, 'carrot');
    state = forceStage(state, AT, 2);
    expect(inspectSlot(state, AT).view?.stage).toBe(2);
  });

  it('clamps a forced stage to the harvest stage', () => {
    let state = spawnCrop(createSimState(2, 2), AT, 'carrot');
    state = forceStage(state, AT, 99);
    expect(inspectSlot(state, AT).view?.phase).toBe('ready');
  });

  it('forces wet and dry without losing banked growth', () => {
    let state = spawnCrop(createSimState(2, 2), AT, 'carrot');
    state = forceWet(state, AT);
    state = advanceClock(state, 120);
    const banked = inspectSlot(state, AT).view!.growthSec;

    state = forceDry(state, AT);
    expect(inspectSlot(state, AT).view?.wet).toBe(false);
    expect(inspectSlot(state, AT).view?.growthSec).toBe(banked);
  });

  it('forces harvest-ready and rotten states', () => {
    let state = spawnCrop(createSimState(2, 2), AT, 'carrot');
    state = forceReady(state, AT);
    expect(inspectSlot(state, AT).view?.harvestable).toBe(true);

    state = forceRotten(state, AT);
    expect(inspectSlot(state, AT).view?.phase).toBe('rotten');
  });

  it('inspects every malformed preset without throwing', () => {
    for (const preset of Object.keys(MALFORMED_PRESETS) as MalformedPreset[]) {
      const state = injectMalformed(createSimState(2, 2), AT, preset);
      expect(() => inspectSlot(state, AT)).not.toThrow();
    }
  });

  it('reports an unknown crop as a problem rather than crashing', () => {
    const state = injectMalformed(createSimState(2, 2), AT, 'unknown crop');
    expect(inspectSlot(state, AT).problem).toContain('moonfruit');
  });

  it('imports nothing but the pure farm domain, so it cannot touch the network', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/dev/test-lab/simulation.ts'), 'utf8');

    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((specifier) => specifier.startsWith('@/farm'))).toBe(true);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
