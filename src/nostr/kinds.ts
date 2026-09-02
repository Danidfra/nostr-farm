/**
 * Nostr event kinds used by Nostr Worlds.
 *
 * All three are addressable (NIP-01 range 30000-39999), which is what makes the
 * "latest state per (pubkey, kind, d)" model work without any tombstoning.
 */
export const KIND_WORLD_STATE = 31415;
export const KIND_MAP_STATE = 31416;
export const KIND_SLOT_STATE = 31417;

/**
 * Schema version carried in the `v` tag of every event this app writes.
 *
 * v2 is a clean break from the v1 experiment. v1 state is intentionally not
 * migrated: it encoded derived values (`stage`, `ready_at`, `expires_at`),
 * a deprecated `watered_at`/`water_count` pair, and relied on kind 14159 —
 * a "many immutable actions" kind allocated inside NIP-01's *replaceable*
 * range, which meant relays were entitled to drop all but the newest. Kind
 * 14159 is dead and is not read or written anywhere in this codebase.
 */
export const SCHEMA_VERSION = '2';

/**
 * Reserved, NOT implemented: a future regular-event kind for visitor action
 * intent (e.g. a neighbour watering your crops). The candidate number is 1415.
 * Nothing in this repository publishes or consumes it yet; it is recorded here
 * so the number is not reused by accident. See `docs/future-visitor-actions.md`.
 */
export const RESERVED_VISITOR_ACTION_KIND_CANDIDATE = 1415;
