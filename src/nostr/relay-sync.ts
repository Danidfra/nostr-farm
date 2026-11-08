import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import {
  SyncConsent,
  SyncLedger,
  classifyRejection,
  eventAddress,
  normalizeRelayUrl,
  planSync,
  type DeliveryResult,
  type DeliveryVerdict,
  type RelayFilter,
  type RelayReadState,
  type SyncConsentRecord,
  type SyncLedgerEntry,
  type SyncPolicy,
  withSyncConsent,
} from '@/lib/relay-routing';
import type { RelayRead } from './query';
import { PRIMARY_RELAY_URL } from './relays';

/**
 * What each relay did with each event, and the carrying of events a relay is
 * certainly missing.
 *
 * Two things feed the same ledger:
 *
 *   - every publish the app makes reports its per-relay verdicts here
 *     (`recordDeliveries`), so a primary relay that refused or did not answer
 *     is known as such while the action itself succeeds on the other relays;
 *   - every multi-relay read hands its per-relay answers here
 *     (`carryMissing`). When a relay that FINISHED its answer lacks an event
 *     another relay returned, the original signed event is offered to it.
 *
 * The decisions are the shared routing module's (`planSync`, `SyncLedger`):
 * absence must be certain (`EOSE`, filter not truncated), only the winning
 * revision of an addressable event travels, and a pair (event, relay) is not
 * offered again once accepted, not for hours once refused, and only after a
 * growing wait when the relay said nothing. This module adds the sockets, one
 * guard, and what the About dialog shows.
 *
 * CARRYING IS OFF UNTIL THE ACCOUNT TURNS IT ON. Opening the app, restoring a
 * saved login or receiving the answer to a query sends nothing: a read stays
 * a read. `carryMissing` offers an existing event only for an account that
 * chose to (`consent`, per pubkey, in "About this farm"), and only to the
 * relays that account was shown. Ledger entries restored from storage are
 * retried by nothing else, so they wait for the same choice.
 *
 * One thing is not "existing": an event the player caused in THIS page
 * session whose publish a relay did not answer. Offering it to that relay
 * again, after the ledger's wait, finishes that publication and needs no
 * consent. It ends with the session: the set of such events is not stored.
 *
 * The guard: a relay that refuses an AUTHOR (`blocked:`, `restricted:`: a
 * write list) is not offered that author's other events for a while. Without
 * it a player who is not on the list would have every plot and every ledger
 * entry offered and refused one by one.
 */

/** A pool as this module needs it: something to publish to. Nostrify's `NPool` satisfies it. */
export interface PublishPool {
  relay(url: string): { event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> };
}

/** How the primary relay stands with what this device has published or read in this session. */
export interface PrimarySyncStatus {
  /**
   * `idle`: nothing known yet. `synced`: it holds everything seen.
   * `pending`: it gave no verdict for something the other relays hold; it will be offered again.
   * `refused`: it refused something the other relays hold.
   */
  state: 'idle' | 'synced' | 'pending' | 'refused';
  pending: number;
  refused: number;
  /** The relay's last refusal or failure, verbatim. */
  message?: string;
}

export interface CarryRequest {
  /**
   * The signed-in account this read was made for. Only its own events are
   * ever carried, and only once it has turned carrying on. Unset (signed
   * out): nothing is sent.
   */
  account: string | undefined;
  /** The per-relay answers of one read. */
  reads: readonly RelayRead[];
  /** The filters that read sent, for judging whether an answer may have been cut. */
  filters: readonly NostrFilter[];
  /** Whether this flow allows carrying this event at all. */
  allows(event: NostrEvent): boolean;
  /** The relays an event of this flow belongs on. */
  destinations: readonly string[] | ((event: NostrEvent) => readonly string[]);
}

export interface RelaySyncOptions {
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  primary?: string;
}

interface Persisted {
  ledger?: Record<string, SyncLedgerEntry>;
  authorBlocks?: Record<string, number>;
}

const STORAGE_KEY = 'nostr-worlds:relay-sync';
/** The accounts' answers, kept apart from the ledger: pubkeys, relay URLs and a time, nothing else. */
const CONSENT_STORAGE_KEY = 'nostr-worlds:relay-sync-consent';
const OFFER_TIMEOUT_MS = 8000;
/** Offers per relay per read. The rest wait for a later read. */
const MAX_OFFERS_PER_RELAY = 8;
/** How long a relay that refused an author is left alone for that author. */
export const AUTHOR_BLOCK_MS = 60 * 60 * 1000;
/** Refusals that are about who signed, not about the event. */
const AUTHOR_REFUSALS = ['blocked', 'restricted'];

