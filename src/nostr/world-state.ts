import type { NostrEvent } from '@nostrify/nostrify';

import type { RenderpackRef } from '@/world/renderpack/registry';
import { isValidIdentifier } from './identifiers';
import { KIND_WORLD_STATE, SCHEMA_VERSION } from './kinds';
import { getTag, type EventTemplate } from './tags';

/**
 * WorldState (kind 31415) — the root of one player's world.
 *
 * V1 worlds are personal: the signed-in player owns and writes their own world,
 * and `event.pubkey` is the only authority for it.
 */
export interface WorldState {
  event: NostrEvent;
  /** `d` tag. */
  id: string;
  version: string;
  owner: string;
  /** World category. Only `farm` exists today. */
  type: string;
  name: string;
  /** `d` of the map a player enters. */
  entryMapId: string;
  /** Pinned renderpack. Resolved through the source-controlled registry. */
  renderpack: RenderpackRef;
}

export interface BuildWorldStateInput {
  worldId: string;
  name: string;
  entryMapId: string;
  renderpack: RenderpackRef;
  type?: string;
}

export function buildWorldState(input: BuildWorldStateInput): EventTemplate {
  return {
    kind: KIND_WORLD_STATE,
    content: '',
    tags: [
      ['d', input.worldId],
      ['v', SCHEMA_VERSION],
      ['type', input.type ?? 'farm'],
      ['name', input.name],
      ['entry_map', input.entryMapId],
      ['renderpack', input.renderpack.id],
      ['renderpack_version', input.renderpack.version],
    ],
  };
}

export function parseWorldState(event: NostrEvent): WorldState | null {
  if (event.kind !== KIND_WORLD_STATE) return null;

  const id = getTag(event, 'd');
  const version = getTag(event, 'v');
  const type = getTag(event, 'type');
  const name = getTag(event, 'name');
  const entryMapId = getTag(event, 'entry_map');
  const renderpackId = getTag(event, 'renderpack');
  const renderpackVersion = getTag(event, 'renderpack_version');

  if (!isValidIdentifier(id) || !isValidIdentifier(entryMapId) || !isValidIdentifier(renderpackId)) return null;
  if (!version || !type || !name || !renderpackVersion) return null;

  return {
    event,
    id,
    version,
    owner: event.pubkey,
    type,
    name,
    entryMapId,
    renderpack: { id: renderpackId, version: renderpackVersion },
  };
}
