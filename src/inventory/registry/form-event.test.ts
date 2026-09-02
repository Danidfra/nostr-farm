import { describe, expect, it } from 'vitest';

import { KIND_GAME_ITEM_DEFINITION, getPrimaryItemImage, parseGameItemDefinition, validateGameItemDefinition } from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import {
  blankItemForm,
  nextRowId,
  recommendedAlt,
  PRIMARY_MARKER,
  type ItemFormState,
} from './form-model';
import {
  applyFormEdit,
  buildContentString,
  CLIENT_TAG,
  deriveAsNewItem,
  eventToForm,
  formAddress,
  formToUnsignedEvent,
  imageRowsToPackageImages,
  isInPlaceEdit,
  isManagedTag,
  lockedItemId,
  partitionTags,
} from './form-event';

const EXTERNAL = 'b'.repeat(64);

function tagValues(tags: string[][], name: string): string[][] {
  return tags.filter(([tagName]) => tagName === name);
}

function firstValue(tags: string[][], name: string): string | undefined {
  return tags.find(([tagName]) => tagName === name)?.[1];
}

/** A complete carrot, the way the immediate use case will be authored. */
function carrotForm(): ItemFormState {
  return {
    ...blankItemForm(),
    d: 'farm:produce:carrot',
    name: 'Carrot',
    type: 'consumable',
    category: 'food',
    images: [{ id: nextRowId('image'), url: 'https://blossom.primal.net/carrot.png', marker: PRIMARY_MARKER }],
    contexts: ['game:farm', 'cross-game'],
    topics: ['edible', 'vegetable', 'crop', 'farm-produce'],
    content: { ...blankItemForm().content, description: 'A crunchy carrot grown on a Nostr farm.' },
  };
}

describe('required-field validation', () => {
  it('builds an event when d, name and type are present', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
  });

  it.each([
    ['d', { d: '' }],
    ['name', { name: '' }],
    ['type', { type: '' }],
  ])('refuses to build without a %s', (field, patch) => {
    const result = formToUnsignedEvent({ ...carrotForm(), ...patch } as ItemFormState);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(field);
  });

  it('treats a whitespace-only required field as empty', () => {
    expect(formToUnsignedEvent({ ...carrotForm(), name: '   ' }).ok).toBe(false);
  });

  it('produces an event the package validator accepts', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const validation = validateGameItemDefinition(
      { ...result.value, pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 0 },
      { requireJsonContent: true }
    );
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });
});

