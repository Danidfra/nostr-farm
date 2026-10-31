import type { NostrEvent, NostrFilter, NostrRelayCLOSED, NostrRelayEOSE, NostrRelayEVENT } from '@nostrify/nostrify';
import { matchFilters } from 'nostr-tools/filter';

/**
 * An in-memory stand-in for the Nostrify pool as the inventory code uses it:
 * `nostr.relay(url).query(...)` and `nostr.relay(url).req(...)`.
 *
 * One shared event store plays every relay, which is what a client that
 * deduplicates by id sees anyway. Subscriptions replay the store, emit `EOSE`,
 * then stream anything `publish`ed later. The test can hold queries back to
 * make a fetch return stale results after a live event, end subscriptions to
 * simulate `CLOSED`, or make a relay replay to simulate a reconnect.
 */
type Message = NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED;

interface Subscription {
  relay: string;
  filters: NostrFilter[];
  push(message: Message): void;
  end(): void;
}

export class FakeRelayNetwork {
  readonly store: NostrEvent[] = [];
  /** Every filter set ever queried, in order, with how many subscriptions were open when the query was sent. */
  readonly queries: { relay: string; filters: NostrFilter[]; openSubscriptionsAtCall: number }[] = [];
  /** Every `REQ` ever opened, including ones since closed. */
  readonly subscriptions: Subscription[] = [];
  private readonly open = new Set<Subscription>();
  /** While set, `query` captures its result immediately but resolves only once released. */
  private gate: { promise: Promise<void>; release(): void } | null = null;
  /** When set, `query` rejects with this error. */
  failQueries: Error | null = null;
  /** Relays whose subscriptions end before `EOSE`, as a relay that answers `CLOSED` does. */
  private readonly closingRelays = new Set<string>();
  /** Relays that never send anything: no events, no `EOSE`. Reads of them end only by abort. */
  private readonly silentRelays = new Set<string>();
  /** Relays whose `req` throws at once. */
  private readonly failingRelays = new Map<string, Error>();
  /** Event ids a given relay does not hold, although the shared store does. */
  private readonly withheld = new Map<string, Set<string>>();

  /** Make `relay` close every subscription before `EOSE` (after replaying what it holds). */
  closeBeforeEose(relay: string): void {
    this.closingRelays.add(relay);
  }

  /** Make `relay` never answer; a read of it ends only when its signal aborts. */
  silence(relay: string): void {
    this.silentRelays.add(relay);
  }

  /** Make `relay` throw on `req`. */
  failRelay(relay: string, error: Error = new Error('connection refused')): void {
    this.failingRelays.set(relay, error);
  }

  /** Make `relay` act as though it never received the events with these ids. */
  withhold(relay: string, ...ids: string[]): void {
    const set = this.withheld.get(relay) ?? new Set<string>();
    for (const id of ids) set.add(id);
    this.withheld.set(relay, set);
  }

  /** Restore `relay` to normal behaviour. */
  heal(relay: string): void {
    this.closingRelays.delete(relay);
    this.silentRelays.delete(relay);
    this.failingRelays.delete(relay);
    this.withheld.delete(relay);
  }

  /** The object the code under test receives from `useNostr().nostr`. */
  readonly pool = {
    relay: (url: string) => ({
      query: async (filters: NostrFilter[]) => {
        this.queries.push({ relay: url, filters, openSubscriptionsAtCall: this.open.size });
        if (this.failQueries) throw this.failQueries;
        const result = this.matching(filters);
        if (this.gate) await this.gate.promise;
        return result;
      },
      req: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => this.subscribe(url, filters, opts?.signal),
    }),
  };

  /** Seed the store silently (present before any subscription opens). */
  seed(...events: NostrEvent[]): void {
    for (const event of events) if (!this.store.some((e) => e.id === event.id)) this.store.push(event);
  }

  /** Store an event and stream it to every open subscription it matches. */
  publish(event: NostrEvent): void {
    this.seed(event);
    for (const sub of this.open) {
      if (matchFilters(sub.filters, event)) sub.push(['EVENT', 'sub', event]);
    }
  }

  /** Simulate a relay reconnect: replay the store into open subscriptions on `relay`, then `EOSE` again. */
  reconnect(relay: string): void {
    for (const sub of this.open) {
      if (sub.relay !== relay) continue;
      for (const event of this.matching(sub.filters)) sub.push(['EVENT', 'sub', event]);
      sub.push(['EOSE', 'sub']);
    }
  }

  /** Simulate the relay closing every open subscription (`CLOSED`). */
  closeAll(): void {
    for (const sub of [...this.open]) sub.end();
  }

  get openSubscriptions(): number {
    return this.open.size;
  }

  /** Hold every `query` until `releaseQueries` is called. */
  holdQueries(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { promise, release };
  }

  releaseQueries(): void {
    this.gate?.release();
    this.gate = null;
  }

  private matching(filters: NostrFilter[]): NostrEvent[] {
    return this.store.filter((event) => matchFilters(filters, event));
  }

  private subscribe(relay: string, filters: NostrFilter[], signal?: AbortSignal): AsyncGenerator<Message> {
    const queue: Message[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let aborted = false;

    const sub: Subscription = {
      relay,
      filters,
      push: (message) => {
        queue.push(message);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    this.subscriptions.push(sub);
    this.open.add(sub);

    const failure = this.failingRelays.get(relay);
    if (failure) {
      this.open.delete(sub);
      return (async function* () {
        yield* [] as Message[];
        throw failure;
      })();
    }

    if (!this.silentRelays.has(relay)) {
      const hidden = this.withheld.get(relay);
      for (const event of this.matching(filters)) {
        if (!hidden?.has(event.id)) queue.push(['EVENT', 'sub', event]);
      }
      if (this.closingRelays.has(relay)) ended = true;
      else queue.push(['EOSE', 'sub']);
    }

    const onAbort = () => {
      aborted = true;
      wake?.();
    };
    if (signal?.aborted) aborted = true;
    else signal?.addEventListener('abort', onAbort, { once: true });

    const open = this.open;
    return (async function* () {
      try {
        while (true) {
          if (aborted) throw new DOMException('The signal has been aborted', 'AbortError');
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (ended) {
            yield ['CLOSED', 'sub', 'closed by relay'] as NostrRelayCLOSED;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        open.delete(sub);
        signal?.removeEventListener('abort', onAbort);
      }
    })();
  }
}

/**
 * A `req` over a plain array of events, for tests that fake the pool by hand:
 * replays every event matching the filters, then `EOSE` — or ends without it
 * when `behaviour().eose` is false, the way a relay that answers `CLOSED`
 * looks to a client.
 */
export function reqOverStore(
  store: () => readonly NostrEvent[],
  behaviour: () => { eose: boolean } = () => ({ eose: true })
): (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => AsyncGenerator<Message> {
  return async function* (filters) {
    for (const event of store()) if (matchFilters(filters, event)) yield ['EVENT', 'sub', event];
    if (behaviour().eose) yield ['EOSE', 'sub'];
  };
}
