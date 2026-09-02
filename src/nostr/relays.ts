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
}

export const GAME_RELAYS: readonly RelayConfig[] = Object.freeze([
  Object.freeze({ url: 'wss://relay.primal.net', role: 'game' as const, required: true }),
]);

export const DEFAULT_GAME_RELAY = GAME_RELAYS[0].url;
