import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';

import { DEFAULT_MAP_DEFINITION_ID, getMapDefinition } from '@/world/definitions/registry';
import { DEFAULT_RENDERPACK_REF } from '@/world/renderpack/registry';
import { buildMapState } from '@/nostr/map-state';
import { buildWorldState } from '@/nostr/world-state';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { CREATE_FARM, ERRORS } from '@/components/farm/copy';
import { farmLookupDeps, lookupFarm } from './farm-lookup';

export const DEFAULT_WORLD_ID = 'farm';
export const DEFAULT_MAP_ID = 'farm.field';

/** What a create attempt actually did. */
export type CreateFarmOutcome =
  /** Both events were published. */
  | 'created'
  /** The world already existed; only its missing field was published. */
  | 'restored'
  /** A farm was found on the relays; nothing was published. */
  | 'existing';

/**
 * Create the player's personal farm: one WorldState and one MapState, both
 * authored by the player. Nothing else is needed to start playing — slots are
 * created lazily the first time a cell is used.
 *
 * Both events are REPLACEABLE, so publishing them over an existing farm
 * silently renames it and re-points its entry map. The mutation therefore
 * never trusts what the page showed; it re-reads the relays itself,
 * immediately before publishing, and publishes only what is confirmed to be
 * missing:
 *
 *   found          → publish nothing, report `existing`
 *   field-missing  → publish the map only, keep the world, report `restored`
 *   absent         → publish world then map, report `created`
 *   unknown        → refuse
 *
 * Repeating the call is therefore safe: a second attempt after a half-finished
 * first one (world landed, map did not) restores the map rather than starting
 * over, and a second attempt after a complete one does nothing.
 */
export function useCreateFarm() {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  /**
   * The attempt in flight, if any. Two submits in the same tick both see
   * `isPending === false`; this hands the second one the first one's promise
   * instead of starting a second lookup-and-publish.
   */
  const inFlight = useRef<Promise<CreateFarmOutcome> | null>(null);

  const mutation = useMutation<CreateFarmOutcome, Error, { name: string }>({
    mutationFn: async ({ name }) => {
      if (!user) throw new Error('Sign in to create a farm.');

      const definition = getMapDefinition(DEFAULT_MAP_DEFINITION_ID);
      if (!definition) throw new Error('No map definition is available.');

      // The final existence check, on the relays, right before any publish.
      const lookup = await lookupFarm(farmLookupDeps(nostr, user.pubkey));

      if (lookup.status === 'found') return 'existing';
      if (lookup.status === 'unknown') {
        throw new Error(`${ERRORS.farmUnknownMessage} (${lookup.detail})`);
      }

      const worldId = lookup.status === 'field-missing' ? lookup.world.id : DEFAULT_WORLD_ID;
      const mapId = lookup.status === 'field-missing' ? lookup.world.entryMapId : DEFAULT_MAP_ID;

      if (lookup.status === 'absent') {
        await publishEvent(
          buildWorldState({
            worldId,
            name: name.trim() || CREATE_FARM.defaultName,
            entryMapId: mapId,
            renderpack: DEFAULT_RENDERPACK_REF,
          })
        );
      }

      await publishEvent(
        buildMapState({
          mapId,
          worldId,
          ownerPubkey: user.pubkey,
          definitionId: definition.id,
          definitionRevision: definition.revision,
          name: definition.name,
        })
      );

      return lookup.status === 'absent' ? 'created' : 'restored';
    },
    onSuccess: (outcome) => {
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast(CREATE_FARM.toasts[outcome]);
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: CREATE_FARM.failedTitle, description: error.message });
    },
  });

  const { mutateAsync } = mutation;
  const createFarm = useCallback(
    (input: { name: string }): Promise<CreateFarmOutcome> => {
      if (inFlight.current) return inFlight.current;
      const attempt = mutateAsync(input).finally(() => {
        inFlight.current = null;
      });
      inFlight.current = attempt;
      return attempt;
    },
    [mutateAsync]
  );

  return { createFarm, isCreating: mutation.isPending };
}
