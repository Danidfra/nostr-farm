/**
 * Serialization for read-modify-write publishes.
 *
 * kind:31633 is a REPLACEABLE event: a publish does not patch the inventory, it
 * replaces the whole thing. Two writers that build from the same base silently
 * destroy each other's work — whichever lands last wins, entirely. So every
 * write has to be serialized against every other write of the same context.
 *
 * Two layers, because they solve different problems:
 *
 * - {@link serializeWrite} chains writes inside ONE tab. React state is not a
 *   mutex: two handlers in the same tick both see `isPending === false`.
 * - {@link withCrossTabLock} extends that across same-origin tabs using the Web
 *   Locks API.
 *
 * The lock QUEUES rather than refusing. Two different harvests are both
 * legitimate and must both run — just not interleaved. Preventing a *repeat* of
 * the same harvest is the idempotency marker's job, not the lock's.
 */

/** Per-tab write chains, one promise per key. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier call for the same key has settled.
 *
 * A rejection never breaks the chain for later callers: the chain tracks
 * settlement, and the caller still receives its own rejection.
 */
export function serializeWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  chains.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

type WebLockManager = {
  request: (
    name: string,
    options: { mode?: 'exclusive' | 'shared' },
    callback: () => Promise<unknown>
  ) => Promise<unknown>;
};

function webLocks(): WebLockManager | null {
  const nav = globalThis.navigator as (Navigator & { locks?: WebLockManager }) | undefined;
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}

/** Whether cross-tab mutual exclusion is actually available in this browser. */
export function hasCrossTabLocks(): boolean {
  return webLocks() !== null;
}

/**
 * Run `fn` holding a queued exclusive cross-tab lock, where the platform
 * provides one.
 *
 * WITHOUT the Web Locks API there is NO cross-tab protection and this simply
 * runs the function. That limitation is stated rather than papered over: a
 * localStorage lease cannot queue without polling, and a polling lease is worse
 * than an honest fallback. Per-tab serialization still applies, and the
 * idempotency marker still prevents a duplicate credit even if two tabs
 * interleave.
 */
export async function withCrossTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (!locks) return fn();

  let result!: T;
  await locks.request(name, { mode: 'exclusive' }, async () => {
    result = await fn();
  });
  return result;
}

/** Both layers: cross-tab where available, always per-tab. */
export function withSerializedWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return serializeWrite(key, () => withCrossTabLock(key, fn));
}
