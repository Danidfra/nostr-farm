import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import {
  KIND_GAME_ITEM_DEFINITION,
  buildGameItemDefinitionFilter,
  parseGameItemDefinitionResult,
  type GameItemDefinition,
} from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY, ITEM_REGISTRY_RELAYS, ITEM_REGISTRY_SECONDARY_RELAYS } from '@/inventory/constants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { describeReads, readFromRelays, type RelayRead } from '@/nostr/query';
import { PRIMARY_RELAY_URL } from '@/nostr/relays';
import { replacesEvent } from '@/lib/relay-routing';
import { relaySync, type PublishPool } from '@/nostr/relay-sync';

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

/** One relay's answer: its events, or the reason it could not be reached. */
export interface RelayQueryResult {
  relay: string;
  events: readonly NostrEvent[];
  /** Present when the query failed. */
  error?: string;
}

/**
 * Every registry relay failed, so the registry is unknown rather than empty.
 */
export class AllRelaysFailedError extends Error {
  constructor(readonly failures: readonly RelayQueryResult[]) {
    super(
      `Could not reach any registry relay (${failures.length} failed): ` +
        failures.map((f) => `${f.relay} — ${f.error ?? 'unknown error'}`).join('; ')
    );
    this.name = 'AllRelaysFailedError';
  }
}

export const ITEM_DEFINITIONS_KEY = 'item-definitions';

export function itemDefinitionsQueryKey(scope: RegistryScope, topics: readonly string[] = []) {
  return [ITEM_DEFINITIONS_KEY, scope, [...topics].sort().join(',')] as const;
}

const QUERY_TIMEOUT_MS = 6000;
/** Once the cross-client relays have answered with definitions, a relay still silent gets this much longer. */
const QUERY_GRACE_MS = 1500;
const QUERY_LIMIT = 500;

/**
 * One relay's read as the registry reports it. A relay that did not reach
 * `EOSE` (closed the subscription, timed out, failed) is a failure, not an
 * empty answer; whatever it sent before that is still kept.
 */
export function toRelayQueryResult(read: RelayRead): RelayQueryResult {
  if (read.outcome === 'complete') return { relay: read.relay, events: read.events };
  return { relay: read.relay, events: read.events, error: describeReads([read]) };
}

/**
 * Carry official Farm item definitions to the primary relay when it certainly
 * lacks them.
 *
 * Only when the signed-in account IS the Farm issuer and has turned carrying
 * on ("About this farm"): the events are that account's own, and nobody
 * else's session copies them. For every other account, and until that choice,
 * reading the registry sends nothing.
 *
 * Deliberately one-way and one-issuer. The registry also shows items other
 * people signed (`all` scope); those are theirs to publish where they choose,
 * and this app does not copy them anywhere. Nor does it push anything to the
 * public cross-client relays: only the Farm's own issuer, only toward the
 * primary relay, which accepts recognised issuers only.
 */
export function carryOfficialDefinitions(
  nostr: PublishPool,
  account: string | undefined,
  reads: readonly RelayRead[],
  filters: readonly NostrFilter[]
): void {
  void relaySync.carryMissing(nostr, {
    account,
    reads,
    filters,
    allows: (event) => event.kind === KIND_GAME_ITEM_DEFINITION && event.pubkey === FARM_OFFICIAL_ISSUER_PUBKEY,
    destinations: [PRIMARY_RELAY_URL],
  });
}

/**
 * Reduce per-relay results to the newest VALID event per address.
 *
 * Parse first, compare second: a newer malformed event must not be able to hide
 * an older good one, and an event that fails to parse is not a definition at
 * any age. The key is the full `31632:<pubkey>:<d>` address — never the `d`
 * alone, which is not globally unique.
 */
