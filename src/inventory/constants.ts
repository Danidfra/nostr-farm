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
 * `event.pubkey === FARM_OFFICIAL_ISSUER_PUBKEY`. Anything else is an external
 * item — which is not the same as invalid or malicious, and the registry says
 * so.
 *
 * npub: npub173a27t3j08lxlnw7243nd50hgpc9zfkf5dlx8y8zah3pzegen76q8fl9lm
 *
 * FIXED IN SOURCE, DELIBERATELY. There is no environment override and no
 * runtime configuration: "official" is a claim about one specific public
 * identity, and a build-time variable that could make a different key render as
 * official would turn the badge into something an operator can forge. A staging
 * issuer is not worth that.
 *
 * This is a public identifier. No secret key is stored, derived or read
 * anywhere in this application.
 */
export const FARM_OFFICIAL_ISSUER_PUBKEY =
  'f47aaf2e3279fe6fcdde556336d1f740705126c9a37e6390e2ede21165199fb4' as const;

/**
 * Relays the registry reads from and publishes to, in addition to whichever
 * relay the app is configured with. Item definitions have to be findable by
 * other games, so they are not confined to the Farm's own game relay.
 */
export const ITEM_REGISTRY_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
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
