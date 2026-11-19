/**
 * `created_at` for replaceable and addressable writes.
 *
 * Relays keep ONE event per replaceable address: the newest `created_at`, and
 * on a tie the lower id (NIP-01). A write stamped in the same second as the
 * event it replaces is therefore a coin toss: a plant followed by a water in
 * the same second can keep the plant and drop the watering.
 *
 * So a replacement is stamped one second after its predecessor when that is
 * later than the clock, BOUNDED: never more than {@link MAX_FUTURE_SKEW_SEC}
 * ahead of the device's clock. Every stamp lies in `[now, now + skew]`, so
 * however many writes happen in one second the clock cannot run away, and the
 * event stays well inside what relays accept as "not from the future".
 *
 * A predecessor further ahead than the bound (a device with a fast clock
 * wrote it) is NOT chased: the write is stamped `now`, and that far-future
 * event keeps winning on the relays until its time has passed. Chasing it
 * would carry the skew into every later write and eventually past the relays'
 * limit, where writes are refused outright. The case is reported in
 * {@link StampResult.previousAhead} so callers can surface it.
 */

/**
 * How far ahead of the device's clock a stamp may go.
 *
 * Relays reject events too far in the future: strfry's default
 * (`rejectEventsNewerThanSeconds`) and the ecosystem's primary relay (its
 * write policy's default future window) accept up to 900 s, and that relay's
 * tightest per-kind window is 300 s.
 * 60 s leaves room for a device clock that is itself a few minutes fast while
 * still giving 60 strictly increasing stamps inside any one second, far more
 * than the per-plot action guard lets a player produce.
 */
export const MAX_FUTURE_SKEW_SEC = 60;

export interface StampResult {
  createdAt: number;
  /** The predecessor is further ahead than the bound, so it was not chased and still wins. */
  previousAhead: boolean;
}

/**
 * `max(now, previous + 1)`, unless that would land more than `maxFutureSkewSec`
 * ahead of `nowSec`; then `nowSec`.
 */
export function stampAfter(
  previousCreatedAt: number | undefined,
  nowSec: number,
  maxFutureSkewSec: number = MAX_FUTURE_SKEW_SEC
): StampResult {
  if (previousCreatedAt === undefined || !Number.isSafeInteger(previousCreatedAt)) {
    return { createdAt: nowSec, previousAhead: false };
  }
  const next = previousCreatedAt + 1;
  if (next <= nowSec) return { createdAt: nowSec, previousAhead: false };
  if (next <= nowSec + maxFutureSkewSec) return { createdAt: next, previousAhead: false };
  return { createdAt: nowSec, previousAhead: true };
}

/** NIP-01 replaceable (0, 3, 10000–19999) or addressable (30000–39999). */
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}

/** The address a relay replaces this event at, or `undefined` for a regular event. */
export function replaceableAddress(kind: number, pubkey: string, tags: readonly string[][]): string | undefined {
  if (!isReplaceableKind(kind)) return undefined;
  if (kind < 30000) return `${kind}:${pubkey}`;
  const d = tags.find(([name]) => name === 'd')?.[1] ?? '';
  return `${kind}:${pubkey}:${d}`;
}

/**
 * The newest `created_at` this session stamped per address.
 *
 * A write that follows another before the relays have been read again (a
 * water right after a plant, from the optimistic cache) has no predecessor to
 * hand in; this remembers it. The stamp is reserved when it is computed, not
 * after the publish, so two writes started together still get distinct ones.
 */
const sessionStamps = new Map<string, number>();

/**
 * Stamp a write to `address`, after both `hintCreatedAt` (what the caller last
 * read from the relays) and anything this session already stamped there.
 */
export function stampReplaceable(address: string, hintCreatedAt: number | undefined, nowSec: number): StampResult {
  const remembered = sessionStamps.get(address);
  const previous =
    hintCreatedAt === undefined ? remembered : remembered === undefined ? hintCreatedAt : Math.max(hintCreatedAt, remembered);
  const result = stampAfter(previous, nowSec);
  if (remembered === undefined || result.createdAt > remembered) sessionStamps.set(address, result.createdAt);
  return result;
}

/** Test seam: forget every stamp this session reserved. */
export function forgetSessionStamps(): void {
  sessionStamps.clear();
}
