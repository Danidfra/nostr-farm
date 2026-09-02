/**
 * Time primitives for the pure farm domain.
 *
 * The domain never reads the clock itself: every function that depends on time
 * takes an explicit `nowSec`. Application code supplies it (see `Clock`), which
 * makes growth deterministic, testable and replayable.
 */

/** A unix timestamp in whole seconds. */
export type UnixSeconds = number;

/** Injectable source of time for the application layer. */
export interface Clock {
  now(): UnixSeconds;
}

/** Real wall-clock time. Never used inside `src/farm` itself. */
export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
};

/** A clock whose value is set explicitly. Used by tests and the dev test lab. */
export function fixedClock(startSec: UnixSeconds): Clock & { set(sec: UnixSeconds): void; advance(sec: number): void } {
  let current = toWholeSeconds(startSec, 0);
  return {
    now: () => current,
    set: (sec: UnixSeconds) => {
      current = toWholeSeconds(sec, current);
    },
    advance: (sec: number) => {
      current += Number.isFinite(sec) ? Math.trunc(sec) : 0;
    },
  };
}

/**
 * Coerce an untrusted numeric timestamp into whole seconds.
 * Non-finite values fall back to `fallback`.
 */
export function toWholeSeconds(value: unknown, fallback: UnixSeconds): UnixSeconds {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/** Coerce an untrusted duration into a whole number of seconds >= 0. */
export function toDurationSec(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}
