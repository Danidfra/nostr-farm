import type { NostrEvent } from '@nostrify/nostrify';

import { buildMapState } from '@/nostr/map-state';
import { buildWorldState } from '@/nostr/world-state';
import { DEFAULT_RENDERPACK_REF } from '@/world/renderpack/registry';
import { farmFieldMap } from '@/world/definitions/maps/farm-field';

export const FARM_OWNER = 'a'.repeat(64);
export const WORLD_ID = 'farm';
export const MAP_ID = 'farm.field';

let counter = 0;
function fakeId(label: string): string {
  counter += 1;
  return `${label}${counter}`.padEnd(64, '0').slice(0, 64);
}

/** A signed-looking kind:31415 for `owner`, as `useCreateFarm` would publish it. */
export function worldEvent(opts: { owner?: string; name?: string; createdAt?: number; id?: string } = {}): NostrEvent {
  const owner = opts.owner ?? FARM_OWNER;
  return {
    ...buildWorldState({ worldId: WORLD_ID, name: opts.name ?? 'Willow Patch', entryMapId: MAP_ID, renderpack: DEFAULT_RENDERPACK_REF }),
    id: opts.id ?? fakeId('w'),
    pubkey: owner,
    created_at: opts.createdAt ?? 1_700_000_000,
    sig: 'x'.repeat(128),
  };
}

/** A signed-looking kind:31416 for `owner`'s `farm.field`. */
export function mapEvent(opts: { owner?: string; createdAt?: number; id?: string } = {}): NostrEvent {
  const owner = opts.owner ?? FARM_OWNER;
  return {
    ...buildMapState({
      mapId: MAP_ID,
      worldId: WORLD_ID,
      ownerPubkey: owner,
      definitionId: farmFieldMap.id,
      definitionRevision: farmFieldMap.revision,
      name: farmFieldMap.name,
    }),
    id: opts.id ?? fakeId('m'),
    pubkey: owner,
    created_at: opts.createdAt ?? 1_700_000_001,
    sig: 'x'.repeat(128),
  };
}
