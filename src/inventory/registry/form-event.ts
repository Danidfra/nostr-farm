import {
  BASED_ON_MARKER,
  KIND_GAME_ITEM_DEFINITION,
  buildGameItemAddress,
  buildGameItemDefinitionEvent,
  parseGameItemDefinitionResult,
  type BuildGameItemDefinitionInput,
  type GameItemImage,
  type UnsignedEventTemplate,
} from '@/inventory/package';
import {
  PRIMARY_MARKER,
  blankContent,
  nextRowId,
  recommendedAlt,
  reserveRowIds,
  type ContentFormState,
  type ImageRow,
  type ItemFormState,
  type MetadataRow,
} from './form-model';

/**
 * Conversion between the form model and a kind:31632 event, in both
 * directions.
 *
 * Every protocol rule — required fields, tag order, image handling, address
 * shape — is delegated to `@nostr-games/inventory` through
 * `@/inventory/package`. This module owns only the projection between "what a
 * human typed" and "what the builder accepts", plus the preservation of
 * anything the form does not model.
 */

export type ConversionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The `client` tag this application stamps on the events it publishes.
 *
 * It is added HERE, during template construction, and not by the publisher.
 * The review dialog shows the template, so anything the publisher appended
 * afterwards would be a tag the user never saw — the event shown and the event
 * signed have to be the same object.
 */
export const CLIENT_TAG: readonly string[] = Object.freeze(['client', 'nostr-worlds']);

/**
 * Tag names regenerated from form state rather than preserved verbatim.
 *
 * `client` is managed: a loaded event's `client` tag names whichever client
 * published it, and re-publishing from here makes this the client. Treating it
 * as managed regenerates it rather than preserving a stale value or emitting
 * two.
 */
export const MANAGED_TAG_NAMES: ReadonlySet<string> = new Set([
  'd', 'name', 'type', 'category', 'image', 'model_3d', 'audio',
  'symbol', 'rarity', 'max_stack', 'version', 'context', 't', 'alt', 'client',
]);

/**
 * Is this tag regenerated from form state?
 *
 * An `a` tag counts as managed ONLY when it carries the `based_on` marker;
 * every other `a` usage a future spec might introduce is unmanaged and
 * survives an edit, which is how the package builder treats it too.
 */
export function isManagedTag(tag: readonly string[]): boolean {
  const [name] = tag;
  if (name === 'a') return tag[3] === BASED_ON_MARKER;
  return MANAGED_TAG_NAMES.has(name);
}

/** Split an event's tags into the ones the form regenerates and the rest. */
export function partitionTags(tags: readonly string[][]): { managed: string[][]; unmanaged: string[][] } {
  const managed: string[][] = [];
  const unmanaged: string[][] = [];
  for (const tag of tags) (isManagedTag(tag) ? managed : unmanaged).push([...tag]);
  return { managed, unmanaged };
}

// --- Content ---------------------------------------------------------------

function metadataValue(row: MetadataRow): ConversionResult<unknown> {
  const raw = row.value;
  switch (row.valueType) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `Metadata "${row.key}" is not a number: ${raw}` };
      return { ok: true, value: n };
    }
    case 'boolean':
      return { ok: true, value: raw.trim().toLowerCase() === 'true' };
    case 'json':
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch (error) {
        return { ok: false, error: `Metadata "${row.key}" is not valid JSON: ${(error as Error).message}` };
      }
    default:
      return { ok: true, value: raw };
  }
}

/**
 * Serialize the content editor.
 *
 * In `json` mode the author's bytes are returned unchanged (after a validity
 * check) so somebody who hand-wrote their content gets it back exactly. In
 * `structured` mode the managed fields are assembled and every unmanaged key is
 * appended verbatim.
 *
 * An entirely empty structured form serializes to `""`, not `"{}"`: empty
 * content is valid and is what a tag-only definition should publish.
 */
