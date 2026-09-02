import { z } from 'zod';

/**
 * Versioned map definition schema.
 *
 * Official worlds are **source-controlled**, not relay-published: a map
 * definition is a file in this repository, validated by this schema, and the
 * `/dev/worlds` editor produces exactly this shape. Publishing map definitions
 * to relays may come later; making relays the only authoring source would put
 * level design outside code review, which is not what we want.
 *
 * The current farm renders a baked background image rather than a tileset, so
 * the schema describes *regions and objects over a background*, not tiles.
 */

export const MAP_SCHEMA_VERSION = 1;

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'must be lowercase alphanumeric with . _ - and no colons');

const rect = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

const point = z.object({ x: z.number().int(), y: z.number().int() });

export const zoneKinds = ['interaction', 'collision', 'exit', 'decoration'] as const;

const zone = z.object({
  id: identifier,
  kind: z.enum(zoneKinds),
  rect,
  /** Free-form authoring metadata, e.g. `{ "target": "farm.house" }` for an exit. */
  metadata: z.record(z.string(), z.string()).optional(),
});

const mapObject = z.object({
  id: identifier,
  /** Renderpack-relative sprite path. */
  sprite: z.string().min(1),
  at: point,
  size: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const mapDefinitionSchema = z.object({
  schemaVersion: z.literal(MAP_SCHEMA_VERSION),
  id: identifier,
  name: z.string().min(1),
  /** Bumped by the author whenever the layout changes. */
  revision: z.number().int().positive(),
  renderpack: z.object({ id: identifier, version: z.string().min(1) }),
  /** Renderpack-relative path of the baked background image. */
  background: z.string().min(1),
  /** Natural pixel size of the background, used for scaling. */
  backgroundSize: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  tileSize: z.number().int().positive(),
  /** Region of the background that holds the plantable grid. */
  plantArea: rect,
  grid: z.object({
    cols: z.number().int().positive().max(64),
    rows: z.number().int().positive().max(64),
    align: z.enum(['center', 'top-left']).default('center'),
  }),
  spawn: point.optional(),
  zones: z.array(zone).default([]),
  objects: z.array(mapObject).default([]),
});

export type MapDefinition = z.infer<typeof mapDefinitionSchema>;
export type MapZone = z.infer<typeof zone>;
export type MapObject = z.infer<typeof mapObject>;
export type MapRect = z.infer<typeof rect>;

export interface MapValidationResult {
  ok: boolean;
  definition?: MapDefinition;
  issues: string[];
}

/** Validate untrusted JSON (editor import, pasted blob) into a `MapDefinition`. */
export function parseMapDefinition(input: unknown): MapValidationResult {
  const result = mapDefinitionSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }

  const issues: string[] = [];
  const def = result.data;

  if (def.plantArea.w < def.grid.cols * def.tileSize) {
    issues.push('plantArea.w is narrower than grid.cols x tileSize');
  }
  if (def.plantArea.h < def.grid.rows * def.tileSize) {
    issues.push('plantArea.h is shorter than grid.rows x tileSize');
  }
  if (def.plantArea.x + def.plantArea.w > def.backgroundSize.w || def.plantArea.y + def.plantArea.h > def.backgroundSize.h) {
    issues.push('plantArea extends outside the background image');
  }

  const ids = new Set<string>();
  for (const item of [...def.zones, ...def.objects]) {
    if (ids.has(item.id)) issues.push(`duplicate zone/object id "${item.id}"`);
    ids.add(item.id);
  }

  return { ok: issues.length === 0, definition: def, issues };
}

/** Serialize a definition to the canonical on-disk JSON form. */
export function serializeMapDefinition(definition: MapDefinition): string {
  return `${JSON.stringify(definition, null, 2)}\n`;
}
