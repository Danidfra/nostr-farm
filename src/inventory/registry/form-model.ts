import { GAME_ITEM_IMAGE_MARKERS } from '@/inventory/package';
import { CROSS_GAME_CONTEXT, FARM_GAME_CONTEXT } from '@/inventory/constants';

/**
 * The Item Studio's FORM MODEL — the shape a human edits, as opposed to the
 * shape a relay stores.
 *
 * Plain serializable data: no React, no Nostr. The same object is what the
 * editor mutates and what `form-event.ts` turns into an unsigned kind:31632
 * event, which is what lets the conversion be tested as pure functions.
 *
 * A separate model is needed because a kind:31632 event is a tag list —
 * repeated `image`, `context` and `t` tags plus a JSON `content` blob — while a
 * form needs stable row identities for React keys, needs to remember an empty
 * row that serializes to nothing, and needs to remember the tags and content
 * keys it does NOT understand so re-publishing cannot silently delete them.
 */

// --- Row identity ----------------------------------------------------------

let rowCounter = 0;

/**
 * A process-unique id for a repeatable row. Never serialized into an event, so
 * a counter is enough — and unlike a random id it is deterministic in tests.
 */
export function nextRowId(prefix = 'row'): string {
  rowCounter += 1;
  return `${prefix}-${rowCounter}`;
}

/**
 * Advance the counter past ids that already exist, so rows restored from a
 * loaded item cannot collide with freshly minted ones. Only a parseable
 * numeric suffix counts; ids from another scheme are ignored rather than
 * guessed at.
 */
export function reserveRowIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const suffix = Number.parseInt(id.slice(id.lastIndexOf('-') + 1), 10);
    if (Number.isFinite(suffix) && suffix > rowCounter) rowCounter = suffix;
  }
}

// --- Rows ------------------------------------------------------------------

/**
 * The marker value meaning "this is the primary/default image".
 *
 * The wire format for a primary image is `["image", "<url>"]` with NO third
 * element, so the form models it as the *absence* of a marker rather than as a
 * marker named `primary`. `form-event.ts` asserts the literal string `primary`
 * never reaches a tag.
 */
export const PRIMARY_MARKER = '';

/** One `image` tag being edited. */
export interface ImageRow {
  id: string;
  url: string;
  /** `''` for the primary image; otherwise the raw marker written to the tag. */
  marker: string;
}

export type MetadataValueType = 'string' | 'number' | 'boolean' | 'json';

/** One entry inside `content.metadata`. */
export interface MetadataRow {
  id: string;
  key: string;
  value: string;
  valueType: MetadataValueType;
}

/** One entry inside `content.effects[<context>]`. */
export interface EffectRow {
  id: string;
  /** The effect context key, e.g. `game:farm`. */
  context: string;
  key: string;
  value: string;
  valueType: 'number' | 'string' | 'boolean';
}

/** One `a` tag carrying the `based_on` marker. */
export interface DerivationRow {
  id: string;
  address: string;
  relay: string;
}

export type ContentMode = 'structured' | 'json';

/**
 * The `content` field being edited.
 *
 * `mode` decides which half is authoritative: in `structured` mode the typed
 * fields build the JSON; in `json` mode `raw` IS the content. `extra` holds
 * top-level content keys the structured editor does not model, so a definition
 * published by a newer client survives an edit here unchanged.
 */
export interface ContentFormState {
  mode: ContentMode;
  description: string;
  effects: EffectRow[];
  metadata: MetadataRow[];
  /** Free-form `content.visual` JSON text; `''` when unset. */
  visual: string;
  /** Raw JSON text. Authoritative in `json` mode. */
  raw: string;
  /** Unmanaged top-level content keys, preserved verbatim. */
  extra: Record<string, unknown>;
  /**
   * The loaded content was not a JSON object (a bare string, an array, or
   * invalid JSON). Structured mode cannot represent it, so the editor stays in
   * JSON mode and preserves the text exactly.
   */
  rawOnly: boolean;
}

/** What is known about the published event a form was loaded from. */
export interface LoadedItemMeta {
  eventId: string;
  /** The author of the loaded event — NOT necessarily the current signer. */
  pubkey: string;
  createdAt: number;
  address: string;
  /**
   * The `d` the definition was published under. Held separately from the
   * editable field so an in-place edit can be pinned to it.
   */
  d: string;
  relays: string[];
}