export function buildContentString(content: ContentFormState): ConversionResult<string> {
  if (content.mode === 'json' || content.rawOnly) {
    const raw = content.raw.trim();
    if (raw === '') return { ok: true, value: '' };
    try {
      JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `Content is not valid JSON: ${(error as Error).message}` };
    }
    return { ok: true, value: content.raw };
  }

  const out: Record<string, unknown> = {};

  if (content.description.trim() !== '') out.description = content.description;

  const effects: Record<string, Record<string, unknown>> = {};
  for (const row of content.effects) {
    const context = row.context.trim();
    const key = row.key.trim();
    if (context === '' || key === '') continue;
    let value: unknown = row.value;
    if (row.valueType === 'number') {
      const n = Number(row.value);
      if (!Number.isFinite(n)) return { ok: false, error: `Effect "${key}" is not a number: ${row.value}` };
      value = n;
    } else if (row.valueType === 'boolean') {
      value = row.value.trim().toLowerCase() === 'true';
    }
    (effects[context] ??= {})[key] = value;
  }
  if (Object.keys(effects).length > 0) out.effects = effects;

  const metadata: Record<string, unknown> = {};
  for (const row of content.metadata) {
    if (row.key.trim() === '') continue;
    const value = metadataValue(row);
    if (!value.ok) return value;
    metadata[row.key.trim()] = value.value;
  }
  if (Object.keys(metadata).length > 0) out.metadata = metadata;

  if (content.visual.trim() !== '') {
    try {
      const parsed = JSON.parse(content.visual);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) out.visual = parsed;
      else return { ok: false, error: 'Visual must be a JSON object.' };
    } catch (error) {
      return { ok: false, error: `Visual is not valid JSON: ${(error as Error).message}` };
    }
  }

  for (const [key, value] of Object.entries(content.extra)) {
    if (!(key in out)) out[key] = value;
  }

  if (Object.keys(out).length === 0) return { ok: true, value: '' };
  return { ok: true, value: JSON.stringify(out) };
}

// --- Form -> event ---------------------------------------------------------

/** Image rows reduced to what the package builder accepts. */
export function imageRowsToPackageImages(rows: readonly ImageRow[]): GameItemImage[] {
  const out: GameItemImage[] = [];
  for (const row of rows) {
    const url = row.url.trim();
    if (url === '') continue;
    const marker = row.marker.trim();
    out.push(marker === PRIMARY_MARKER ? { url } : { url, marker });
  }
  return out;
}

/** Project the form onto the package builder's input. */
export function formToBuildInput(form: ItemFormState): ConversionResult<BuildGameItemDefinitionInput> {
  const content = buildContentString(form.content);
  if (!content.ok) return content;

  const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());
  const name = form.name.trim();

  return {
    ok: true,
    value: {
      id: form.d.trim(),
      name,
      type: form.type.trim(),
      category: optional(form.category),
      images: imageRowsToPackageImages(form.images),
      model3d: optional(form.model3d),
      audio: optional(form.audio),
      symbol: optional(form.symbol),
      rarity: optional(form.rarity),
      maxStack: optional(form.maxStack),
      version: optional(form.version),
      // The spec RECOMMENDS `alt`; the package builder does not invent one.
      // Generating it here is what makes it automatic for the author, while an
      // explicitly typed value still wins.
      alt: optional(form.alt) ?? (name === '' ? undefined : recommendedAlt(name)),
      contexts: form.contexts.filter((c) => c.trim() !== ''),
      topics: form.topics.filter((t) => t.trim() !== ''),
      basedOn: form.basedOn
        .filter((row) => row.address.trim() !== '')
        .map((row) => ({ address: row.address.trim(), relay: row.relay.trim() })),
      content: content.value,
      // The client tag rides along as an extra tag so it is present in the
      // template the review dialog renders.
      extraTags: [...form.extraTags.map((tag) => [...tag]), [...CLIENT_TAG]],
    },
  };
}

