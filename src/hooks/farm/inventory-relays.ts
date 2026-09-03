import type { NPool, NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { buildGameInventoryFilter, buildGameInventoryFoldFilter, buildGameInventorySpendFilter } from '@/inventory/package';
import { ITEM_REGISTRY_RELAYS } from '@/inventory/constants';
import { FARM_INVENTORY_D, farmInventoryAddress } from '@/inventory/farm-inventory';
import type { FarmInventoryReadDeps } from '@/inventory/effective-inventory';
import { dedupeEventsById, type EventReference, type InventoryReadResult, type PublishOutcome } from '@/inventory/relay-io';

/**
 * Relay plumbing for kind:31633, kind:1416 and kind:1417.
 *
 * The Farm's world state (31415/31416/31417) stays on the game relay — it is
 * nobody else's business. The inventory does not: the entire point is that
 * another client can find it, so it uses the same cross-client relay set the
 * Item Registry already publishes definitions to.
 *
 * Spends and manifests are read from that SAME set. Deriving a balance from
 * one relay's spends while another configured relay holds more would apply a
 * different debit than the next reader sees; querying every configured relay
 * and deduplicating by id is the closest a client can get. It is not global
 * completeness — no relay set gives that — and nothing here claims it.
 */
export const INVENTORY_RELAYS = ITEM_REGISTRY_RELAYS;

/** The relay written into references the Farm creates (fold and inventory hints). */
export const INVENTORY_RELAY_HINT = INVENTORY_RELAYS[0];

const READ_TIMEOUT_MS = 6000;
const PUBLISH_TIMEOUT_MS = 8000;

/**
 * Is this failure a definite "no" from the relay, or just silence?
 *
 * A timeout or abort means the event may still have been accepted, which is a
 * different situation from a relay that answered with a rejection. Treating the
 * two alike is what turns a retry into a duplicate credit.
 */
function isIndefinite(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return name === 'TimeoutError' || name === 'AbortError' || message.includes('timeout') || message.includes('abort');
}

function readSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS);
}

/**
 * Query one filter on every relay in `relays`, merging and deduplicating.
 *
 * One relay answering is enough to have *an* answer; every relay failing is
 * not an empty result, it is an unusable read.
 */
async function queryRelays(
  nostr: NPool,
  relays: readonly string[],
  filter: NostrFilter,
  signal?: AbortSignal
): Promise<InventoryReadResult> {
  const results = await Promise.all(
    relays.map(async (relay) => {
      try {
        const events = await nostr.relay(relay).query([filter], { signal: readSignal(signal) });
        return { ok: true as const, events };
      } catch {
        return { ok: false as const, events: [] as NostrEvent[] };
      }
    })
  );

  return {
    events: dedupeEventsById(results.flatMap((result) => result.events)),
    answered: results.some((result) => result.ok),
  };
}

/** Relay hints worth trying: well-formed websocket URLs not already configured. */
function extraRelays(references: readonly EventReference[]): string[] {
  const extra = new Set<string>();
  for (const { relay } of references) {
    if (!/^wss?:\/\/\S+$/.test(relay)) continue;
    if (INVENTORY_RELAYS.includes(relay)) continue;
    extra.add(relay);
  }
  return [...extra];
}

export function readFarmInventory(nostr: NPool, ownerPubkey: string, signal?: AbortSignal) {
  return async (): Promise<InventoryReadResult> => {
    // The package's filter types are precise literal shapes; Nostrify wants its
    // open-ended one. The values are identical.
    const filter = buildGameInventoryFilter({
      authors: [ownerPubkey],
      inventoryIds: [FARM_INVENTORY_D],
    }) as unknown as NostrFilter;
    return queryRelays(nostr, INVENTORY_RELAYS, filter, signal);
  };
}

/**
 * Every kind:1416 the owner signed against the FULL `farm:main` address.
 *
 * Scoped by author (a valid spend is always owner-signed) and by the full
 * inventory coordinate — never by `d` alone, never by item, and never with a
 * `since`: settlement is by explicit id through the fold chain, and a spend
 * older than the snapshot can still be pending.
 */
export function readFarmSpends(nostr: NPool, ownerPubkey: string, signal?: AbortSignal) {
  return async (): Promise<InventoryReadResult> => {
    const filter = buildGameInventorySpendFilter({
      authors: [ownerPubkey],
      inventoryAddresses: [farmInventoryAddress(ownerPubkey)],
    }) as unknown as NostrFilter;
    return queryRelays(nostr, INVENTORY_RELAYS, filter, signal);
  };
}

