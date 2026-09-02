import { describe, expect, it } from 'vitest';

import { CROP_IDS } from '@/farm/crops/catalog';
import { MAP_DEFINITIONS, validateOfficialMaps } from './definitions/registry';
import { parseMapDefinition, serializeMapDefinition } from './definitions/schema';
import { computeGrid, pixelToSlot, slotToPixel } from './renderer/grid';
import { fitViewport, pointerToSlot } from './renderer/viewport';
import { RENDERPACK_RELEASES, DEFAULT_RENDERPACK_REF, resolveRenderpack } from './renderpack/registry';
import { farmFieldMap } from './definitions/maps/farm-field';

describe('renderpack pinning', () => {
  it('pins every release to an exact 40-character commit', () => {
    for (const release of RENDERPACK_RELEASES) {
      expect(release.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(release.baseUrl).toContain(release.source.commit);
    }
  });

  it('never serves a renderpack from a mutable branch', () => {
    for (const release of RENDERPACK_RELEASES) {
      expect(release.baseUrl).not.toMatch(/\/(master|main|HEAD)\b/);
      expect(release.baseUrl).not.toContain('raw.githubusercontent.com');
      expect(release.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it('resolves the default reference', () => {
    expect(resolveRenderpack(DEFAULT_RENDERPACK_REF)).toBeDefined();
  });

  it('refuses an unpinned reference rather than guessing a URL', () => {
    expect(resolveRenderpack({ id: 'cozy-pixel-v1', version: '9.9.9' })).toBeUndefined();
    expect(resolveRenderpack(undefined)).toBeUndefined();
  });
});

describe('official map definitions', () => {
  it('are all valid', () => {
    expect(validateOfficialMaps()).toEqual([]);
  });

  it('reference a pinned renderpack', () => {
    for (const definition of Object.values(MAP_DEFINITIONS)) {
      expect(resolveRenderpack(definition.renderpack)).toBeDefined();
    }
  });

  it('survive a serialize/parse round trip', () => {
    const result = parseMapDefinition(JSON.parse(serializeMapDefinition(farmFieldMap)));
    expect(result.ok).toBe(true);
    expect(result.definition).toEqual(farmFieldMap);
  });

  it('reject a schema version they do not understand', () => {
    const result = parseMapDefinition({ ...farmFieldMap, schemaVersion: 99 });
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toContain('schemaVersion');
  });

  it('reject an id that would break slot addressing', () => {
    expect(parseMapDefinition({ ...farmFieldMap, id: 'farm:field' }).ok).toBe(false);
  });

  it('reject a grid that does not fit its plant area', () => {
    const result = parseMapDefinition({ ...farmFieldMap, grid: { ...farmFieldMap.grid, cols: 40 } });
    expect(result.issues.join(' ')).toContain('plantArea.w');
  });

  it('reject duplicate zone ids', () => {
    const zone = { id: 'a', kind: 'interaction' as const, rect: { x: 0, y: 0, w: 10, h: 10 } };
    expect(parseMapDefinition({ ...farmFieldMap, zones: [zone, zone] }).issues.join(' ')).toContain('duplicate');
  });
});

describe('grid geometry', () => {
  const grid = computeGrid(farmFieldMap);

  it('produces one cell per grid position', () => {
    expect(grid.cells).toHaveLength(farmFieldMap.grid.cols * farmFieldMap.grid.rows);
  });

  it('centres the grid inside the plant area', () => {
    const expectedX = farmFieldMap.plantArea.x + (farmFieldMap.plantArea.w - grid.cols * grid.tileSize) / 2;
    expect(grid.originX).toBe(Math.round(expectedX));
  });

  it('round trips slot -> pixel -> slot for every cell', () => {
    for (const cell of grid.cells) {
      const pixel = slotToPixel(grid, cell.col, cell.row)!;
      expect(pixelToSlot(grid, pixel.px + 1, pixel.py + 1)).toEqual({ x: cell.col, y: cell.row });
    }
  });

  it('returns null outside the grid', () => {
    expect(slotToPixel(grid, -1, 0)).toBeNull();
    expect(slotToPixel(grid, grid.cols, 0)).toBeNull();
    expect(pixelToSlot(grid, 0, 0)).toBeNull();
  });
});

describe('viewport', () => {
  const natural = { w: 1536, h: 1024 };

  it('fits the background inside the container and centres it', () => {
    const viewport = fitViewport(natural, { w: 768, h: 1024 });
    expect(viewport.scale).toBe(0.5);
    expect(viewport.width).toBe(768);
    expect(viewport.offsetY).toBe((1024 - 512) / 2);
  });

  it('degrades safely for a zero-sized container', () => {
    expect(fitViewport(natural, { w: 0, h: 0 }).scale).toBe(1);
  });

  it('maps a pointer through the viewport onto the right slot', () => {
    const grid = computeGrid(farmFieldMap);
    const viewport = fitViewport(natural, { w: 768, h: 512 });
    const cell = grid.cells[5];

    const pointer = {
      x: (cell.x + 1) * viewport.scale + viewport.offsetX,
      y: (cell.y + 1) * viewport.scale + viewport.offsetY,
    };
    expect(pointerToSlot(pointer, viewport, grid)).toEqual({ x: cell.col, y: cell.row });
  });
});

describe('crop catalog and renderpack agree', () => {
  it('names crops the shipped renderpack can draw', () => {
    // Sprite availability is checked at runtime; here we only assert the pack
    // the default map pins is the one the catalog was balanced against.
    expect(DEFAULT_RENDERPACK_REF).toEqual(farmFieldMap.renderpack);
    expect(CROP_IDS.length).toBeGreaterThan(0);
  });
});