/**
 * Build the unsigned kind:31632 template for this form.
 *
 * Every rejection comes from the package builder — missing `id`/`name`/`type`,
 * a bad `max_stack`, a malformed `based_on` address, an ambiguous primary
 * image, an `extraTags` conflict — rather than from a second implementation of
 * its rules here. That is the point of routing through it.
 */
export function formToUnsignedEvent(
  form: ItemFormState
): ConversionResult<UnsignedEventTemplate<typeof KIND_GAME_ITEM_DEFINITION>> {
  const input = formToBuildInput(form);
  if (!input.ok) return input;
  try {
    const template = buildGameItemDefinitionEvent(input.value);
    assertNoLiteralPrimaryMarker(template.tags);
    return { ok: true, value: template };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * The primary image is the ABSENCE of a marker. If the literal string
 * `"primary"` ever reached slot 2 of an `image` tag, every other client would
 * read it as an unknown view marker and the item would have no primary image
 * at all — so this is checked rather than assumed.
 */
function assertNoLiteralPrimaryMarker(tags: readonly string[][]): void {
  for (const tag of tags) {
    if (tag[0] === 'image' && tag[2] === 'primary') {
      throw new Error('Refusing to publish an image tag marked "primary": the primary image is an unmarked image tag.');
    }
  }
}

/**
 * Is this form an in-place edit of the definition it was loaded from?
 *
 * True only when the signer owns the loaded event AND the address the form
 * would publish to is still the loaded one. kind:31632 is addressed by
 * `(author, d)`, so the moment `d` changes the form describes a DIFFERENT item
 * and re-publishing would create it rather than replace anything. Callers use
 * this both to lock the `d` field and to decide whether the "re-publishing
 * replaces this definition" promise is still true.
 */
export function isInPlaceEdit(form: ItemFormState, signerPubkey: string | null | undefined): boolean {
  if (!form.loaded || !signerPubkey) return false;
  if (form.loaded.pubkey !== signerPubkey) return false;
  return formAddress(form, signerPubkey) === form.loaded.address;
}

/**
 * The `d` that must not change, or `null` when the form is free to set one.
 *
 * Non-null exactly when the form was loaded from the signer's own published
 * definition.
 */
export function lockedItemId(form: ItemFormState, signerPubkey: string | null | undefined): string | null {
  if (!form.loaded || !signerPubkey || form.loaded.pubkey !== signerPubkey) return null;
  return form.loaded.d;
}

/**
 * Apply an edit to the form, refusing any change to a locked `d`.
 *
 * The `d` input is disabled in the UI, but identity is too important to leave
 * to a disabled attribute: silently turning an edit into a new item is exactly
 * the failure this guards. Creating a new identity from an existing definition
 * has its own explicit path — {@link deriveAsNewItem}.
 */
export function applyFormEdit(
  previous: ItemFormState,
  next: ItemFormState,
  signerPubkey: string | null | undefined
): ItemFormState {
  const locked = lockedItemId(previous, signerPubkey);
  if (locked === null || next.d === locked) return next;
  return { ...next, d: locked };
}

/** The full `31632:<pubkey>:<d>` address a form would publish to. */
export function formAddress(form: ItemFormState, pubkey: string | null | undefined): string | null {
  const d = form.d.trim();
  if (d === '' || !pubkey) return null;
  return buildGameItemAddress(pubkey, d);
}

/** The unsigned event as it will be signed, for preview and inspection. */
export function toPreviewEvent(
  template: UnsignedEventTemplate<typeof KIND_GAME_ITEM_DEFINITION>,
  pubkey: string,
  createdAt: number
) {
  return {
    kind: template.kind,
    content: template.content,
    tags: template.tags,
    pubkey,
    created_at: createdAt,
  };
}

// --- Event -> form ---------------------------------------------------------

function contentToFormState(raw: string): ContentFormState {
  const content = blankContent();
  const trimmed = raw.trim();
  if (trimmed === '') return content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ...content, mode: 'json', raw, rawOnly: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...content, mode: 'json', raw, rawOnly: true };
  }

  const record = parsed as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!['description', 'effects', 'metadata', 'visual'].includes(key)) extra[key] = value;
  }

  const effects: ContentFormState['effects'] = [];
  if (record.effects && typeof record.effects === 'object' && !Array.isArray(record.effects)) {
    for (const [context, values] of Object.entries(record.effects as Record<string, unknown>)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        effects.push({
          id: nextRowId('effect'),
          context,
          key,
          value: String(value),
          valueType: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
        });
      }
    }
  }

  const metadata: MetadataRow[] = [];
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    for (const [key, value] of Object.entries(record.metadata as Record<string, unknown>)) {
      const valueType: MetadataRow['valueType'] =
        typeof value === 'number' ? 'number'
        : typeof value === 'boolean' ? 'boolean'
        : typeof value === 'string' ? 'string'
        : 'json';
      metadata.push({
        id: nextRowId('meta'),
        key,
        value: valueType === 'json' ? JSON.stringify(value) : String(value),
        valueType,
      });
    }
  }

  return {
    mode: 'structured',
    description: typeof record.description === 'string' ? record.description : '',
    effects,
    metadata,
    visual: record.visual !== undefined ? JSON.stringify(record.visual, null, 2) : '',
    raw,
    extra,
    rawOnly: false,
  };
}

