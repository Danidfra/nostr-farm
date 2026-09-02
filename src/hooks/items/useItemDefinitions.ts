import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';

import {
  buildGameItemDefinitionFilter,
  parseGameItemDefinitionResult,
  type GameItemDefinition,
} from '@/inventory/package';
import { FARM_ISSUER_PUBKEY, ITEM_REGISTRY_RELAYS } from '@/inventory/constants';

/** How the registry scopes its relay query. */
export type RegistryScope = 'farm' | 'all';

export interface ItemDefinitionRecord {
  address: string;
  event: NostrEvent;
  definition: GameItemDefinition;
  warnings: string[];
  /** Relays this exact event was seen on. */
  relays: string[];
}

export const ITEM_DEFINITIONS_KEY = 'item-definitions';

export function itemDefinitionsQueryKey(scope: RegistryScope, topics: readonly string[] = []) {
  return [ITEM_DEFINITIONS_KEY, scope, [...topics].sort().join(',')] as const;
}

const QUERY_TIMEOUT_MS = 6000;
const QUERY_LIMIT = 500;

/**
 * Reduce per-relay results to the newest VALID event per address.
 *
 * Parse first, compare second: a newer malformed event must not be able to hide
 * an older good one, and an event that fails to parse is not a definition at
 * any age. The key is the full `31632:<pubkey>:<d>` address — never the `d`
 * alone, which is not globally unique.
 */
export function selectNewestDefinitions(
  results: readonly { relay: string; events: readonly NostrEvent[] }[]
): Map<string, ItemDefinitionRecord> {
  const byAddress = new Map<string, ItemDefinitionRecord>();

  for (const { relay, events } of results) {
    for (const event of events) {
      const parsed = parseGameItemDefinitionResult(event, { mode: 'permissive' });
      if (!parsed.ok) continue;

      const address = parsed.value.address;
      const existing = byAddress.get(address);
      const record: ItemDefinitionRecord = {
        address,
        event,
        definition: parsed.value,
        warnings: parsed.warnings.map((w) => `${w.code}: ${w.message}`),
        relays: [relay],
      };

      if (!existing || event.created_at > existing.event.created_at) {
        byAddress.set(address, record);
      } else if (event.id === existing.event.id && !existing.relays.includes(relay)) {
        // The same event on another relay: record the extra source rather than
        // replacing a record that is already current.
        existing.relays.push(relay);
      }
    }
  }

  return byAddress;
}

/**
 * Read kind:31632 definitions for the registry.
 *
 * Scope decides what is asked of the relays, and the default is deliberately
 * narrow: `farm` asks only for the official issuer's items, which is one
 * indexed `authors` query. `all` drops the author filter and is an explicit
 * opt-in, because "every 31632 ever published" is not a query any relay should
 * be asked casually.
 *
 * Parsing applies no issuer filter — the registry's job is to show you what is
 * out there, correctly labelled. Trust is a display concern here, enforced by
 * the issuer badge on every row, not by hiding events.
 */
export function useItemDefinitions(scope: RegistryScope, topics: readonly string[] = []) {
  const { nostr } = useNostr();

  return useQuery<ItemDefinitionRecord[]>({
    queryKey: itemDefinitionsQueryKey(scope, topics),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const filter = {
        ...buildGameItemDefinitionFilter({
          authors: scope === 'farm' ? [FARM_ISSUER_PUBKEY] : undefined,
          topics: [...topics],
        }),
        limit: QUERY_LIMIT,
      };

      const timeout = AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]);

      const results = await Promise.all(
        ITEM_REGISTRY_RELAYS.map(async (relay) => {
          try {
            const events = await nostr.relay(relay).query([filter], { signal: timeout });
            return { relay, events };
          } catch {
            // One unreachable relay must not empty the registry.
            return { relay, events: [] as NostrEvent[] };
          }
        })
      );

      return [...selectNewestDefinitions(results).values()];
    },
  });
}

/**
 * Insert a freshly published definition into every cached list, so the item
 * appears immediately without waiting for a refetch.
 */
export function upsertDefinitionRecord(queryClient: QueryClient, record: ItemDefinitionRecord): void {
  queryClient.setQueriesData<ItemDefinitionRecord[]>({ queryKey: [ITEM_DEFINITIONS_KEY] }, (previous) => {
    if (!previous) return previous;
    const index = previous.findIndex((entry) => entry.address === record.address);
    if (index === -1) return [...previous, record];
    // Never let a cache write move an address backwards in time.
    if (previous[index].event.created_at > record.event.created_at) return previous;
    const next = [...previous];
    next[index] = record;
    return next;
  });
}
