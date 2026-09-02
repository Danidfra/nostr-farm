import type { NostrEvent } from '@nostrify/nostrify';

import { isValidIdentifier, parseAddressableRef, worldRef } from './identifiers';
import { KIND_MAP_STATE, KIND_WORLD_STATE, SCHEMA_VERSION } from './kinds';
import { getIntTag, getTag, type EventTemplate } from './tags';

/**
 * MapState (kind 31416) — one playable map inside a world.
 *
 * The parent world is referenced with a proper NIP-01 addressable `a` tag
 * rather than a bare id string, so the reference names an author as well as a
 * `d` value and cannot be satisfied by somebody else's world.
 *
 * The map does not carry its layout. It names a source-controlled map
 * definition (`map_def` + `map_def_revision`); geometry is code, not relay data.
 */
export interface MapState {
  event: NostrEvent;
  id: string;
  version: string;
  owner: string;
  worldId: string;
  /** Id of the source-controlled map definition to render. */
  definitionId: string;
  definitionRevision?: number;
  name?: string;
}

export interface BuildMapStateInput {
  mapId: string;
  worldId: string;
  ownerPubkey: string;
  definitionId: string;
  definitionRevision: number;
  name?: string;
}

export function buildMapState(input: BuildMapStateInput): EventTemplate {
  const tags: string[][] = [
    ['d', input.mapId],
    ['v', SCHEMA_VERSION],
    ['a', worldRef(input.ownerPubkey, input.worldId)],
    ['map_def', input.definitionId],
    ['map_def_revision', String(input.definitionRevision)],
  ];
  if (input.name) tags.push(['name', input.name]);
  return { kind: KIND_MAP_STATE, content: '', tags };
}

export function parseMapState(event: NostrEvent): MapState | null {
  if (event.kind !== KIND_MAP_STATE) return null;

  const id = getTag(event, 'd');
  const version = getTag(event, 'v');
  const definitionId = getTag(event, 'map_def');
  const parent = parseAddressableRef(getTag(event, 'a'));

  if (!isValidIdentifier(id) || !isValidIdentifier(definitionId) || !version) return null;
  if (!parent || parent.kind !== KIND_WORLD_STATE) return null;

  // Personal-farm authority: a map may only claim a world its own author owns.
  if (parent.pubkey !== event.pubkey) return null;
  if (!isValidIdentifier(parent.d)) return null;

  return {
    event,
    id,
    version,
    owner: event.pubkey,
    worldId: parent.d,
    definitionId,
    definitionRevision: getIntTag(event, 'map_def_revision'),
    name: getTag(event, 'name'),
  };
}