export interface EventToFormResult {
  form: ItemFormState;
  warnings: string[];
}

/**
 * Load a published event into the editor.
 *
 * Tags the form does not manage are kept in `extraTags` and re-emitted on
 * publish, so editing a definition written by a newer client cannot silently
 * drop its unknown tags.
 */
export function eventToForm(
  event: { id?: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string },
  relays: string[] = []
): ConversionResult<EventToFormResult> {
  const parsed = parseGameItemDefinitionResult(event, { mode: 'permissive' });
  if (!parsed.ok) {
    return { ok: false, error: `Not a valid kind:${KIND_GAME_ITEM_DEFINITION} item definition.` };
  }

  const definition = parsed.value;
  const { unmanaged } = partitionTags(event.tags);

  const images: ImageRow[] = definition.images.map((image) => ({
    id: nextRowId('image'),
    url: image.url,
    marker: image.marker ?? PRIMARY_MARKER,
  }));
  reserveRowIds(images.map((row) => row.id));

  const form: ItemFormState = {
    d: definition.id,
    name: definition.name,
    type: definition.type,
    category: definition.category ?? '',
    symbol: definition.symbol ?? '',
    rarity: definition.rarity ?? '',
    maxStack: definition.maxStack ?? '',
    version: definition.version ?? '',
    alt: definition.alt ?? '',
    images,
    contexts: [...definition.contexts],
    topics: [...definition.topics],
    model3d: definition.model3d ?? '',
    audio: definition.audio ?? '',
    basedOn: definition.basedOn.map((ref) => ({ id: nextRowId('based-on'), address: ref.address, relay: ref.relay })),
    content: contentToFormState(definition.content),
    extraTags: unmanaged,
    loaded: {
      eventId: event.id ?? '',
      pubkey: event.pubkey,
      createdAt: event.created_at,
      address: definition.address,
      d: definition.id,
      relays,
    },
  };

  return { ok: true, value: { form, warnings: parsed.warnings.map((w) => `${w.code}: ${w.message}`) } };
}

/**
 * Re-key a loaded form as a NEW item under the current signer.
 *
 * Editing somebody else's item is not possible — kind:31632 is addressable by
 * `(author, d)`, so publishing under your own key always creates a different
 * item. This makes that explicit rather than letting it happen by surprise, and
 * records the origin as a `based_on` derivation.
 */
export function deriveAsNewItem(form: ItemFormState): ItemFormState {
  const origin = form.loaded?.address;
  return {
    ...form,
    loaded: null,
    basedOn: origin && !form.basedOn.some((row) => row.address === origin)
      ? [...form.basedOn, { id: nextRowId('based-on'), address: origin, relay: '' }]
      : form.basedOn,
  };
}
