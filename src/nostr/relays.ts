import { withPrimaryRelay } from '@/lib/relay-routing';

/**
 * Relay roles.
 * - `game`: carries world/map/slot state
 * - `backup`: redundancy for the same data
 */
export type RelayRole = 'game' | 'backup';

export interface RelayConfig {
  url: string;
  role: RelayRole;
  /** Game state MUST land here for a publish to count as successful. */
  required?: boolean;
  /**
   * The ecosystem's own relay: asked first, offered every event first, and
   * the destination of the sync that follows a read. NOT `required` while its
   * write list is a pilot allowlist: most players are refused there, and a
   * refusal must not fail the action.
   */
  primary?: boolean;
}

/**
 * The primary relay, as the shared routing module names it. Taken from that
 * module rather than spelled here so that there is one place that knows it.
 */
export const PRIMARY_RELAY_URL = withPrimaryRelay([])[0];

/**
 * Where world, map and slot state lives. The primary relay first, then the
 * relay the game has always written to.
 *
 * Order carries NO authority. Every read asks all of them and merges; no read
 * believes one relay alone, least of all the first (see `src/nostr/query.ts`).
 */
export const GAME_RELAYS: readonly RelayConfig[] = Object.freeze([
  Object.freeze({ url: PRIMARY_RELAY_URL, role: 'game' as const, primary: true }),
  Object.freeze({ url: 'wss://relay.primal.net', role: 'game' as const, required: true }),
]);

/** Every game relay, primary first. */
export const GAME_RELAY_URLS: readonly string[] = Object.freeze(GAME_RELAYS.map((relay) => relay.url));

/**
 * The relays a successful game write is guaranteed to be on.
 *
 * A publish succeeds only when one of these accepted it, so the newest state
 * of any plot is on one of them. A read none of them finished can be
 * arbitrarily old, however many other relays answered.
 */
export const REQUIRED_GAME_RELAY_URLS: readonly string[] = Object.freeze(
  GAME_RELAYS.filter((relay) => relay.required).map((relay) => relay.url)
);

/**
 * The relay written into references the Farm creates. A required relay, not
 * the primary: a hint must point somewhere the event certainly is.
 */
export const DEFAULT_GAME_RELAY = REQUIRED_GAME_RELAY_URLS[0];

/**
 * Where profiles (kind 0) are read through the pool's default routing. Left
 * exactly as it was: the game relays the app had before the primary relay
 * existed. Profiles are not game state and do not follow its routing.
 */
export const PROFILE_RELAY_URLS: readonly string[] = Object.freeze(
  GAME_RELAYS.filter((relay) => !relay.primary).map((relay) => relay.url)
);
