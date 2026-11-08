import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

/**
 * Reads that know whether they finished.
 *
 * `relay.query()` in Nostrify collects events until `EOSE` — but when the
 * relay answers `CLOSED` instead (auth required, rate limited, overloaded),
 * the underlying `req` iterator simply ends and `query()` resolves with
 * whatever had arrived, usually nothing. An empty array therefore means one
 * of two very different things: "the relay has no such event" or "the relay
 * never finished telling us". Anything that would act on absence — above all
 * creating a farm, which REPLACES the player's world event — must be able to
 * tell those apart. These helpers return the outcome alongside the events.
 */

/** How one relay's read ended. Only `complete` means the relay said `EOSE`. */
export type RelayReadOutcome =
  /** The relay sent `EOSE`: everything it holds for the filter was delivered. */
  | 'complete'
  /** The subscription ended before `EOSE` (`CLOSED`, or the stream just stopped). */
  | 'closed'
  /** The read was aborted, normally by its timeout. */
  | 'timeout'
  /** The relay threw: connection refused, protocol error, anything else. */
  | 'error';

export interface RelayRead {
  relay: string;
  outcome: RelayReadOutcome;
  /** Whatever arrived before the read ended, even when it did not complete. */
  events: NostrEvent[];
  /** A short description of the failure, for diagnostics. */
  error?: string;
}

/** A relay as this module needs it: just `req`. Nostrify's `NRelay` satisfies it. */
export interface ReqRelay {
  req(filters: NostrFilter[], opts?: { signal?: AbortSignal }): AsyncIterable<readonly [string, ...unknown[]]>;
}

/** A pool as this module needs it: a relay per URL. Nostrify's `NPool` satisfies it. */
export interface RelayPool {
  relay(url: string): ReqRelay;
}

/**
 * Read one relay until it says `EOSE`, reporting how the read ended.
 *
 * Never throws for relay or signal reasons: the outcome carries them. A
 * `CLOSED` message, should the client surface one, and a stream that ends
 * without `EOSE` are the same thing here — the relay did not finish.
 */
export async function readUntilEose(relay: ReqRelay, url: string, filters: NostrFilter[], signal?: AbortSignal): Promise<RelayRead> {
  const events: NostrEvent[] = [];
  try {
    for await (const msg of relay.req(filters, { signal })) {
      if (msg[0] === 'EOSE') return { relay: url, outcome: 'complete', events };
      if (msg[0] === 'CLOSED') return { relay: url, outcome: 'closed', events, error: describe(msg[2]) };
      if (msg[0] === 'EVENT') events.push(msg[2] as NostrEvent);
    }
    return { relay: url, outcome: 'closed', events, error: 'subscription ended before EOSE' };
  } catch (error) {
    if (isAbort(error) || signal?.aborted) return { relay: url, outcome: 'timeout', events, error: describe(error) };
    return { relay: url, outcome: 'error', events, error: describe(error) };
  }
}

export interface MultiRelayRead {
  /** Events from every relay, deduplicated by id, whatever each read's outcome. */
  events: NostrEvent[];
  reads: RelayRead[];
  /** Every relay reached `EOSE`. Only then may an empty result be believed. */
  allComplete: boolean;
  /** At least one relay reached `EOSE`. */
  anyComplete: boolean;
}

export interface ReadFromRelaysOptions {
  /** Per-relay abort, combined with the per-relay timeout. */
  signal?: AbortSignal;
  /** Each relay gets this long to reach `EOSE`. */
  timeoutMs: number;
  /**
   * Do not hold an answer back for a slow relay: once the `anchors` have
   * settled and something was found, the relays still silent get only this
   * much longer, then are cut off as `timeout`. Unset, every relay gets its
   * full `timeoutMs`.
   *
   * An EMPTY answer is never cut short this way unless `graceOnEmpty` says
   * so: "nothing there" is believable only when every relay said it, so that
   * claim waits for every relay.
   */
  graceMs?: number;
  /** The relays that must have settled before the grace period starts. Default: any one relay that reached `EOSE`. */
  anchors?: readonly string[];
  /** Start the grace period even when nothing was found. Only for reads where an empty result decides nothing. */
  graceOnEmpty?: boolean;
}

/**
 * Read the same filters from several relays in parallel and merge the result.
 *
 * Each relay is timed independently so one slow relay cannot hide a fast
 * one's answer, and each outcome is kept so the caller can tell a confirmed
 * empty result from an unfinished one.
 */
export async function readFromRelays(
  nostr: RelayPool,
  relays: readonly string[],
  filters: NostrFilter[],
  options: ReadFromRelaysOptions
): Promise<MultiRelayRead> {
  const settled = new Map<string, RelayRead>();
  const cutters: AbortController[] = [];
  let grace: ReturnType<typeof setTimeout> | undefined;

  const maybeStartGrace = () => {
    if (options.graceMs === undefined || grace !== undefined || settled.size === relays.length) return;
    const completed = [...settled.values()].filter((read) => read.outcome === 'complete');
    const anchored = options.anchors ? options.anchors.every((url) => settled.has(url)) : completed.length > 0;
    if (!anchored) return;
    if (!options.graceOnEmpty && !completed.some((read) => read.events.length > 0)) return;
    grace = setTimeout(() => {
      for (const cutter of cutters) cutter.abort(new DOMException('The relay did not answer in time', 'AbortError'));
    }, options.graceMs);
  };

  const reads = await Promise.all(
    relays.map(async (url) => {
      const cutter = new AbortController();
      cutters.push(cutter);
      const signals = [AbortSignal.timeout(options.timeoutMs), cutter.signal];
      if (options.signal) signals.push(options.signal);
      const read = await readUntilEose(nostr.relay(url), url, filters, AbortSignal.any(signals));
      settled.set(url, read);
      maybeStartGrace();
      return read;
    })
  );
  clearTimeout(grace);

  const seen = new Set<string>();
  const events: NostrEvent[] = [];
  for (const read of reads) {
    for (const event of read.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }

  const complete = reads.filter((read) => read.outcome === 'complete').length;
  return { events, reads, allComplete: reads.length > 0 && complete === reads.length, anyComplete: complete > 0 };
}

/** Whether at least one of `relays` reached `EOSE` in this read. */
export function anyCompleteAmong(read: MultiRelayRead, relays: readonly string[]): boolean {
  return read.reads.some((entry) => entry.outcome === 'complete' && relays.includes(entry.relay));
}

/** Whether every one of `relays` reached `EOSE` in this read. */
export function allCompleteAmong(read: MultiRelayRead, relays: readonly string[]): boolean {
  return relays.length > 0 && relays.every((url) => read.reads.some((entry) => entry.relay === url && entry.outcome === 'complete'));
}

/** One line per relay, for an error disclosure: `wss://relay.example: closed (auth-required)`. */
export function describeReads(reads: readonly RelayRead[]): string {
  return reads.map((read) => `${read.relay}: ${read.outcome}${read.error ? ` (${read.error})` : ''}`).join('; ');
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return value === undefined ? '' : String(value);
}
