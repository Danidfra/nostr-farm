import { onlineManager, type QueryClient } from '@tanstack/react-query';
import type { NPool, NostrEvent } from '@nostrify/nostrify';

import { admitFarmInventoryEvents, farmInventoryQueryKey, farmInventoryQueryOptions, type FarmInventoryView } from './useFarmInventory';
import { INVENTORY_RELAYS, openFarmLedgerTail, readFarmFoldsById } from './inventory-relays';

/**
 * Keeps the cached `farm:main` ledger current while the Farm is open.
 *
 * ```text
 *   subscribe (one REQ per inventory relay, three filters)
 *       │  events buffered
 *   authoritative fetch  ──►  commit (merge)  ──►  flush buffer  ──►  LIVE
 *                                                                     │
 *   live EVENT ─────────────────────────────────────────► admit → re-derive
 *   reconnect replay (second EOSE) / iterator ended / back online
 *                                          └──► authoritative refetch (merge)
 *   view unresolved for a missing manifest ──► fetch it by id, bounded backoff
 * ```
 *
 * **Subscribe first, then fetch.** Every event the relay sends from the moment
 * the `REQ` is open is held until the authoritative fetch has committed, then
 * admitted on top of it. An event that lands between the fetch reading the
 * relay and the cache commit is therefore in the buffer, and an event that
 * lands after is admitted directly; there is no instant at which one can be
 * missed. Before the fetch has landed nothing is shown, because a partially
 * replayed ledger — the snapshot without its spends — is not a balance.
 *
 * **Recovery is event-driven.** A relay that reconnects re-sends the `REQ` and
 * replays (`NRelay1`); a `CLOSED` or a failed iterator is restarted with a
 * bounded backoff; going back online triggers a refetch. Each of those ends in
 * an authoritative fetch merged into the cache. There is no interval, no
 * periodic poll and no `since` watermark: every read asks for the whole ledger
 * and the merge keeps whatever is newest.
 *
 * **Nothing here is trusted by a write.** `creditHarvest` performs its own
 * confirmed read inside the write lock; this cache is for what the player sees.
 */
export interface FarmInventoryLiveDeps {
  nostr: NPool;
  queryClient: QueryClient;
  ownerPubkey: string;
  /** Relays to tail. Defaults to the configured inventory relays. */
  relays?: readonly string[];
}

export interface FarmInventoryLive {
  /** Abort every subscription, cancel every timer, and ignore anything still in flight. */
  stop(): void;
}

/** Backoff (ms) before attempt `n` (1-based) of a bounded retry: 2s, 4s, … capped. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
}
/** Missing-manifest fetches: rounds per unresolved head before waiting for an external trigger. */
export const MAX_MISSING_FOLD_ATTEMPTS = 6;
/** Failed authoritative fetches before waiting for an external trigger. */
export const MAX_FETCH_ATTEMPTS = 6;
/** Consecutive restarts of one relay's subscription before waiting for an external trigger. */
export const MAX_TAIL_RESTARTS = 8;
/** A subscription that lived this long before ending resets that relay's restart count. */
const STABLE_TAIL_MS = 60_000;

