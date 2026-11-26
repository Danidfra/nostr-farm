import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';

import { farmLookupDeps, lookupFarm, type Farm, type FarmLookup } from './farm-lookup';

export type { Farm, FarmLookup } from './farm-lookup';

/**
 * Load the signed-in player's farm: their world, its entry map, and the
 * source-controlled definition that map names.
 *
 * Everything is scoped to `authors: [pubkey]`. V1 farms are personal, so the
 * owner is the only authority and there is nothing to arbitrate.
 *
 * The result is a {@link FarmLookup}, not `Farm | null`: "no farm" is a claim
 * the relays have to back with a completed read, twice, and anything short of
 * that is `unknown`. The page offers to create a farm only on `absent`.
 */
export function useFarm(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<FarmLookup>({
    queryKey: ['farm', pubkey],
    enabled: !!pubkey,
    queryFn: ({ signal }) => lookupFarm(farmLookupDeps(nostr, pubkey!, signal)),
  });
}

/** The farm itself when the lookup found one, otherwise `undefined`. */
export function foundFarm(lookup: FarmLookup | undefined): Farm | undefined {
  return lookup?.status === 'found' ? lookup.farm : undefined;
}
