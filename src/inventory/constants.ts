/**
 * Farm-specific facts about item definitions.
 *
 * Nothing here re-implements the protocol — that is `./package.ts`. This file
 * holds only what is true of *this game*: who issues official Farm items, where
 * they are published, and the vocabulary Farm items are authored with.
 */

/**
 * The canonical Farm item issuer.
 *
 * An item is an official Farm item when, and only when,
 * `event.pubkey === FARM_ISSUER_PUBKEY`. Anything else is an external item —
 * which is not the same as invalid or malicious, and the registry says so.
 *
 * npub: npub173a27t3j08lxlnw7243nd50hgpc9zfkf5dlx8y8zah3pzegen76q8fl9lm
 *
 * This is a public identifier. No secret key is stored, derived or read
 * anywhere in this application.
 */
const DEFAULT_FARM_ISSUER_PUBKEY =
  'f47aaf2e3279fe6fcdde556336d1f740705126c9a37e6390e2ede21165199fb4';

/**
 * Overridable per build so a staging deployment can point at a test issuer
 * without editing source. Falsy or malformed values fall back to the canonical
 * issuer rather than silently disabling the official/external distinction.
 */
function resolveIssuer(): string {
  const override = import.meta.env?.VITE_FARM_ISSUER_PUBKEY;
  if (typeof override === 'string' && /^[0-9a-f]{64}$/.test(override.trim())) {
    return override.trim();
  }
  return DEFAULT_FARM_ISSUER_PUBKEY;
}

export const FARM_ISSUER_PUBKEY: string = resolveIssuer();

/**
 * Relays the registry reads from and publishes to, in addition to whichever
 * relay the app is configured with. Item definitions have to be findable by
 * other games, so they are not confined to the Farm's own game relay.
 */
export const ITEM_REGISTRY_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://relay.damus.io',
]);

/** The `d` namespace official Farm items use: `farm:<category>:<slug>`. */
export const FARM_ITEM_D_NAMESPACE = 'farm';

/** The context tag identifying this game. */
export const FARM_GAME_CONTEXT = 'game:farm';

/**
 * The context tag that marks an item as deliberately reusable by other games.
 *
 * Farm produce is meant to be edible somewhere else. What "edible" *does* is
 * for the consuming game to decide — the Farm publishes generic semantics and
 * never another game's effect values.
 */
export const CROSS_GAME_CONTEXT = 'cross-game';