describe('event construction', () => {
  it('emits kind 31632 and the required tags', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe(KIND_GAME_ITEM_DEFINITION);
    expect(firstValue(result.value.tags, 'd')).toBe('farm:produce:carrot');
    expect(firstValue(result.value.tags, 'name')).toBe('Carrot');
    expect(firstValue(result.value.tags, 'type')).toBe('consumable');
    expect(firstValue(result.value.tags, 'category')).toBe('food');
  });

  it('generates the recommended alt tag automatically', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(firstValue(result.value.tags, 'alt')).toBe('Game item definition: Carrot');
    expect(recommendedAlt('Carrot')).toBe('Game item definition: Carrot');
  });

  it('lets an explicit alt win over the generated one', () => {
    const result = formToUnsignedEvent({ ...carrotForm(), alt: 'A carrot' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(firstValue(result.value.tags, 'alt')).toBe('A carrot');
  });

  it('omits blank optional tags rather than emitting empty ones', () => {
    const result = formToUnsignedEvent({ ...carrotForm(), symbol: '', rarity: '   ', model3d: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const name of ['symbol', 'rarity', 'model_3d', 'audio', 'max_stack', 'version']) {
      expect(tagValues(result.value.tags, name)).toEqual([]);
    }
  });

  it('uses JSON content and does not duplicate tag metadata inside it', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = JSON.parse(result.value.content);
    expect(content).toEqual({ description: 'A crunchy carrot grown on a Nostr farm.' });
    for (const key of ['name', 'type', 'category', 'image', 'rarity', 'max_stack']) {
      expect(content).not.toHaveProperty(key);
    }
  });

  it('serializes an empty structured content to "" rather than "{}"', () => {
    const form = { ...carrotForm(), content: blankItemForm().content };
    const result = formToUnsignedEvent(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('');
  });

  it('rejects a malformed based_on address instead of publishing it', () => {
    const result = formToUnsignedEvent({
      ...carrotForm(),
      basedOn: [{ id: 'x', address: 'not-an-address', relay: '' }],
    });
    expect(result.ok).toBe(false);
  });

  it('carries a valid based_on derivation as an a tag with the marker', () => {
    const address = `31632:${EXTERNAL}:farm:produce:carrot`;
    const result = formToUnsignedEvent({ ...carrotForm(), basedOn: [{ id: 'x', address, relay: '' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const aTag = result.value.tags.find(([name]) => name === 'a');
    expect(aTag).toEqual(['a', address, '', 'based_on']);
  });
});

describe('repeated context, topic and image tags', () => {
  it('emits one tag per context and per topic, in order', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(tagValues(result.value.tags, 'context')).toEqual([
      ['context', 'game:farm'],
      ['context', 'cross-game'],
    ]);
    expect(tagValues(result.value.tags, 't')).toEqual([
      ['t', 'edible'],
      ['t', 'vegetable'],
      ['t', 'crop'],
      ['t', 'farm-produce'],
    ]);
  });

  it('drops blank repeatable values instead of emitting empty tags', () => {
    const result = formToUnsignedEvent({ ...carrotForm(), contexts: ['game:farm', '', '  '], topics: ['edible', ''] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tagValues(result.value.tags, 'context')).toEqual([['context', 'game:farm']]);
    expect(tagValues(result.value.tags, 't')).toEqual([['t', 'edible']]);
  });

  it('emits the unmarked primary image followed by marked views', () => {
    const result = formToUnsignedEvent({
      ...carrotForm(),
      images: [
        { id: 'i1', url: 'https://blossom.primal.net/carrot-front.png', marker: 'front' },
        { id: 'i2', url: 'https://blossom.primal.net/carrot.png', marker: PRIMARY_MARKER },
        { id: 'i3', url: 'https://blossom.primal.net/carrot-back.png', marker: 'back' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(tagValues(result.value.tags, 'image')).toEqual([
      ['image', 'https://blossom.primal.net/carrot.png'],
      ['image', 'https://blossom.primal.net/carrot-front.png', 'front'],
      ['image', 'https://blossom.primal.net/carrot-back.png', 'back'],
    ]);
  });

  it('rejects two different unmarked images as an ambiguous primary', () => {
    const result = formToUnsignedEvent({
      ...carrotForm(),
      images: [
        { id: 'i1', url: 'https://example.com/a.png', marker: PRIMARY_MARKER },
        { id: 'i2', url: 'https://example.com/b.png', marker: PRIMARY_MARKER },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('never writes the literal marker "primary" to the wire', () => {
    const rows = imageRowsToPackageImages([{ id: 'i1', url: 'https://example.com/a.png', marker: PRIMARY_MARKER }]);
    expect(rows).toEqual([{ url: 'https://example.com/a.png' }]);
  });

  it('ignores image rows with a blank URL', () => {
    expect(imageRowsToPackageImages([{ id: 'i1', url: '   ', marker: 'front' }])).toEqual([]);
  });
});

describe('primary image resolution', () => {
  const build = (images: ItemFormState['images']) => {
    const result = formToUnsignedEvent({ ...carrotForm(), images });
    if (!result.ok) throw new Error(result.error);
    return parseGameItemDefinition({ ...result.value, pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 0 })!;
  };

  it('uses the first unmarked image', () => {
    const item = build([
      { id: 'i1', url: 'https://example.com/front.png', marker: 'front' },
      { id: 'i2', url: 'https://example.com/main.png', marker: PRIMARY_MARKER },
    ]);
    expect(getPrimaryItemImage(item)).toBe('https://example.com/main.png');
  });

  it('falls back to the first marked image when every image is marked', () => {
    const item = build([
      { id: 'i1', url: 'https://example.com/front.png', marker: 'front' },
      { id: 'i2', url: 'https://example.com/back.png', marker: 'back' },
    ]);
    expect(getPrimaryItemImage(item)).toBe('https://example.com/front.png');
  });

  it('reports no image when the item has none', () => {
    expect(getPrimaryItemImage(build([]))).toBeUndefined();
  });
});

describe('Blossom URL integration', () => {
  it('carries an uploaded Blossom URL straight into the image tag', () => {
    const uploaded = 'https://blossom.primal.net/9f8e7d6c5b4a.png';
    const result = formToUnsignedEvent({
      ...carrotForm(),
      images: [{ id: 'i1', url: uploaded, marker: PRIMARY_MARKER }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(tagValues(result.value.tags, 'image')).toEqual([['image', uploaded]]);

    const item = parseGameItemDefinition({ ...result.value, pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 0 })!;
    expect(getPrimaryItemImage(item)).toBe(uploaded);
  });

  it('keeps an uploaded marked view as a marked view', () => {
    const result = formToUnsignedEvent({
      ...carrotForm(),
      images: [
        { id: 'i1', url: 'https://blossom.primal.net/a.png', marker: PRIMARY_MARKER },
        { id: 'i2', url: 'https://blossom.primal.net/b.png', marker: 'side-left' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tagValues(result.value.tags, 'image')[1]).toEqual(['image', 'https://blossom.primal.net/b.png', 'side-left']);
  });
});

describe('item address identity', () => {
  it('addresses an item by issuer and d together', () => {
    expect(formAddress(carrotForm(), FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(`31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`);
  });

  it('gives the same d under two issuers two different addresses', () => {
    const official = formAddress(carrotForm(), FARM_OFFICIAL_ISSUER_PUBKEY);
    const external = formAddress(carrotForm(), EXTERNAL);
    expect(official).not.toBe(external);
  });

  it('has no address without a signer or without a d', () => {
    expect(formAddress(carrotForm(), null)).toBeNull();
    expect(formAddress({ ...carrotForm(), d: '  ' }, FARM_OFFICIAL_ISSUER_PUBKEY)).toBeNull();
  });
});

describe('content serialization', () => {
  it('returns the author bytes unchanged in JSON mode', () => {
    const raw = '{\n  "description": "hand written"\n}';
    const result = buildContentString({ ...blankItemForm().content, mode: 'json', raw });
    expect(result).toEqual({ ok: true, value: raw });
  });

  it('rejects invalid JSON in JSON mode', () => {
    const result = buildContentString({ ...blankItemForm().content, mode: 'json', raw: '{oops' });
    expect(result.ok).toBe(false);
  });

  it('nests effects under their context key', () => {
    const result = buildContentString({
      ...blankItemForm().content,
      effects: [{ id: 'e1', context: 'game:farm', key: 'freshness', value: '5', valueType: 'number' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toEqual({ effects: { 'game:farm': { freshness: 5 } } });
  });

  it('preserves unknown top-level content keys through a round trip', () => {
    const event = {
      kind: KIND_GAME_ITEM_DEFINITION,
      pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      created_at: 1,
      tags: [['d', 'x'], ['name', 'X'], ['type', 'misc']],
      content: JSON.stringify({ description: 'hi', futureKey: { nested: true } }),
    };
    const loaded = eventToForm(event);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const rebuilt = formToUnsignedEvent(loaded.value.form);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(JSON.parse(rebuilt.value.content)).toMatchObject({ futureKey: { nested: true } });
  });
});

describe('addressable update behaviour', () => {
  const published = () => {
    const built = formToUnsignedEvent(carrotForm());
    if (!built.ok) throw new Error(built.error);
    return { ...built.value, id: 'e'.repeat(64), pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 1_700_000_000 };
  };

  it('round trips a published event back into the editor', () => {
    const loaded = eventToForm(published(), ['wss://relay.example']);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.form.d).toBe('farm:produce:carrot');
    expect(loaded.value.form.name).toBe('Carrot');
    expect(loaded.value.form.topics).toEqual(['edible', 'vegetable', 'crop', 'farm-produce']);
    expect(loaded.value.form.loaded?.address).toBe(`31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`);
    expect(loaded.value.form.loaded?.relays).toEqual(['wss://relay.example']);
  });

  it('re-publishing an edit keeps the same address, so it replaces the definition', () => {
    const loaded = eventToForm(published());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const edited = { ...loaded.value.form, name: 'Heirloom Carrot' };
    const rebuilt = formToUnsignedEvent(edited);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    expect(firstValue(rebuilt.value.tags, 'd')).toBe('farm:produce:carrot');
    expect(firstValue(rebuilt.value.tags, 'name')).toBe('Heirloom Carrot');
    expect(formAddress(edited, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(formAddress(loaded.value.form, FARM_OFFICIAL_ISSUER_PUBKEY));
  });

  it('preserves tags the form does not manage across an edit', () => {
    const event = { ...published(), tags: [...published().tags, ['future_tag', 'keep-me']] };
    const loaded = eventToForm(event);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.form.extraTags).toContainEqual(['future_tag', 'keep-me']);

    const rebuilt = formToUnsignedEvent(loaded.value.form);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.tags).toContainEqual(['future_tag', 'keep-me']);
  });

  it('rejects an event that is not a valid item definition', () => {
    const result = eventToForm({ kind: 1, pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 0, tags: [], content: '' });
    expect(result.ok).toBe(false);
  });

  it('deriving as a new item clears provenance and records the origin', () => {
    const loaded = eventToForm(published());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const derived = deriveAsNewItem(loaded.value.form);
    expect(derived.loaded).toBeNull();
    expect(derived.basedOn.map((row) => row.address)).toContain(`31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`);
  });
});

describe('managed tag partitioning', () => {
  it('treats spec tags as managed and unknown tags as preserved', () => {
    expect(isManagedTag(['name', 'x'])).toBe(true);
    expect(isManagedTag(['image', 'u', 'front'])).toBe(true);
    expect(isManagedTag(['future_tag', 'x'])).toBe(false);
  });

  it('treats an a tag as managed only when it carries the based_on marker', () => {
    expect(isManagedTag(['a', '31632:x:y', '', 'based_on'])).toBe(true);
    expect(isManagedTag(['a', '31632:x:y'])).toBe(false);
  });

  it('splits tags into managed and unmanaged', () => {
    const { managed, unmanaged } = partitionTags([['d', 'x'], ['weird', 'y']]);
    expect(managed).toEqual([['d', 'x']]);
    expect(unmanaged).toEqual([['weird', 'y']]);
  });
});

describe('the client tag lives in the template, not the publisher', () => {
  it('is present in the built template so the review shows it', () => {
    const result = formToUnsignedEvent(carrotForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toContainEqual([...CLIENT_TAG]);
  });

  it('is emitted exactly once when re-publishing an event that already had one', () => {
    const built = formToUnsignedEvent(carrotForm());
    if (!built.ok) throw new Error(built.error);

    const loaded = eventToForm({ ...built.value, pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 1 });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const rebuilt = formToUnsignedEvent(loaded.value.form);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.tags.filter(([name]) => name === 'client')).toEqual([[...CLIENT_TAG]]);
  });

  it('regenerates a foreign client tag rather than preserving a stale one', () => {
    const event = {
      kind: KIND_GAME_ITEM_DEFINITION,
      pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      created_at: 1,
      tags: [['d', 'x'], ['name', 'X'], ['type', 'misc'], ['client', 'some-other-client']],
      content: '',
    };
    const loaded = eventToForm(event);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.form.extraTags).not.toContainEqual(['client', 'some-other-client']);

    const rebuilt = formToUnsignedEvent(loaded.value.form);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.tags.filter(([name]) => name === 'client')).toEqual([[...CLIENT_TAG]]);
  });
});

describe('d is immutable during an in-place edit', () => {
  const published = () => {
    const built = formToUnsignedEvent(carrotForm());
    if (!built.ok) throw new Error(built.error);
    return { ...built.value, id: 'e'.repeat(64), pubkey: FARM_OFFICIAL_ISSUER_PUBKEY, created_at: 1_700_000_000 };
  };

  const loadedForm = () => {
    const loaded = eventToForm(published());
    if (!loaded.ok) throw new Error(loaded.error);
    return loaded.value.form;
  };

  it('locks d to the published value once loaded by its own issuer', () => {
    expect(lockedItemId(loadedForm(), FARM_OFFICIAL_ISSUER_PUBKEY)).toBe('farm:produce:carrot');
  });

  it('does not lock d for a fresh form', () => {
    expect(lockedItemId(blankItemForm(), FARM_OFFICIAL_ISSUER_PUBKEY)).toBeNull();
  });

  it('does not lock d when the loaded item belongs to somebody else', () => {
    expect(lockedItemId(loadedForm(), EXTERNAL)).toBeNull();
  });

  it('refuses a d change while editing in place', () => {
    const previous = loadedForm();
    const attempted = { ...previous, d: 'farm:produce:tomato' };

    const applied = applyFormEdit(previous, attempted, FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(applied.d).toBe('farm:produce:carrot');
  });

  it('allows every other field to change while editing in place', () => {
    const previous = loadedForm();
    const attempted: ItemFormState = {
      ...previous,
      name: 'Heirloom Carrot',
      category: 'produce',
      images: [{ id: 'i9', url: 'https://blossom.primal.net/new.png', marker: PRIMARY_MARKER }],
      topics: [...previous.topics, 'heirloom'],
    };

    const applied = applyFormEdit(previous, attempted, FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(applied.name).toBe('Heirloom Carrot');
    expect(applied.category).toBe('produce');
    expect(applied.topics).toContain('heirloom');
    expect(applied.d).toBe('farm:produce:carrot');
  });

  it('keeps the full address identical across such an edit', () => {
    const previous = loadedForm();
    const edited = applyFormEdit(
      previous,
      { ...previous, name: 'Heirloom Carrot', rarity: 'rare' },
      FARM_OFFICIAL_ISSUER_PUBKEY
    );

    expect(formAddress(edited, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(formAddress(previous, FARM_OFFICIAL_ISSUER_PUBKEY));
    expect(formAddress(edited, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(previous.loaded?.address);
  });

  it('allows d to change freely on a form that is not an in-place edit', () => {
    const fresh = { ...blankItemForm(), d: 'farm:produce:carrot', name: 'Carrot', type: 'consumable' };
    const applied = applyFormEdit(fresh, { ...fresh, d: 'farm:produce:tomato' }, FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(applied.d).toBe('farm:produce:tomato');
  });

  it('reports an in-place edit only while the address still matches', () => {
    const previous = loadedForm();
    expect(isInPlaceEdit(previous, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);

    // A d that somehow diverged is no longer editing the same item, so the
    // "re-publishing replaces it" promise must stop being made.
    expect(isInPlaceEdit({ ...previous, d: 'farm:produce:tomato' }, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
    // Nor is it an in-place edit for anybody but the issuer.
    expect(isInPlaceEdit(previous, EXTERNAL)).toBe(false);
    expect(isInPlaceEdit(previous, null)).toBe(false);
  });

  it('makes derivation the explicit path to a new identity', () => {
    const previous = loadedForm();
    const derived = deriveAsNewItem(previous);

    // Provenance is cleared, so d is no longer locked and a new one may be set.
    expect(derived.loaded).toBeNull();
    expect(lockedItemId(derived, FARM_OFFICIAL_ISSUER_PUBKEY)).toBeNull();
    expect(isInPlaceEdit(derived, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);

    const renamed = applyFormEdit(derived, { ...derived, d: 'farm:produce:heirloom-carrot' }, FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(renamed.d).toBe('farm:produce:heirloom-carrot');
    expect(formAddress(renamed, FARM_OFFICIAL_ISSUER_PUBKEY)).not.toBe(previous.loaded?.address);
    expect(renamed.basedOn.map((row) => row.address)).toContain(previous.loaded?.address);
  });
});
