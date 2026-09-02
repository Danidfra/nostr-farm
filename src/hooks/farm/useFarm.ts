import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';

import { DEFAULT_GAME_RELAY } from '@/nostr/relays';
import { KIND_MAP_STATE, KIND_WORLD_STATE } from '@/nostr/kinds';
import { parseWorldState, type WorldState } from '@/nostr/world-state';
import { parseMapState, type MapState } from '@/nostr/map-state';
import { worldRef } from '@/nostr/identifiers';
import { getMapDefinition } from '@/world/definitions/registry';
import type { MapDefinition } from '@/world/definitions/schema';

export interface Farm {
  world: WorldState;
  map: MapState;
  definition: MapDefinition;
}

const QUERY_TIMEOUT_MS = 5000;

/**
 * Load the signed-in player's farm: their world, its entry map, and the
 * source-controlled definition that map names.
 *
 * Everything is scoped to `authors: [pubkey]`. V1 farms are personal, so the
 * owner is the only authority and there is nothing to arbitrate.
 */
export function useFarm(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<Farm | null>({
    queryKey: ['farm', pubkey],
    enabled: !!pubkey,
    queryFn: async ({ signal }) => {
      if (!pubkey) return null;
      const relay = nostr.relay(DEFAULT_GAME_RELAY);
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]);

      const worldEvents = await relay.query([{ kinds: [KIND_WORLD_STATE], authors: [pubkey], limit: 20 }], { signal: timeout });
      const worlds = worldEvents
        .map(parseWorldState)
        .filter((w): w is WorldState => w !== null)
        .sort((a, b) => b.event.created_at - a.event.created_at);

      const world = worlds[0];
      if (!world) return null;

      const mapEvents = await relay.query(
        [{ kinds: [KIND_MAP_STATE], authors: [pubkey], '#a': [worldRef(pubkey, world.id)], limit: 20 }],
        { signal: timeout }
      );
      const maps = mapEvents
        .map(parseMapState)
        .filter((m): m is MapState => m !== null && m.worldId === world.id);

      const map = maps.find((m) => m.id === world.entryMapId) ?? maps[0];
      if (!map) return null;

      const definition = getMapDefinition(map.definitionId);
      if (!definition) {
        throw new Error(`This farm references an unknown map definition "${map.definitionId}".`);
      }

      return { world, map, definition };
    },
  });
}
