/**
 * The pure farming domain.
 *
 * Hard rule, enforced by `src/farm/purity.test.ts`: nothing under `src/farm`
 * may import React, Nostr, a signer, a relay or a browser API, and no other
 * game's vocabulary leaks in. Time enters through explicit `nowSec` arguments only.
 */
export * from './time';
export * from './crops';
export * from './growth';
export * from './harvest';
export * from './slots';