export type RelaySync = ReturnType<typeof createRelaySync>;

export function createRelaySync(options: RelaySyncOptions = {}) {
  const now = options.now ?? Date.now;
  const storage = options.storage ?? null;
  const primary = normalizeRelayUrl(options.primary ?? PRIMARY_RELAY_URL) ?? PRIMARY_RELAY_URL;

  const persisted = load(storage);
  const authorBlocks = new Map<string, number>(Object.entries(persisted.authorBlocks ?? {}));
  const persist = () => save(storage, { ledger: ledger.snapshot(), authorBlocks: Object.fromEntries(authorBlocks) });

  const ledger: SyncLedger = new SyncLedger({
    now,
    initial: persisted.ledger,
    // A relay that is down for an evening should still get the event the next morning.
    maxAttempts: 6,
    backoffMs: [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000],
    onChange: () => persist(),
  });

  const consent = new SyncConsent({
    now,
    initial: loadConsent(storage),
    onChange: (records) => {
      try {
        storage?.setItem(CONSENT_STORAGE_KEY, JSON.stringify(records));
      } catch {
        // Not stored: the answer holds for this session only.
      }
      for (const listener of listeners) listener();
    },
  });

  /**
   * Events this page session published because the player did something.
   * Never stored: after a reload they are existing events like any other.
   */
  const publishedThisSession = new Set<string>();
  /** Such an event, still owed to a relay that gave no verdict when it was published. */
  const owedFromThisSession = (event: NostrEvent, relay: string) =>
    publishedThisSession.has(event.id) && ledger.get(event.id, relay)?.s === 'retry';

  /** The primary's last verdict per address (or per id for a regular event), this session. */
  const primaryVerdicts = new Map<string, { verdict: DeliveryVerdict; message?: string }>();
  const listeners = new Set<() => void>();
  const inFlight = new Set<string>();
  let status: PrimarySyncStatus = { state: 'idle', pending: 0, refused: 0 };

  function refreshStatus(lastMessage?: string): void {
    let pending = 0;
    let refused = 0;
    for (const entry of primaryVerdicts.values()) {
      if (entry.verdict === 'retry') pending += 1;
      if (entry.verdict === 'rejected') refused += 1;
    }
    const state = pending > 0 ? 'pending' : refused > 0 ? 'refused' : primaryVerdicts.size > 0 ? 'synced' : 'idle';
    const message = state === 'pending' || state === 'refused' ? (lastMessage ?? status.message) : undefined;
    status = { state, pending, refused, ...(message ? { message } : {}) };
    for (const listener of listeners) listener();
  }

  const blockKey = (relay: string, pubkey: string) => `${normalizeRelayUrl(relay) ?? relay}|${pubkey}`;

  function isAuthorBlocked(relay: string, pubkey: string): boolean {
    const until = authorBlocks.get(blockKey(relay, pubkey));
    return until !== undefined && until > now();
  }

  function record(event: NostrEvent, result: DeliveryResult): void {
    ledger.record(event.id, result.relay, result.verdict, result.message);

    const key = blockKey(result.relay, event.pubkey);
    const text = (result.message ?? '').trim().toLowerCase();
    if (result.verdict === 'rejected' && AUTHOR_REFUSALS.some((prefix) => text.startsWith(prefix))) {
      authorBlocks.set(key, now() + AUTHOR_BLOCK_MS);
      persist();
    } else if (result.verdict === 'accepted' && authorBlocks.delete(key)) {
      persist();
    }

    if ((normalizeRelayUrl(result.relay) ?? result.relay) === primary) {
      primaryVerdicts.set(eventAddress(event) ?? event.id, { verdict: result.verdict, message: result.message });
      refreshStatus(result.verdict === 'retry' || result.verdict === 'rejected' ? result.message : undefined);
    }
  }

  /** Offer one event to one relay and record what it said. Never throws. */
  async function offer(nostr: PublishPool, event: NostrEvent, relay: string): Promise<DeliveryResult> {
    let result: DeliveryResult;
    try {
      await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(OFFER_TIMEOUT_MS) });
      result = { relay, verdict: 'accepted' };
    } catch (error) {
      result = deliveryFromError(relay, error);
    }
    record(event, result);
    return result;
  }

  return {
    ledger,
    consent,

    /** Report what each relay said about an event the player's action has just published. */
    recordDeliveries(event: NostrEvent, results: readonly DeliveryResult[]): void {
      publishedThisSession.add(event.id);
      for (const result of results) record(event, result);
    },

    isAuthorBlocked,

    /**
     * After a read: offer each relay the events it certainly lacks, IF the
     * account turned carrying on, and then only to the relays it agreed to.
     * Without that the only thing ever offered is an event this session
     * itself published and a relay left unanswered. Resolves with what was
     * attempted; never rejects.
     *
     * Per relay the offers go one at a time and stop at the first refusal of
     * the author, so a write list costs one refused event, not one per plot.
     */
    async carryMissing(nostr: PublishPool, request: CarryRequest): Promise<DeliveryResult[]> {
      try {
        const states: RelayReadState<NostrEvent>[] = request.reads.map((read) => ({
          relay: read.relay,
          status: read.outcome === 'complete' ? 'eose' : 'failed',
          events: read.events,
        }));
        const account = request.account;
        if (!account) return [];
        const destinations = request.destinations;
        const flow: SyncPolicy<NostrEvent> = {
          allows: request.allows,
          destinations: typeof destinations === 'function' ? destinations : () => destinations,
        };
        const consented = withSyncConsent(flow, consent, account);
        const tasks = planSync({
          states,
          filters: request.filters as unknown as RelayFilter[],
          policy: {
            allows: (event) =>
              event.pubkey === account && flow.allows(event) && (consent.isEnabled(account) || publishedThisSession.has(event.id)),
            destinations: (event) => {
              const agreed = consented.allows(event) ? consented.destinations(event) : [];
              const owed = flow.destinations(event).filter((relay) => owedFromThisSession(event, relay));
              return [...agreed, ...owed];
            },
          },
        });

        const byRelay = new Map<string, NostrEvent[]>();
        for (const task of tasks) {
          const key = SyncLedger.key(task.event.id, task.relay);
          if (inFlight.has(key) || !ledger.canAttempt(task.event.id, task.relay)) continue;
          if (isAuthorBlocked(task.relay, task.event.pubkey)) continue;
          const queue = byRelay.get(task.relay) ?? [];
          if (queue.length >= MAX_OFFERS_PER_RELAY) continue;
          queue.push(task.event);
          byRelay.set(task.relay, queue);
          inFlight.add(key);
        }

        const results = await Promise.all(
          [...byRelay].map(async ([relay, events]) => {
            const done: DeliveryResult[] = [];
            try {
              for (const event of events) {
                if (isAuthorBlocked(relay, event.pubkey)) continue;
                done.push(await offer(nostr, event, relay));
              }
            } finally {
              for (const event of events) inFlight.delete(SyncLedger.key(event.id, relay));
            }
            return done;
          })
        );
        return results.flat();
      } catch {
        return [];
      }
    },

    status: (): PrimarySyncStatus => status,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The usual flow rule: only events the player signed, of the kinds the flow owns. */
export function ownEventsOfKinds(ownerPubkey: string, kinds: readonly number[]): (event: NostrEvent) => boolean {
  return (event) => event.pubkey === ownerPubkey && kinds.includes(event.kind);
}

/** A relay's refusal, or its silence, as a verdict. A thrown timeout or a dropped socket is `retry`. */
export function deliveryFromError(relay: string, error: unknown): DeliveryResult {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const verdict = name === 'TimeoutError' || name === 'AbortError' ? 'retry' : classifyRejection(message);
  return { relay, verdict, message };
}

function loadConsent(storage: RelaySyncOptions['storage']): Record<string, SyncConsentRecord> {
  try {
    const raw = storage?.getItem(CONSENT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, SyncConsentRecord>) : {};
  } catch {
    return {};
  }
}

function load(storage: RelaySyncOptions['storage']): Persisted {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Persisted) : {};
  } catch {
    return {};
  }
}

function save(storage: RelaySyncOptions['storage'], value: Persisted): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the ledger still works for this session.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app's one ledger. Tests build their own with `createRelaySync`. */
export const relaySync = createRelaySync({ storage: browserStorage() });
