import type { NostrEvent } from '@nostrify/nostrify';
import type { WorldState, MapState, SlotState, SlotAction } from './types';

/**
 * Get a tag value by name
 */
function getTag(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find(([name]) => name === tagName)?.[1];
}



/**
 * Parse a WorldState event (kind 31415)
 */
export function parseWorldState(event: NostrEvent): WorldState | null {
  if (event.kind !== 31415) return null;

  // Required tags
  const d = getTag(event, 'd');
  const v = getTag(event, 'v');
  const type = getTag(event, 'type');
  const name = getTag(event, 'name');
  const renderpackUrl = getTag(event, 'renderpack_url');
  const entryMap = getTag(event, 'entry_map');

  // Validate required tags
  if (!d || !v || !type || !name || !renderpackUrl || !entryMap) {
    return null;
  }

  // Optional tags
  const season = getTag(event, 'season');

  return {
    event,
    id: d,
    version: v,
    type,
    name,
    renderpackUrl,
    entryMap,
    season,
  };
}

/**
 * Parse a MapState event (kind 31416)
 */
export function parseMapState(event: NostrEvent): MapState | null {
  if (event.kind !== 31416) return null;

  // Required tags
  const d = getTag(event, 'd');
  const v = getTag(event, 'v');
  const worldId = getTag(event, 'world');
  const layout = getTag(event, 'layout');
  const renderpackUrl = getTag(event, 'renderpack_url');

  // Validate required tags
  if (!d || !v || !worldId || !layout || !renderpackUrl) {
    return null;
  }

  // Optional tags
  const name = getTag(event, 'name');
  const description = getTag(event, 'desc');

  return {
    event,
    id: d,
    version: v,
    worldId,
    layout,
    renderpackUrl,
    name,
    description,
  };
}

/**
 * Parse a SlotState event (kind 31417)
 * 
 * Parses an addressable event representing the state of a grid slot.
 * Supports both plant slots and empty slots.
 */
