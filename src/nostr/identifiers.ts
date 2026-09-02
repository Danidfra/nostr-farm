import { KIND_MAP_STATE, KIND_WORLD_STATE } from './kinds';

/**
 * Identifier rules.
 *
 * World and map ids are restricted to a colon-free charset. That is what makes
 * the coordinate-derived slot address below unambiguous: `slot:<mapId>:<x>:<y>`
 * always splits into exactly four parts.
 */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidIdentifier(value: string | undefined): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

/**
 * Slot identity is coordinate-derived, and stays that way in V1.
 *
 * A farm map is a fixed grid over a baked background: exactly one slot per
 * cell, forever. A coordinate address makes the addressable event replace
 * itself naturally on every replant, needs no id allocation, and lets the
 * client address a cell it has never seen. A surrogate slot id would buy
 * nothing here and would require a lookup table to render a grid.
 *
 * What actually went wrong in v1 was not the coordinates — it was that the
 * address was built by string-mangling (`mapId.split(':').pop()`) out of ids
 * with no charset rules, and that readers de-duplicated on `d` alone across
 * arbitrary authors. Both are fixed: ids are validated, and the true address is
 * `(pubkey, kind, d)`.
 */
export function slotAddress(mapId: string, x: number, y: number): string {
  return `slot:${mapId}:${x}:${y}`;
}

export interface ParsedSlotAddress {
  mapId: string;
  x: number;
  y: number;
}

export function parseSlotAddress(d: string | undefined): ParsedSlotAddress | null {
  if (!d) return null;
  const parts = d.split(':');
  if (parts.length !== 4 || parts[0] !== 'slot') return null;

  const [, mapId, xs, ys] = parts;
  if (!isValidIdentifier(mapId)) return null;

  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return null;

  return { mapId, x, y };
}

/** Build a NIP-01 addressable coordinate (`kind:pubkey:d`). */
export function addressableRef(kind: number, pubkey: string, d: string): string {
  return `${kind}:${pubkey}:${d}`;
}

export interface ParsedAddressableRef {
  kind: number;
  pubkey: string;
  d: string;
}

export function parseAddressableRef(value: string | undefined): ParsedAddressableRef | null {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length < 3) return null;

  const kind = Number(parts[0]);
  const pubkey = parts[1];
  const d = parts.slice(2).join(':');
  if (!Number.isInteger(kind) || !/^[0-9a-f]{64}$/.test(pubkey) || d.length === 0) return null;

  return { kind, pubkey, d };
}

export const worldRef = (pubkey: string, worldId: string) => addressableRef(KIND_WORLD_STATE, pubkey, worldId);
export const mapRef = (pubkey: string, mapId: string) => addressableRef(KIND_MAP_STATE, pubkey, mapId);
