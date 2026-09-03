import { onlineManager, type QueryClient } from '@tanstack/react-query';
import type { NPool, NostrEvent } from '@nostrify/nostrify';

import { admitFarmInventoryEvents, farmInventoryQueryKey, farmInventoryQueryOptions, type FarmInventoryView } from './useFarmInventory';
import { INVENTORY_RELAYS, openFarmLedgerTail, readFarmFoldsById } from './inventory-relays';

/**
 * Keeps the cached `farm:main` ledger current while the Farm is open.
 *
 * ```text
 *   subscribe (one REQ per inventory relay, three filters)   ← gate opens
 *       │  events buffered
 *   authoritative fetch  ──►  commit (merge)  ──►  flush buffer  ──►  LIVE
 *                                                                     │
 *   live EVENT ─────────────────────────────────────────► admit → re-derive
 *   reconnect replay (second EOSE) / iterator ended / back online
 *                                          └──► authoritative refetch (merge)
 *   view unresolved for a missing manifest ──► fetch it by id; one capped-
 *                                              backoff timer while it stays missing
 * ```
 *
 * **Subscribe first, then fetch — guaranteed, not scheduled.** The query's
 * `queryFn` waits on a gate (`awaitLiveTails`) that this controller opens only
 * after every relay's `REQ` has been sent. However React orders the observer's
 * mount fetch and the effect that starts the controller, the authoritative
 * read cannot capture relay state before the subscriptions exist. Every event
 * the relay sends from then on is held until that read has committed, then
 * admitted on top of it; there is no instant at which one can be missed.
 * Before the fetch has landed nothing is shown, because a partially replayed
 * ledger — the snapshot without its spends — is not a balance.
 *
 * **Recovery is event-driven and never terminal.** A relay that reconnects
 * re-sends the `REQ` and replays (`NRelay1`); an ended iterator is reopened
 * after a capped exponential backoff for as long as the controller lives; going
 * back online triggers a refetch. Each of those ends in an authoritative fetch
 * merged into the cache. A manifest the chain needs but no relay has served is
 * fetched again by exact id on a single capped-backoff timer that exists only
 * while that manifest is still missing. There is no interval, no periodic poll
 * and no `since` watermark: every read asks for the whole ledger and the merge
 * keeps whatever is newest.
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

/** Delay before the n-th (1-based) consecutive by-id retry of a missing manifest: 2s, 4s, … capped. */
export function missingFoldRetryDelayMs(miss: number): number {
  return Math.min(MAX_MISSING_FOLD_RETRY_MS, 2000 * 2 ** Math.max(0, miss - 1));
}
export const MAX_MISSING_FOLD_RETRY_MS = 5 * 60_000;

/** Delay before the n-th (1-based) consecutive reopen of one relay's subscription: 2s, 4s, … capped. */
export function tailRestartDelayMs(restart: number): number {
  return Math.min(MAX_TAIL_RESTART_MS, 2000 * 2 ** Math.max(0, restart - 1));
}
export const MAX_TAIL_RESTART_MS = 2 * 60_000;
/** A subscription that lived this long before ending resets that relay's restart backoff. */
const STABLE_TAIL_MS = 60_000;

/** Delay before retrying a failed authoritative fetch: 2s, 4s, … capped. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
}
/** Failed authoritative fetches before leaving recovery to the tails (reconnect replay) and `online`. */
export const MAX_FETCH_ATTEMPTS = 6;

/**
 * The gate between "a live controller has its subscriptions open" and "the
 * authoritative read may go to the relays", per query client and player.
 *
 * Created on demand by whichever side asks first, so a `queryFn` that starts
 * before the controller simply waits for it.
 */
interface LiveGate {
  opened: Promise<void>;
  open(): void;
  isOpen: boolean;
  owner: object | null;
}
const gates = new WeakMap<QueryClient, Map<string, LiveGate>>();

function gateFor(queryClient: QueryClient, ownerPubkey: string): LiveGate {
  let byOwner = gates.get(queryClient);
  if (!byOwner) {
    byOwner = new Map();
    gates.set(queryClient, byOwner);
  }
  let gate = byOwner.get(ownerPubkey);
  if (!gate) {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const created: LiveGate = {
      opened,
      isOpen: false,
      owner: null,
      open() {
        created.isOpen = true;
        open();
      },
    };
    gate = created;
    byOwner.set(ownerPubkey, gate);
  }
  return gate;
}

/**
 * Resolves once a live controller for this player has sent its `REQ`s to
 * every inventory relay. Rejects if `signal` aborts first, so an unmounted
 * query does not hang.
 */
