import type { MapDefinition } from '../schema';

/**
 * The single V1 farm map.
 *
 * Geometry matches `renderpacks/cozy-pixel-v1/meta/maps/farm.v1.json` in the
 * artwork repository, but this file is the authority: layout is game logic and
 * belongs under review here, not in a mutable art repo.
 */
export const farmFieldMap: MapDefinition = {
  schemaVersion: 1,
  id: 'farm.field',
  name: 'Farm Field',
  revision: 1,
  renderpack: { id: 'cozy-pixel-v1', version: '1.0.0' },
  background: 'assets/backgrounds/farm.png',
  backgroundSize: { w: 1536, h: 1024 },
  tileSize: 96,
  plantArea: { x: 270, y: 340, w: 976, h: 464 },
  grid: { cols: 9, rows: 4, align: 'center' },
  spawn: { x: 768, y: 900 },
  zones: [],
  objects: [],
};
