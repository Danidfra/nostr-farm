import type { NPool, NostrEvent, NostrFilter } from '@nostrify/nostrify';

import {
  INVENTORY_KINDS,
  buildGameInventoryFilter,
  buildGameInventoryFoldFilter,
  buildGameInventorySpendFilter,
} from '@/inventory/package';
import { ITEM_REGISTRY_RELAYS, ITEM_REGISTRY_SECONDARY_RELAYS } from '@/inventory/constants';
import { FARM_INVENTORY_D, farmInventoryAddress } from '@/inventory/farm-inventory';
import type { FarmInventoryReadDeps } from '@/inventory/effective-inventory';
import { completeRead, type EventReference, type InventoryReadResult, type PublishOutcome } from '@/inventory/relay-io';
import { classifyRejection, type DeliveryResult } from '@/lib/relay-routing';
import { anyCompleteAmong, readFromRelays } from '@/nostr/query';
import { deliveryFromError, ownEventsOfKinds, relaySync } from '@/nostr/relay-sync';

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
 *
 * The primary relay comes first and is asked and written like the others,
 * with two differences while its write list is a pilot allowlist:
 *
 * - a write counts only when one of `INVENTORY_SECONDARY_RELAYS` accepted it.
 *   The primary refusing the player, or an event it finds too large, is then
 *   "held by the others, not by the primary", never a failed harvest;
 * - a read counts as current (`anchored`) only when one of those secondaries
 *   finished it, since that is where every write is known to be.
 */
export const INVENTORY_RELAYS = ITEM_REGISTRY_RELAYS;

/** The relays whose acceptance makes an inventory write count. */
export const INVENTORY_SECONDARY_RELAYS = ITEM_REGISTRY_SECONDARY_RELAYS;

/**
 * The relay written into references the Farm creates (fold and inventory
 * hints). A secondary, not the primary: a hint must point somewhere the event
 * certainly is.
 */
export const INVENTORY_RELAY_HINT = INVENTORY_SECONDARY_RELAYS[0];

const READ_TIMEOUT_MS = 6000;
const PUBLISH_TIMEOUT_MS = 8000;
/** Once the secondaries have answered, a relay still silent gets this much longer. */
const READ_GRACE_MS = 1500;
/** Once the secondaries have settled a publish, the primary gets this much longer to answer. */
const PRIMARY_PUBLISH_GRACE_MS = 1500;

/** The ledger kinds the Farm may carry between its inventory relays: the player's own, nothing else. */
const LEDGER_KINDS: readonly number[] = [INVENTORY_KINDS.inventory, INVENTORY_KINDS.spend, INVENTORY_KINDS.fold];

/**
 * Is this failure a definite "no" from the relay, or just silence?
 *
 * A timeout or abort means the event may still have been accepted, which is a
 * different situation from a relay that answered with a rejection. Treating the
 * two alike is what turns a retry into a duplicate credit.
 *
 * A relay that answered `OK false` with a machine-readable refusal
 * (`blocked:`, `invalid:`, `restricted:` ...) has answered, whatever words
 * follow the prefix: a write-list refusal is definite even if its text were to
 * mention a timeout.
 */
export function isIndefinite(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (classifyRejection(message) === 'rejected') return false;
  const text = message.toLowerCase();
  return text.includes('timeout') || text.includes('abort');
}

interface QueryOptions {
  signal?: AbortSignal;
  /**
   * The player whose ledger this read is, when its result may be used to
   * carry events between relays. Unset, nothing is carried.
   */
  syncOwner?: string;
  /** An empty result decides nothing here, so it need not wait for a slow relay. */
  graceOnEmpty?: boolean;
}

/**
 * Query one filter on every relay in `relays`, merging and deduplicating.
 *
 * Each relay is read until `EOSE` and its outcome kept: a relay that closed
 * the subscription or timed out DID NOT ANSWER, which is not the same as
 * answering with nothing. See `InventoryReadResult` for what each flag allows.
 *
 * Addressable events (the snapshot) are reduced to their newest revision by
 * the callers (`selectNewestInventory`); regular events (spends, manifests)
 * are history and every distinct id is kept.
 *
 * Afterwards, a relay that FINISHED its answer and lacks one of the player's
 * own ledger events another relay returned is offered the original event.
 */
async function queryRelays(
  nostr: NPool,
  relays: readonly string[],
  filter: NostrFilter,
  options: QueryOptions = {}
): Promise<InventoryReadResult> {
  const read = await readFromRelays(nostr, relays, [filter], {
    signal: options.signal,
    timeoutMs: READ_TIMEOUT_MS,
    graceMs: READ_GRACE_MS,
    anchors: INVENTORY_SECONDARY_RELAYS,
    graceOnEmpty: options.graceOnEmpty,
  });

  if (options.syncOwner) {
    void relaySync.carryMissing(nostr, {
      account: options.syncOwner,
      reads: read.reads,
      filters: [filter],
      allows: ownEventsOfKinds(options.syncOwner, LEDGER_KINDS),
      destinations: INVENTORY_RELAYS,
    });
  }

  return {
    events: read.events,
    answered: read.anyComplete,
    anchored: anyCompleteAmong(read, INVENTORY_SECONDARY_RELAYS),
    complete: read.allComplete,
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
    return queryRelays(nostr, INVENTORY_RELAYS, filter, { signal, syncOwner: ownerPubkey });
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
    return queryRelays(nostr, INVENTORY_RELAYS, filter, { signal, syncOwner: ownerPubkey, graceOnEmpty: true });
  };
}