export function selectNewestDefinitions(
  results: readonly RelayQueryResult[]
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

      if (!existing || replacesEvent(event, existing.event)) {
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
 * Reduce every relay's answer to the registry list.
 *
 * Partial failure is tolerated — one unreachable relay must not empty the
 * registry — but TOTAL failure is not silently turned into an empty list.
 * "Nobody answered" and "everybody answered, there is nothing" look identical
 * to a user staring at an empty page, and only one of them means the registry
 * is actually empty.
 *
 * @throws {AllRelaysFailedError} when every relay failed.
 */
export function collectDefinitions(results: readonly RelayQueryResult[]): ItemDefinitionRecord[] {
  const failures = results.filter((result) => result.error !== undefined);
  if (results.length > 0 && failures.length === results.length) {
    throw new AllRelaysFailedError(failures);
  }
  return [...selectNewestDefinitions(results).values()];
}

/**
 * Fold a fresh relay result over what the cache already holds, keeping the
 * newest event per address.
 *
 * Without this, a refetch immediately after publishing an update would REVERT
 * the list: relays need a moment to index, so the refetch legitimately returns
 * the previous version of the definition, and a plain replacement would drop
 * the edit the user just made and show the stale metadata back to them. The
 * rule is the same one `upsertDefinitionRecord` states — an address never moves
 * backwards in time — applied to whole result sets.
 *
 * Addresses that only exist in the cache are kept, because a refetch that no
 * longer sees them has not proven they are gone; addresses that only exist in
 * the incoming set are added.
 */
/**
 * The whole read pipeline: relay answers folded over what the cache holds.
 *
 * Exported as one function so the query's behaviour can be tested without
 * mounting anything — the hook adds only the cache lookup around this call.
 *
 * @throws {AllRelaysFailedError} when every relay failed.
 */
export function reconcileDefinitions(
  previous: readonly ItemDefinitionRecord[] | undefined,
  results: readonly RelayQueryResult[]
): ItemDefinitionRecord[] {
  return mergeNewestRecords(previous, collectDefinitions(results));
}

export function mergeNewestRecords(
  previous: readonly ItemDefinitionRecord[] | undefined,
  incoming: readonly ItemDefinitionRecord[]
): ItemDefinitionRecord[] {
  if (!previous || previous.length === 0) return [...incoming];

  const byAddress = new Map<string, ItemDefinitionRecord>();
  for (const record of previous) byAddress.set(record.address, record);

  for (const record of incoming) {
    const existing = byAddress.get(record.address);
    if (!existing || replacesEvent(record.event, existing.event)) {
      byAddress.set(record.address, record);
    }
  }

  return [...byAddress.values()];
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
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useQuery<ItemDefinitionRecord[]>({
    queryKey: itemDefinitionsQueryKey(scope, topics),
    staleTime: 30_000,
    // A total relay outage should surface quickly rather than after the default
    // three retries; a genuine blip is still retried once.
    retry: 1,
    queryFn: async ({ signal }) => {
      const filter = {
        ...buildGameItemDefinitionFilter({
          authors: scope === 'farm' ? [FARM_OFFICIAL_ISSUER_PUBKEY] : undefined,
          topics: [...topics],
        }),
        limit: QUERY_LIMIT,
      };

      // Every registry relay is asked and the answers merged: one unreachable
      // relay must not empty the registry, and every relay failing is an
      // error, not an empty registry. See collectDefinitions.
      const filters = [filter as unknown as NostrFilter];
      const read = await readFromRelays(nostr, ITEM_REGISTRY_RELAYS, filters, {
        signal,
        timeoutMs: QUERY_TIMEOUT_MS,
        graceMs: QUERY_GRACE_MS,
        anchors: ITEM_REGISTRY_SECONDARY_RELAYS,
      });
      const results = read.reads.map(toRelayQueryResult);
      carryOfficialDefinitions(nostr, user?.pubkey, read.reads, filters);

      // Merged rather than replaced, so a refetch racing a just-published
      // update cannot show the stale version back to the author.
      const queryKey = itemDefinitionsQueryKey(scope, topics);
      return reconcileDefinitions(queryClient.getQueryData<ItemDefinitionRecord[]>(queryKey), results);
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
    // Never let a cache write replace the NIP-01 winner (newer, or as new
    // with the lower id) with an event the relays would not keep.
    if (replacesEvent(previous[index].event, record.event)) return previous;
    const next = [...previous];
    next[index] = record;
    return next;
  });
}