/** Every kind:1417 the owner signed for the full `farm:main` address. */
export function readFarmFolds(nostr: NPool, ownerPubkey: string, signal?: AbortSignal) {
  return async (): Promise<InventoryReadResult> => {
    const filter = buildGameInventoryFoldFilter({
      authors: [ownerPubkey],
      inventoryAddresses: [farmInventoryAddress(ownerPubkey)],
    }) as unknown as NostrFilter;
    return queryRelays(nostr, INVENTORY_RELAYS, filter, signal);
  };
}

/**
 * Specific manifests by id, on the configured relays plus whatever relay each
 * reference hinted at. A hint is one more place to look, never the only one.
 */
export function readFarmFoldsById(nostr: NPool, signal?: AbortSignal) {
  return async (references: EventReference[]): Promise<InventoryReadResult> => {
    const ids = [...new Set(references.map((reference) => reference.eventId))];
    if (ids.length === 0) return { events: [], answered: true };
    const filter = buildGameInventoryFoldFilter({ ids }) as unknown as NostrFilter;
    return queryRelays(nostr, [...INVENTORY_RELAYS, ...extraRelays(references)], filter, signal);
  };
}

/**
 * The three filters that, together, are the whole `farm:main` ledger of one
 * player: the snapshot, every spend against it, every manifest for it.
 *
 * Exactly the filters the authoritative reads use, scoped by author and by the
 * FULL inventory address, with no `since` and nothing per item. They are what
 * the live tail subscribes to, so a relay tells the Farm about every event
 * that could change the effective balance and about nothing else.
 */
export function farmLedgerFilters(ownerPubkey: string): NostrFilter[] {
  const address = farmInventoryAddress(ownerPubkey);
  return [
    buildGameInventoryFilter({ authors: [ownerPubkey], inventoryIds: [FARM_INVENTORY_D] }),
    buildGameInventorySpendFilter({ authors: [ownerPubkey], inventoryAddresses: [address] }),
    buildGameInventoryFoldFilter({ authors: [ownerPubkey], inventoryAddresses: [address] }),
  ] as unknown as NostrFilter[];
}

/**
 * One long-lived subscription on one relay carrying the whole ledger.
 *
 * `NRelay1.req` re-sends the `REQ` whenever its socket reconnects, so the same
 * iterator keeps yielding across a dropped connection: the relay replays the
 * stored events (a second `EOSE` marks the end of that replay) and then streams
 * new ones. The iterator ends only on `CLOSED`, or throws when `signal` aborts.
 */
export function openFarmLedgerTail(nostr: NPool, ownerPubkey: string, relay: string, signal: AbortSignal) {
  return nostr.relay(relay).req(farmLedgerFilters(ownerPubkey), { signal });
}

/** Everything the effective-inventory read model needs, wired to the relays. */
export function farmInventoryReadDeps(nostr: NPool, ownerPubkey: string, signal?: AbortSignal): FarmInventoryReadDeps & {
  readInventory: () => Promise<InventoryReadResult>;
} {
  return {
    readInventory: readFarmInventory(nostr, ownerPubkey, signal),
    readSpends: readFarmSpends(nostr, ownerPubkey, signal),
    readFolds: readFarmFolds(nostr, ownerPubkey, signal),
    readFoldsById: readFarmFoldsById(nostr, signal),
  };
}

/** Offer a kind:31633 or kind:1417 to every configured inventory relay. */
export function publishFarmInventory(nostr: NPool) {
  return async (event: NostrEvent): Promise<PublishOutcome> => {
    const results = await Promise.all(
      INVENTORY_RELAYS.map(async (relay) => {
        try {
          await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
          return { relay, ok: true as const, indefinite: false, error: '' };
        } catch (error) {
          return {
            relay,
            ok: false as const,
            indefinite: isIndefinite(error),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const acceptedRelays = results.filter((result) => result.ok).map((result) => result.relay);
    const errors = results.filter((result) => !result.ok).map(({ relay, error }) => ({ relay, error }));

    if (acceptedRelays.length > 0) return { status: 'accepted', acceptedRelays, errors };

    // Nobody accepted. If any relay merely went quiet, the event may still have
    // landed there, so the honest answer is "unknown".
    const status = results.some((result) => result.indefinite) ? 'ambiguous' : 'rejected';
    return { status, acceptedRelays, errors };
  };
}
