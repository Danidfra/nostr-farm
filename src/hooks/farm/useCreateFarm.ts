import { useMutation, useQueryClient } from '@tanstack/react-query';

import { DEFAULT_MAP_DEFINITION_ID, getMapDefinition } from '@/world/definitions/registry';
import { DEFAULT_RENDERPACK_REF } from '@/world/renderpack/registry';
import { buildMapState } from '@/nostr/map-state';
import { buildWorldState } from '@/nostr/world-state';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';

export const DEFAULT_WORLD_ID = 'farm';
export const DEFAULT_MAP_ID = 'farm.field';

/**
 * Create the player's personal farm: one WorldState and one MapState, both
 * authored by the player. Nothing else is needed to start playing — slots are
 * created lazily the first time a cell is used.
 */
export function useCreateFarm() {
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async ({ name }: { name: string }) => {
      if (!user) throw new Error('Sign in to create a farm.');

      const definition = getMapDefinition(DEFAULT_MAP_DEFINITION_ID);
      if (!definition) throw new Error('No map definition is available.');

      await publishEvent(
        buildWorldState({
          worldId: DEFAULT_WORLD_ID,
          name: name.trim() || 'My Farm',
          entryMapId: DEFAULT_MAP_ID,
          renderpack: DEFAULT_RENDERPACK_REF,
        })
      );

      await publishEvent(
        buildMapState({
          mapId: DEFAULT_MAP_ID,
          worldId: DEFAULT_WORLD_ID,
          ownerPubkey: user.pubkey,
          definitionId: definition.id,
          definitionRevision: definition.revision,
          name: definition.name,
        })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['farm'] });
      toast({ title: 'Farm created', description: 'Your field is ready.' });
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: 'Could not create farm', description: error.message });
    },
  });

  return { createFarm: mutation.mutateAsync, isCreating: mutation.isPending };
}
