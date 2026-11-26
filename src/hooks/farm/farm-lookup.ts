import type { NostrFilter } from '@nostrify/nostrify';

import { KIND_MAP_STATE, KIND_WORLD_STATE } from '@/nostr/kinds';
import { worldRef } from '@/nostr/identifiers';
import { mergeRelayEvents } from '@/lib/relay-routing';
import { describeReads, readFromRelays, type MultiRelayRead, type RelayPool } from '@/nostr/query';
import { GAME_RELAY_URLS, REQUIRED_GAME_RELAY_URLS } from '@/nostr/relays';
import { ownEventsOfKinds, relaySync, type PublishPool } from '@/nostr/relay-sync';
import { parseWorldState, type WorldState } from '@/nostr/world-state';
import { parseMapState, type MapState } from '@/nostr/map-state';
import { getMapDefinition } from '@/world/definitions/registry';
import type { MapDefinition } from '@/world/definitions/schema';

export interface Farm {
  world: WorldState;
  map: MapState;
  definition: MapDefinition;
}

/** Why a lookup could not say whether the farm exists. */
export type LookupFailure =
  /** No relay finished; every read timed out, was closed or errored. */
  | 'unreachable'
  /** Some relays finished and some did not, so one of them may hold the farm. */
  | 'partial';

/**
 * What the relays know about the player's farm.
 *
 * Only `absent` and `field-missing` may lead to a publish, and both are
 * CONFIRMED states: every configured game relay said `EOSE` with nothing
 * matching, on two reads separated by a pause. Everything less certain is
 * `unknown`, which shows a retry and never a Create button.
 */
export type FarmLookup =
  | { status: 'found'; farm: Farm }
  /** Confirmed: no world event on any game relay. Creating one is safe. */
  | { status: 'absent' }
  /** Confirmed: the world exists but its entry map does not. Only the map should be published. */
  | { status: 'field-missing'; world: WorldState }
  /** Not confirmed either way. Nothing may be created. */
  | { status: 'unknown'; reason: LookupFailure; detail: string };

export interface FarmLookupDeps {
  ownerPubkey: string;
  read(filters: NostrFilter[]): Promise<MultiRelayRead>;
  /** Pause between the two reads that confirm an absence. */
  wait(): Promise<void>;
}

const WORLD_LIMIT = 20;
const MAP_LIMIT = 20;

/**
 * Find the owner's farm, or confirm that there is none.
 *
 * An empty read is re-read once after a pause before it is believed, the same
 * rule `readConfirmedBase` applies to the inventory: a relay that has not
 * caught up, or one that quietly closed the subscription, must not turn into
 * "no farm" and then into a replacement world event.
 *
 * The asymmetry is deliberate: an event that arrives before the stream is cut
 * off still proves the farm EXISTS, so an incomplete read can find a farm.
 * Only the claim that there is none needs every relay to have finished.
 */
export async function lookupFarm(deps: FarmLookupDeps): Promise<FarmLookup> {
  const worldFilter: NostrFilter = { kinds: [KIND_WORLD_STATE], authors: [deps.ownerPubkey], limit: WORLD_LIMIT };

  let read = await deps.read([worldFilter]);
  let world = newestWorld(read, deps.ownerPubkey);

  if (!world) {
    if (!read.allComplete) return unknown(read);
    await deps.wait();
    read = await deps.read([worldFilter]);
    world = newestWorld(read, deps.ownerPubkey);
    if (!world) return read.allComplete ? { status: 'absent' } : unknown(read);
  }

  const mapFilter: NostrFilter = {
    kinds: [KIND_MAP_STATE],
    authors: [deps.ownerPubkey],
    '#a': [worldRef(deps.ownerPubkey, world.id)],
    limit: MAP_LIMIT,
  };

  let maps = await deps.read([mapFilter]);
  let map = pickMap(maps, deps.ownerPubkey, world);

  if (!map) {
    if (!maps.allComplete) return unknown(maps);
    await deps.wait();
    maps = await deps.read([mapFilter]);
    map = pickMap(maps, deps.ownerPubkey, world);
    if (!map) return maps.allComplete ? { status: 'field-missing', world } : unknown(maps);
  }

  const definition = getMapDefinition(map.definitionId);
  if (!definition) {
    throw new Error(`This farm references an unknown map definition "${map.definitionId}".`);
  }

  return { status: 'found', farm: { world, map, definition } };
}

/**
 * The newest valid world across every relay that answered.
 *
 * Parse first, compare second: an event that does not parse is not a world at
 * any age and must not hide an older good one. Among the valid ones, each
 * address keeps its NIP-01 winner (newer, then the lower id) wherever it came
 * from, and the newest of those is the farm.
 */
function newestWorld(read: MultiRelayRead, ownerPubkey: string): WorldState | undefined {
  const worlds = read.events
    .filter((event) => event.pubkey === ownerPubkey)
    .map(parseWorldState)
    .filter((w): w is WorldState => w !== null);
  const winner = mergeRelayEvents(worlds.map((w) => w.event))[0];
  return winner && worlds.find((w) => w.event.id === winner.id);
}

function pickMap(read: MultiRelayRead, ownerPubkey: string, world: WorldState): MapState | undefined {
  const parsed = read.events
    .filter((event) => event.pubkey === ownerPubkey)
    .map(parseMapState)
    .filter((m): m is MapState => m !== null && m.worldId === world.id);
  // One revision per map: the newest any relay returned, never the first relay's.
  const winners = new Set(mergeRelayEvents(parsed.map((m) => m.event)).map((event) => event.id));
  const maps = parsed.filter((m) => winners.has(m.event.id));
  return maps.find((m) => m.id === world.entryMapId) ?? maps[0];
}

function unknown(read: MultiRelayRead): FarmLookup {
  return { status: 'unknown', reason: read.anyComplete ? 'partial' : 'unreachable', detail: describeReads(read.reads) };
}

/** Each relay gets this long to reach `EOSE`. */
export const LOOKUP_TIMEOUT_MS = 5000;
/** Pause before an empty result is re-read. */
export const CONFIRM_ABSENCE_DELAY_MS = 2000;

/** A relay that is not required gets this much longer once the required ones have answered with something. */
export const LOOKUP_GRACE_MS = 1500;

/**
 * The production wiring: every configured game relay, real timeouts, a real pause.
 *
 * A farm that was FOUND is not held back for a slow relay. A farm that was
 * not found waits for every relay, because only all of them together can say
 * there is none. After each read, a relay that finished its answer without
 * the player's newest world or map is offered that event.
 */
export function farmLookupDeps(nostr: RelayPool & PublishPool, ownerPubkey: string, signal?: AbortSignal): FarmLookupDeps {
  return {
    ownerPubkey,
    read: async (filters) => {
      const read = await readFromRelays(nostr, GAME_RELAY_URLS, filters, {
        signal,
        timeoutMs: LOOKUP_TIMEOUT_MS,
        graceMs: LOOKUP_GRACE_MS,
        anchors: REQUIRED_GAME_RELAY_URLS,
      });
      void relaySync.carryMissing(nostr, {
        account: ownerPubkey,
        reads: read.reads,
        filters,
        allows: ownEventsOfKinds(ownerPubkey, [KIND_WORLD_STATE, KIND_MAP_STATE]),
        destinations: GAME_RELAY_URLS,
      });
      return read;
    },
    wait: () =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, CONFIRM_ABSENCE_DELAY_MS);
        signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
      }),
  };
}