export function awaitLiveTails(queryClient: QueryClient, ownerPubkey: string, signal?: AbortSignal): Promise<void> {
  const gate = gateFor(queryClient, ownerPubkey);
  if (gate.isOpen) return Promise.resolve();
  if (!signal) return gate.opened;
  if (signal.aborted) return Promise.reject(new DOMException('The signal has been aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The signal has been aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    gate.opened.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export function startFarmInventoryLive(deps: FarmInventoryLiveDeps): FarmInventoryLive {
  const { nostr, queryClient, ownerPubkey } = deps;
  const relays = deps.relays ?? INVENTORY_RELAYS;
  const key = farmInventoryQueryKey(ownerPubkey);
  const options = farmInventoryQueryOptions(nostr, queryClient, ownerPubkey);
  const readFoldsById = readFarmFoldsById(nostr);

  const abort = new AbortController();
  const self = {};
  let stopped = false;

  // Until the first authoritative fetch has committed, live events wait here.
  let phase: 'buffering' | 'live' = 'buffering';
  const buffer = new Map<string, NostrEvent>();

  let fetching: Promise<void> | null = null;
  let refetchRequested = false;
  let fetchAttempts = 0;
  let fetchRetry: ReturnType<typeof setTimeout> | undefined;

  let missingHead = '';
  let missingMisses = 0;
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

  /**
   * The fetch has committed: replay what the tail held, then admit directly.
   *
   * The phase flips and the buffer drains in one synchronous step, so no event
   * can land between "we stopped buffering" and "we flushed the buffer".
   */
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
   * One round per call. A round that makes progress (a deeper link is now the
   * missing one) continues at once; a round that finds nothing arms ONE timer
   * for the next attempt, at a delay that doubles up to a cap, and the timer
   * exists only as long as that manifest is still missing: a manifest arriving
   * live, the chain resolving, a different missing head, or `stop()` all
   * clear it. A view unresolved for any other reason — a foreign, malformed or
   * cyclic manifest — reports nothing missing, and nothing is fetched.
   */
  function settleMissingFolds(): void {
    if (stopped || phase !== 'live') return;
    const view = queryClient.getQueryData<FarmInventoryView>(key);
    const missing = view?.status === 'unresolved' ? view.missingFolds : [];
    if (missing.length === 0) {
      missingHead = '';
      missingMisses = 0;
      clearMissingRetry();
      return;
    }
    if (resolving) {
      resolveAgain = true;
      return;
    }

    const head = missing.map((reference) => reference.eventId).sort().join(',');
    if (head !== missingHead) {
      // Something new to look for: start its backoff afresh, and do not wait
      // out a deadline that was armed for the previous head.
      missingHead = head;
      missingMisses = 0;
      clearMissingRetry();
    }
    if (missingRetry !== undefined) return;

    resolving = true;
    void readFoldsById(missing)
      .then((fetched) => {
        if (stopped) return;
        if (admitFarmInventoryEvents(queryClient, ownerPubkey, fetched.events)) {
          // Progress: the view changed, so look again at once for whatever the
          // chain needs next (the next `previous` link, typically).
          resolveAgain = true;
        } else {
          armMissingRetry();
        }
      })
      .catch(() => {
        if (!stopped) armMissingRetry();
      })
      .finally(() => {
        resolving = false;
        if (resolveAgain && !stopped) {
          resolveAgain = false;
          settleMissingFolds();
        }
      });
  }

  function armMissingRetry(): void {
    missingMisses += 1;
    clearMissingRetry();
    missingRetry = setTimeout(() => {
      missingRetry = undefined;
      settleMissingFolds();
    }, missingFoldRetryDelayMs(missingMisses));
  }

  function clearMissingRetry(): void {
    clearTimeout(missingRetry);
    missingRetry = undefined;
  }

  /**
   * Tail one relay for as long as we are running.
   *
   * The iterator normally never ends: `NRelay1` keeps the `REQ` across socket
   * reconnects and the relay replays into the same iterator, signalling the end
   * of each replay with an `EOSE`. An `EOSE` after the first one is therefore
   * the sign of a reconnect, and the cue for an authoritative refetch. If the
   * iterator does end — `CLOSED`, or a failure — it is reopened after a capped
   * exponential backoff, for as long as this controller lives; a subscription
   * that held for a while resets the backoff. The refetch that covers whatever
   * was missed is issued only AFTER the new `REQ` is out, for the same reason
   * the bootstrap fetch waits on the gate.
   */
  async function tail(relay: string): Promise<void> {
    tails.set(relay, true);
    let restarts = 0;
    try {
      while (!stopped) {
        const openedAt = Date.now();
        // `next()` runs the generator up to its first await, which is after the
        // `REQ` has been sent (NRelay1) — so once it returns, we are subscribed.
        const iterator = openFarmLedgerTail(nostr, ownerPubkey, relay, abort.signal)[Symbol.asyncIterator]();
        let pending = iterator.next();
        if (restarts > 0) ensureFetched();

        let eoseSeen = false;
        try {
          for (;;) {
            const result = await pending;
            if (result.done) break;
            const message = result.value;
            if (message[0] === 'EVENT') {
              admit(message[2]);
            } else if (message[0] === 'EOSE') {
              if (eoseSeen) ensureFetched();
              eoseSeen = true;
            } else if (message[0] === 'CLOSED') {
              break;
            }
            pending = iterator.next();
          }
        } catch {
          // Aborted by `stop()`, or the relay failed: both fall through.
        } finally {
          void iterator.return?.().catch(() => {});
        }
        if (stopped) return;

        // A subscription that held for a while and then dropped is an ordinary
        // hiccup, not one more failure of a relay that keeps refusing us.
        if (Date.now() - openedAt >= STABLE_TAIL_MS) restarts = 0;
        restarts += 1;
        await sleep(tailRestartDelayMs(restarts), abort.signal);
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

  // Back online: read the ledger afresh (the tails are still open, or waiting
  // out their own backoff).
  const unsubscribeOnline = onlineManager.subscribe((online) => {
    if (!online || stopped) return;
    fetchAttempts = 0;
    startTails();
    ensureFetched();
  });

  // Order matters: every REQ is out before the gate opens, and the gate is
  // open before the bootstrap read is allowed to touch a relay.
  const gate = gateFor(queryClient, ownerPubkey);
  gate.owner = self;
  startTails();
  gate.open();
  ensureFetched();

  return {
    stop() {
      stopped = true;
      abort.abort();
      unsubscribeOnline();
      clearTimeout(fetchRetry);
      clearMissingRetry();
      fetchRetry = undefined;
      buffer.clear();
      // Close the gate again so the next controller for this player (or a
      // fetch started before it) waits for ITS subscriptions, not ours.
      const byOwner = gates.get(queryClient);
      if (byOwner?.get(ownerPubkey)?.owner === self) byOwner.delete(ownerPubkey);
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