export function parseSlotState(event: NostrEvent): SlotState | null {
  if (event.kind !== 31417) return null;

  // Required tags
  const d = getTag(event, 'd');
  const v = getTag(event, 'v');
  const worldId = getTag(event, 'world');
  const mapId = getTag(event, 'map');
  const type = getTag(event, 'type');
  
  // Parse slot tag - supports both formats:
  // Format 1: ["slot", "3", "2"] - separate x,y values
  // Format 2: ["slot", "3:2"] - colon-separated string
  const slotTag = event.tags.find(([name]) => name === 'slot');
  if (!slotTag) return null;

  let slotX: string | undefined;
  let slotY: string | undefined;

  if (slotTag[2] !== undefined) {
    // Format 1: ["slot", "3", "2"]
    slotX = slotTag[1];
    slotY = slotTag[2];
  } else if (slotTag[1] && slotTag[1].includes(':')) {
    // Format 2: ["slot", "3:2"]
    const parts = slotTag[1].split(':');
    if (parts.length === 2) {
      slotX = parts[0];
      slotY = parts[1];
    }
  }

  // Validate required base tags
  if (!d || !v || !worldId || !mapId || !slotX || !slotY) {
    return null;
  }

  // Enforce canonical slot: format - reject non-canonical events
  if (!d.startsWith('slot:')) {
    return null;
  }

  // Parse and validate slot coordinates
  const x = parseInt(slotX, 10);
  const y = parseInt(slotY, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  // Base slot state
  const baseState = {
    event,
    id: d, // Use d exactly as provided
    version: v,
    worldId,
    mapId,
    slot: { x, y },
    type: type || 'plant', // Default to 'plant' for backward compatibility
  };

  // Handle empty slots
  if (type === 'empty') {
    const status = getTag(event, 'status');
    const lastHarvestedAtStr = getTag(event, 'last_harvested_at');
    
    return {
      ...baseState,
      status: status as 'empty' | undefined,
      lastHarvestedAt: lastHarvestedAtStr ? parseInt(lastHarvestedAtStr, 10) : undefined,
    };
  }

  // Handle plant slots (including legacy events without type tag)
  const crop = getTag(event, 'crop');
  const stageStr = getTag(event, 'stage');
  const stageStartedAtStr = getTag(event, 'stage_started_at');
  const plantedAtStr = getTag(event, 'planted_at');
  const wateredAtStr = getTag(event, 'watered_at');
  const wetUntilStr = getTag(event, 'wet_until');
  const waterCountStr = getTag(event, 'water_count');
  const readyAtStr = getTag(event, 'ready_at');
  const expiresAtStr = getTag(event, 'expires_at');
  const status = getTag(event, 'status');
  const harvestCountStr = getTag(event, 'harvest_count');
  const harvestMaxStr = getTag(event, 'harvest_max');
  const regrowAtStr = getTag(event, 'regrow_at');

  // For plant slots, crop is required
  if (!crop) {
    return null;
  }

  // Parse stage (optional - defaults to 0 if missing)
  const stage = stageStr ? parseInt(stageStr, 10) : 0;
  if (!Number.isFinite(stage)) return null;

  // Parse planted_at with fallback to event.created_at
  const plantedAt = plantedAtStr
    ? parseInt(plantedAtStr, 10)
    : event.created_at;

  // Parse stage_started_at with fallback to plantedAt or event.created_at
  const stageStartedAt = stageStartedAtStr
    ? parseInt(stageStartedAtStr, 10)
    : plantedAt;

  return {
    ...baseState,
    crop,
    stage,
    stageStartedAt,
    plantedAt,
    wateredAt: wateredAtStr ? parseInt(wateredAtStr, 10) : undefined,
    wetUntil: wetUntilStr ? parseInt(wetUntilStr, 10) : undefined,
    waterCount: waterCountStr ? parseInt(waterCountStr, 10) : undefined,
    readyAt: readyAtStr ? parseInt(readyAtStr, 10) : undefined,
    expiresAt: expiresAtStr ? parseInt(expiresAtStr, 10) : undefined,
    status: status as 'healthy' | 'rotten' | undefined,
    harvestCount: harvestCountStr ? parseInt(harvestCountStr, 10) : undefined,
    harvestMax: harvestMaxStr ? parseInt(harvestMaxStr, 10) : undefined,
    regrowAt: regrowAtStr ? parseInt(regrowAtStr, 10) : undefined,
  };
}

/**
 * Validate WorldState events
 */
export function validateWorldState(event: NostrEvent): boolean {
  return parseWorldState(event) !== null;
}

/**
 * Validate MapState events
 */
export function validateMapState(event: NostrEvent): boolean {
  return parseMapState(event) !== null;
}

/**
 * Validate SlotState events
 */
export function validateSlotState(event: NostrEvent): boolean {
  return parseSlotState(event) !== null;
}

/**
 * Parse a SlotAction event (kind 14159)
 * 
 * Parses an immutable action event representing player intent.
 */
export function parseSlotAction(event: NostrEvent): SlotAction | null {
  if (event.kind !== 14159) return null;

  // Required tags
  const v = getTag(event, 'v');
  const worldId = getTag(event, 'world');
  const mapId = getTag(event, 'map');
  const slotD = getTag(event, 'slot_d');
  const action = getTag(event, 'action');
  const expectedRevStr = getTag(event, 'expected_rev');
  const clientNonce = getTag(event, 'client_nonce');

  // Parse slot tag
  const slotTag = event.tags.find(([name]) => name === 'slot');
  if (!slotTag) return null;

  const slotX = slotTag[1];
  const slotY = slotTag[2];

  // Validate required tags
  if (!v || !worldId || !mapId || !slotX || !slotY || !slotD || !action || !expectedRevStr || !clientNonce) {
    return null;
  }

  // Parse coordinates
  const x = parseInt(slotX, 10);
  const y = parseInt(slotY, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  // Parse expected revision
  const expectedRev = parseInt(expectedRevStr, 10);
  if (!Number.isFinite(expectedRev)) {
    return null;
  }

  // Optional crop tag (required for plant action)
  const crop = getTag(event, 'crop');

  return {
    event,
    version: v,
    worldId,
    mapId,
    slot: { x, y },
    slotD,
    action,
    expectedRev,
    clientNonce,
    crop,
  };
}

/**
 * Validate SlotAction events
 */
export function validateSlotAction(event: NostrEvent): boolean {
  return parseSlotAction(event) !== null;
}

/**
 * Get slot revision number for concurrency control
 * 
 * Revision rules (for concurrency control):
 * - For plant slots: Use latest of (wetUntil, wateredAt, plantedAt, created_at)
 * - For other slots: Use event.created_at
 * 
 * CRITICAL: wetUntil is the authoritative watering state in the new model.
 * Any change to wet_until MUST change the revision to prevent stale-action replays.
 * wateredAt is kept for backward compatibility with legacy events.
 * 
 * This ensures any state change (plant, water, harvest, clear) updates the revision.
 */
export function getSlotRevision(slotState: SlotState): number {
  if (slotState.type === 'plant') {
    // Use the most recent timestamp as revision
    // PRIORITY: wetUntil > wateredAt (for backward compatibility)
    const timestamps = [
      slotState.wetUntil,      // NEW: Authoritative watering state
      slotState.wateredAt,     // LEGACY: Kept for compatibility
      slotState.plantedAt,
      slotState.event.created_at,
    ].filter((t): t is number => t !== undefined);
    
    return Math.max(...timestamps);
  }
  return slotState.event.created_at;
}