/**
 * The complete item form.
 *
 * `extraTags` is the unknown-tag preservation store: every tag on a loaded
 * event that no form field manages, kept in order and re-emitted on publish.
 */
export interface ItemFormState {
  d: string;
  name: string;
  type: string;
  category: string;
  symbol: string;
  rarity: string;
  /** Numeric text; serialized as a string tag per the spec. */
  maxStack: string;
  version: string;
  /** Blank means "generate the recommended alt from the name". */
  alt: string;
  images: ImageRow[];
  contexts: string[];
  topics: string[];
  model3d: string;
  audio: string;
  basedOn: DerivationRow[];
  content: ContentFormState;
  /** Tags no form field manages, preserved verbatim across an edit. */
  extraTags: string[][];
  /** Provenance of the loaded event, or `null` for a fresh draft. */
  loaded: LoadedItemMeta | null;
}

export function blankContent(): ContentFormState {
  return { mode: 'structured', description: '', effects: [], metadata: [], visual: '', raw: '', extra: {}, rawOnly: false };
}

export function blankItemForm(): ItemFormState {
  return {
    d: '',
    name: '',
    type: '',
    category: '',
    symbol: '',
    rarity: '',
    maxStack: '',
    version: '',
    alt: '',
    images: [],
    contexts: [FARM_GAME_CONTEXT],
    topics: [],
    model3d: '',
    audio: '',
    basedOn: [],
    content: blankContent(),
    extraTags: [],
    loaded: null,
  };
}

export function blankImageRow(marker = PRIMARY_MARKER): ImageRow {
  return { id: nextRowId('image'), url: '', marker };
}

export function blankDerivationRow(): DerivationRow {
  return { id: nextRowId('based-on'), address: '', relay: '' };
}

export function blankMetadataRow(): MetadataRow {
  return { id: nextRowId('meta'), key: '', value: '', valueType: 'string' };
}

export function blankEffectRow(): EffectRow {
  return { id: nextRowId('effect'), context: FARM_GAME_CONTEXT, key: '', value: '', valueType: 'number' };
}

// --- Authoring vocabulary --------------------------------------------------
//
// Every list below is a SUGGESTION, never an enum. `type`, `category`,
// `context` and `t` are open strings on the wire, and a closed list here would
// block a value invented next week. The editor accepts custom values for all
// four.

/** `type` values the spec recommends. */
export const ITEM_TYPE_OPTIONS: readonly string[] = [
  'consumable',
  'cosmetic',
  'material',
  'currency',
  'quest',
  'container',
  'tool',
  'weapon',
  'armor',
  'misc',
];

/** Category suggestions oriented at what a farm produces and uses. */
export const CATEGORY_SUGGESTIONS: readonly string[] = [
  'food',
  'seed',
  'crop',
  'produce',
  'material',
  'tool',
  'fertilizer',
  'container',
  'decoration',
  'currency',
];

/** Rarity values the spec recommends. Display metadata only. */
export const RARITY_OPTIONS: readonly string[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
  'unique',
];

/**
 * Context suggestions.
 *
 * `cross-game` is offered prominently because Farm produce is meant to be
 * usable elsewhere. What another game *does* with a Farm carrot is that game's
 * decision; the Farm never publishes another game's effect values.
 */
export const CONTEXT_SUGGESTIONS: readonly string[] = [
  FARM_GAME_CONTEXT,
  CROSS_GAME_CONTEXT,
  'collection:nostr-games',
];

/**
 * Topic suggestions.
 *
 * Topics are the cross-game interoperability surface: `t` is a single-letter
 * indexable tag, so another game can ask a relay for every `edible` item
 * without knowing the Farm exists. Generic and behaviour-free by design.
 */
export const TOPIC_SUGGESTIONS: readonly string[] = [
  'edible',
  'vegetable',
  'fruit',
  'grain',
  'crop',
  'farm-produce',
  'seed',
  'organic',
  'crafting-material',
  'tool',
];

/** Markers the current spec defines, plus the unmarked primary. */
export const MARKER_OPTIONS: readonly string[] = [PRIMARY_MARKER, ...GAME_ITEM_IMAGE_MARKERS];

/** The recommended `alt` value for an item. */
export function recommendedAlt(name: string): string {
  return `Game item definition: ${name}`;
}