/** Every kind:1417 the owner signed for the full `farm:main` address. */
export function readFarmFolds(nostr: NPool, ownerPubkey: string, signal?: AbortSignal) {
  return async (): Promise<InventoryReadResult> => {
    const filter = buildGameInventoryFoldFilter({
      authors: [ownerPubkey],
      inventoryAddresses: [farmInventoryAddress(ownerPubkey)],
    }) as unknown as NostrFilter;
    return queryRelays(nostr, INVENTORY_RELAYS, filter, { signal, syncOwner: ownerPubkey, graceOnEmpty: true });
  };
}

/**
 * Specific manifests by id, on the configured relays plus whatever relay each
 * reference hinted at. A hint is one more place to look, never the only one.
 */
export function readFarmFoldsById(nostr: NPool, signal?: AbortSignal, ownerPubkey?: string) {
  return async (references: EventReference[]): Promise<InventoryReadResult> => {
    const ids = [...new Set(references.map((reference) => reference.eventId))];
    if (ids.length === 0) return completeRead();
    const filter = buildGameInventoryFoldFilter({ ids }) as unknown as NostrFilter;
    // A manifest found on one relay (or on the relay a reference hinted at) and
    // certainly missing from an inventory relay is carried there, so the chain
    // resolves from any of them. Hinted relays are read, never written.
    return queryRelays(nostr, [...INVENTORY_RELAYS, ...extraRelays(references)], filter, {
      signal,
      ...(ownerPubkey ? { syncOwner: ownerPubkey } : {}),
      graceOnEmpty: true,
    });
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
    readFoldsById: readFarmFoldsById(nostr, signal, ownerPubkey),
  };
}

/**
 * Offer a kind:31633 or kind:1417 to every configured inventory relay: the
 * same signed event to the primary and to the secondaries, with each relay's
 * verdict recorded.
 *
 * `accepted` means a SECONDARY accepted it. The primary relay's answer never
 * decides the outcome on its own:
 *
 * - it refuses (a write list, or `invalid:` for a snapshot larger than it
 *   takes) or says nothing, and a secondary accepted → `accepted`. The sync
 *   ledger knows the primary is behind and the About dialog says so;
 * - ONLY the primary accepted → `ambiguous`, not `accepted`: the event exists,
 *   but not yet where other clients look for it. The caller's reconcile read
 *   then finds it and carries on, and the next read carries it to the
 *   secondaries;
 * - nobody accepted and some relay merely went quiet → `ambiguous`;
 * - everybody answered no → `rejected`.
 *
 * The primary is not waited for beyond a short grace once the secondaries
 * have settled; its late verdict still reaches the ledger.
 */
export function publishFarmInventory(nostr: NPool) {
  return async (event: NostrEvent): Promise<PublishOutcome> => {
    interface Attempt {
      relay: string;
      ok: boolean;
      indefinite: boolean;
      error: string;
      delivery: DeliveryResult;
    }
    const settled = new Map<string, Attempt>();
    const isSecondary = (relay: string) => INVENTORY_SECONDARY_RELAYS.includes(relay);

    const attempts = INVENTORY_RELAYS.map(async (relay) => {
      let attempt: Attempt;
      try {
        await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });
        attempt = { relay, ok: true, indefinite: false, error: '', delivery: { relay, verdict: 'accepted' } };
      } catch (error) {
        attempt = {
          relay,
          ok: false,
          indefinite: isIndefinite(error),
          error: error instanceof Error ? error.message : String(error),
          delivery: deliveryFromError(relay, error),
        };
      }
      settled.set(relay, attempt);
      relaySync.recordDeliveries(event, [attempt.delivery]);
    });

    const secondaries = Promise.all(attempts.filter((_, index) => isSecondary(INVENTORY_RELAYS[index])));
    await secondaries;
    await Promise.race([Promise.all(attempts), new Promise((resolve) => setTimeout(resolve, PRIMARY_PUBLISH_GRACE_MS))]);

    const results = [...settled.values()];
    const silent = INVENTORY_RELAYS.filter((relay) => !settled.has(relay));
    const acceptedRelays = results.filter((result) => result.ok).map((result) => result.relay);
    const errors = [
      ...results.filter((result) => !result.ok).map(({ relay, error }) => ({ relay, error })),
      ...silent.map((relay) => ({ relay, error: 'no answer yet' })),
    ];

    if (acceptedRelays.some(isSecondary)) return { status: 'accepted', acceptedRelays, errors };

    // No secondary accepted. If the primary did, or any relay merely went
    // quiet, the event may be (or is) out there, so the honest answer is
    // "unknown" and the caller looks for it before doing anything else.
    const unknown = acceptedRelays.length > 0 || silent.length > 0 || results.some((result) => result.indefinite);
    return { status: unknown ? 'ambiguous' : 'rejected', acceptedRelays, errors };
  };
}