export function startFarmInventoryLive(deps: FarmInventoryLiveDeps): FarmInventoryLive {
  const { nostr, queryClient, ownerPubkey } = deps;
  const relays = deps.relays ?? INVENTORY_RELAYS;
  const key = farmInventoryQueryKey(ownerPubkey);
  const options = farmInventoryQueryOptions(nostr, ownerPubkey);
  const readFoldsById = readFarmFoldsById(nostr);

  const abort = new AbortController();
  let stopped = false;

  // Until the first authoritative fetch has committed, live events wait here.
  let phase: 'buffering' | 'live' = 'buffering';
  const buffer = new Map<string, NostrEvent>();

  let fetching: Promise<void> | null = null;
  let refetchRequested = false;
  let fetchAttempts = 0;
  let fetchRetry: ReturnType<typeof setTimeout> | undefined;

  let missingHead = '';
  let missingAttempts = 0;
  let missingRetry: ReturnType<typeof setTimeout> | undefined;
  let resolving = false;
  let resolveAgain = false;

  const tails = new Map<string, boolean>();

  function admit(event: NostrEvent): void {
    if (stopped) return;
    if (phase === 'live' && queryClient.getQueryData(key) === undefined) {
      // The cache was cleared under us; what we hold is no longer a superset
      // of anything. Hold events again until a fresh fetch lands.
      phase = 'buffering';
      ensureFetched();
    }
    if (phase === 'buffering') {
      buffer.set(event.id, event);
      return;
    }
    if (admitFarmInventoryEvents(queryClient, ownerPubkey, [event])) settleMissingFolds();
  }

  /** Run the authoritative read and merge it. Deduplicated while in flight. */
  function ensureFetched(): void {
    if (stopped) return;
    if (fetching) {
      refetchRequested = true;
      return;
    }
    clearTimeout(fetchRetry);
    fetchRetry = undefined;

    fetching = queryClient.fetchQuery({ ...options, staleTime: 0 }).then(
      () => {
        fetching = null;
        if (stopped) return;
        fetchAttempts = 0;
        missingAttempts = 0;
        goLive();
        if (refetchRequested) {
          refetchRequested = false;
          ensureFetched();
        }
      },
      () => {
        fetching = null;
        if (stopped) return;
        refetchRequested = false;
        fetchAttempts += 1;
        if (fetchAttempts <= MAX_FETCH_ATTEMPTS) {
          fetchRetry = setTimeout(() => {
            fetchRetry = undefined;
            ensureFetched();
          }, retryDelayMs(fetchAttempts));
        }
      }
    );
  }

  /** The fetch has committed: replay what the tail held, then admit directly. */
  function goLive(): void {
    if (phase === 'buffering') {
      phase = 'live';
      const held = [...buffer.values()];
      buffer.clear();
      if (held.length > 0) admitFarmInventoryEvents(queryClient, ownerPubkey, held);
    }
    settleMissingFolds();
  }

  /**
   * If the committed view is unresolved for want of a manifest, fetch it by id.
   *
   * One round per call; a round that makes progress (a deeper link now
   * missing) continues at once, a round that finds nothing waits out a bounded
   * backoff. A different missing head resets the count. A view unresolved for
   * any other reason — a foreign, malformed or cyclic manifest — is left
   * alone: fetching will not fix it.
   */
  function settleMissingFolds(): void {
    if (stopped || phase !== 'live') return;
    const view = queryClient.getQueryData<FarmInventoryView>(key);
    const missing = view?.status === 'unresolved' ? view.missingFolds : [];
    if (missing.length === 0) {
      missingHead = '';
      missingAttempts = 0;
      clearTimeout(missingRetry);
      missingRetry = undefined;
      return;
    }
    if (resolving) {
      resolveAgain = true;
      return;
    }

    const head = missing.map((reference) => reference.eventId).sort().join(',');
    if (head !== missingHead) {
      // Something new to look for: start its budget afresh, and do not wait
      // out a backoff that was scheduled for the previous head.
      missingHead = head;
      missingAttempts = 0;
      clearTimeout(missingRetry);
      missingRetry = undefined;
    }
    if (missingRetry !== undefined || missingAttempts >= MAX_MISSING_FOLD_ATTEMPTS) return;

    missingAttempts += 1;
    resolving = true;
    void readFoldsById(missing)
      .then((fetched) => {
        if (stopped) return;
        if (admitFarmInventoryEvents(queryClient, ownerPubkey, fetched.events)) {
          // Progress: the view changed, so look again at once for whatever the
          // chain needs next (the next `previous` link, typically).
          resolveAgain = true;
        } else if (missingAttempts < MAX_MISSING_FOLD_ATTEMPTS) {
          settleMissingFoldsLater(retryDelayMs(missingAttempts));
        }
      })
      .catch(() => {
        if (!stopped && missingAttempts < MAX_MISSING_FOLD_ATTEMPTS) settleMissingFoldsLater(retryDelayMs(missingAttempts));
      })
      .finally(() => {
        resolving = false;
        if (resolveAgain && !stopped) {
          resolveAgain = false;
          settleMissingFolds();
        }
      });
  }

  function settleMissingFoldsLater(delay: number): void {
    clearTimeout(missingRetry);
    missingRetry = setTimeout(() => {
      missingRetry = undefined;
      settleMissingFolds();
    }, delay);
  }

  /**
   * Tail one relay for as long as we are running.
   *
   * The iterator normally never ends: `NRelay1` keeps the `REQ` across socket
   * reconnects and the relay replays into the same iterator, signalling the end
   * of each replay with an `EOSE`. An `EOSE` after the first one is therefore
   * the sign of a reconnect, and the cue for an authoritative refetch. If the
   * iterator does end — `CLOSED`, or a failure — it is reopened after a
   * bounded backoff, and a refetch covers whatever was missed in between.
   */
  async function tail(relay: string): Promise<void> {
    tails.set(relay, true);
    let restarts = 0;
    try {
      while (!stopped) {
        let eoseSeen = false;
        const openedAt = Date.now();
        try {
          for await (const message of openFarmLedgerTail(nostr, ownerPubkey, relay, abort.signal)) {
            if (message[0] === 'EVENT') {
              admit(message[2]);
            } else if (message[0] === 'EOSE') {
              if (eoseSeen) ensureFetched();
              eoseSeen = true;
            } else if (message[0] === 'CLOSED') {
              break;
            }
          }
        } catch {
          // Aborted by `stop()`, or the relay failed: both fall through.
        }
        if (stopped) return;

        // A subscription that held for a while and then dropped is an ordinary
        // hiccup, not one more failure of a relay that keeps refusing us.
        if (Date.now() - openedAt >= STABLE_TAIL_MS) restarts = 0;
        restarts += 1;
        if (restarts > MAX_TAIL_RESTARTS) return;
        await sleep(retryDelayMs(restarts), abort.signal);
        if (stopped) return;
        ensureFetched();
      }
    } finally {
      tails.set(relay, false);
    }
  }

  function startTails(): void {
    for (const relay of relays) {
      if (!tails.get(relay)) void tail(relay);
    }
  }

  // Back online: reopen any tail that gave up, and read the ledger afresh.
  const unsubscribeOnline = onlineManager.subscribe((online) => {
    if (!online || stopped) return;
    fetchAttempts = 0;
    missingAttempts = 0;
    startTails();
    ensureFetched();
  });

  startTails();
  ensureFetched();

  return {
    stop() {
      stopped = true;
      abort.abort();
      unsubscribeOnline();
      clearTimeout(fetchRetry);
      clearTimeout(missingRetry);
      fetchRetry = undefined;
      missingRetry = undefined;
      buffer.clear();
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
