import { describe, expect, it } from 'vitest';

import { KIND_GAME_ITEM_DEFINITION, getPrimaryItemImage, parseGameItemDefinition } from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { canEditItem } from '@/inventory/issuer';
import { PRIMARY_MARKER, type ItemFormState } from './form-model';
import {
  applyFormEdit,
  deriveAsNewItem,
  eventToForm,
  formAddress,
  formToUnsignedEvent,
  isInPlaceEdit,
  lockedItemId,
} from './form-event';

/**
 * End-to-end behaviour of editing an already-published definition: load,
 * change, and re-publish to the SAME address.
 */

const OTHER = 'b'.repeat(64);

const PUBLISHED_TAGS: string[][] = [
  ['d', 'farm:produce:carrot'],
  ['name', 'Carrot'],
  ['type', 'consumable'],
  ['category', 'food'],
  ['image', 'https://blossom.primal.net/carrot.png'],
  ['image', 'https://blossom.primal.net/carrot-front.png', 'front'],
  ['image', 'https://blossom.primal.net/carrot-back.png', 'back'],
  ['model_3d', 'https://example.com/carrot.glb'],
  ['audio', 'https://example.com/crunch.wav'],
  ['symbol', 'CARROT'],
  ['rarity', 'common'],
  ['max_stack', '99'],
  ['version', '1'],
  ['context', 'game:farm'],
  ['context', 'cross-game'],
  ['t', 'edible'],
  ['t', 'vegetable'],
  ['a', `31632:${OTHER}:other:food:carrot`, '', 'based_on'],
  ['alt', 'Game item definition: Carrot'],
  ['future_tag', 'keep-me'],
];

const PUBLISHED_CONTENT = JSON.stringify({
  description: 'A crunchy carrot.',
  metadata: { craftingGroup: 'vegetables' },
  futureKey: { nested: true },
});

function publishedEvent(pubkey: string = FARM_OFFICIAL_ISSUER_PUBKEY) {
  return {
    id: 'e'.repeat(64),
    pubkey,
    created_at: 1_700_000_000,
    kind: KIND_GAME_ITEM_DEFINITION,
    tags: PUBLISHED_TAGS,
    content: PUBLISHED_CONTENT,
  };
}

function loadForEdit(pubkey: string = FARM_OFFICIAL_ISSUER_PUBKEY): ItemFormState {
  const loaded = eventToForm(publishedEvent(pubkey), ['wss://relay.example']);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value.form;
}

const ADDRESS = `31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`;

describe('who may edit in place', () => {
  it('permits the issuer', () => {
    expect(canEditItem(FARM_OFFICIAL_ISSUER_PUBKEY, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);
    expect(isInPlaceEdit(loadForEdit(), FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);
  });

  it('refuses everybody else, including when signed out', () => {
    expect(canEditItem(OTHER, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
    expect(isInPlaceEdit(loadForEdit(), OTHER)).toBe(false);
    expect(isInPlaceEdit(loadForEdit(), null)).toBe(false);
  });
});

describe('opening an item for editing', () => {
  const form = loadForEdit();

  it('populates every supported field from the published event', () => {
    expect(form).toMatchObject({
      d: 'farm:produce:carrot',
      name: 'Carrot',
      type: 'consumable',
      category: 'food',
      symbol: 'CARROT',
      rarity: 'common',
      maxStack: '99',
      version: '1',
      alt: 'Game item definition: Carrot',
      model3d: 'https://example.com/carrot.glb',
      audio: 'https://example.com/crunch.wav',
      contexts: ['game:farm', 'cross-game'],
      topics: ['edible', 'vegetable'],
    });
    expect(form.basedOn.map((row) => row.address)).toEqual([`31632:${OTHER}:other:food:carrot`]);
    expect(form.content.description).toBe('A crunchy carrot.');
    expect(form.content.metadata.map((row) => [row.key, row.value])).toEqual([['craftingGroup', 'vegetables']]);
  });

  it('loads the primary image and every marked view, in order', () => {
    expect(form.images.map(({ url, marker }) => ({ url, marker }))).toEqual([
      { url: 'https://blossom.primal.net/carrot.png', marker: PRIMARY_MARKER },
      { url: 'https://blossom.primal.net/carrot-front.png', marker: 'front' },
      { url: 'https://blossom.primal.net/carrot-back.png', marker: 'back' },
    ]);
  });

  it('records the provenance the edit banner shows', () => {
    expect(form.loaded).toMatchObject({
      address: ADDRESS,
      d: 'farm:produce:carrot',
      pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      relays: ['wss://relay.example'],
    });
  });

  it('locks the item id', () => {
    expect(lockedItemId(form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe('farm:produce:carrot');
    expect(applyFormEdit(form, { ...form, d: 'farm:produce:tomato' }, FARM_OFFICIAL_ISSUER_PUBKEY).d).toBe(
      'farm:produce:carrot'
    );
  });
});

describe('publishing the edit', () => {
  it('keeps the same address after changing name, images and topics', () => {
    const before = loadForEdit();
    const edited = applyFormEdit(
      before,
      {
        ...before,
        name: 'Heirloom Carrot',
        topics: [...before.topics, 'heirloom'],
        images: [
          { id: 'i1', url: 'https://blossom.primal.net/carrot-v2.png', marker: PRIMARY_MARKER },
          { id: 'i2', url: 'https://blossom.primal.net/carrot-side-left.png', marker: 'side-left' },
        ],
      },
      FARM_OFFICIAL_ISSUER_PUBKEY
    );

    expect(formAddress(edited, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(ADDRESS);
    expect(isInPlaceEdit(edited, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);

    const built = formToUnsignedEvent(edited);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.tags).toContainEqual(['d', 'farm:produce:carrot']);
    expect(built.value.tags).toContainEqual(['name', 'Heirloom Carrot']);
    expect(built.value.tags).toContainEqual(['t', 'heirloom']);
  });

  it('keeps the primary image unmarked and marked views marked', () => {
    const before = loadForEdit();
    const edited = {
      ...before,
      images: [
        { id: 'i1', url: 'https://blossom.primal.net/carrot-v2.png', marker: PRIMARY_MARKER },
        { id: 'i2', url: 'https://blossom.primal.net/carrot-side-left.png', marker: 'side-left' },
        { id: 'i3', url: 'https://blossom.primal.net/carrot-diag.png', marker: 'diagonal-front-right' },
      ],
    };

    const built = formToUnsignedEvent(edited);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.tags.filter(([name]) => name === 'image')).toEqual([
      ['image', 'https://blossom.primal.net/carrot-v2.png'],
      ['image', 'https://blossom.primal.net/carrot-side-left.png', 'side-left'],
      ['image', 'https://blossom.primal.net/carrot-diag.png', 'diagonal-front-right'],
    ]);

    const reparsed = parseGameItemDefinition({
      ...built.value,
      pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      created_at: 1_700_000_100,
    })!;
    expect(getPrimaryItemImage(reparsed)).toBe('https://blossom.primal.net/carrot-v2.png');
  });

  it('supports removing every marked view, leaving only the primary', () => {
    const before = loadForEdit();
    const built = formToUnsignedEvent({ ...before, images: [before.images[0]] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.tags.filter(([name]) => name === 'image')).toEqual([
      ['image', 'https://blossom.primal.net/carrot.png'],
    ]);
  });

  it('preserves unknown tags and unknown content keys through the edit', () => {
    const before = loadForEdit();
    const built = formToUnsignedEvent({ ...before, name: 'Heirloom Carrot' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.tags).toContainEqual(['future_tag', 'keep-me']);
    expect(JSON.parse(built.value.content)).toMatchObject({
      description: 'A crunchy carrot.',
      metadata: { craftingGroup: 'vegetables' },
      futureKey: { nested: true },
    });
  });
});

describe('the derivation path is separate', () => {
  it('creates a new identity instead of updating the source', () => {
    const source = loadForEdit(OTHER);

    // Not the signer's item, so no in-place edit is possible.
    expect(isInPlaceEdit(source, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
    expect(lockedItemId(source, FARM_OFFICIAL_ISSUER_PUBKEY)).toBeNull();

    const derived = deriveAsNewItem(source);
    const renamed = applyFormEdit(
      derived,
      { ...derived, d: 'farm:produce:carrot-remix' },
      FARM_OFFICIAL_ISSUER_PUBKEY
    );

    expect(renamed.d).toBe('farm:produce:carrot-remix');
    expect(formAddress(renamed, FARM_OFFICIAL_ISSUER_PUBKEY)).not.toBe(`31632:${OTHER}:farm:produce:carrot`);
    expect(renamed.basedOn.map((row) => row.address)).toContain(`31632:${OTHER}:farm:produce:carrot`);
  });
});

describe('update semantics are claimed only when true', () => {
  it('a freshly loaded own item is an in-place edit', () => {
    expect(isInPlaceEdit(loadForEdit(), FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);
  });

  it('a derived form is not', () => {
    expect(isInPlaceEdit(deriveAsNewItem(loadForEdit()), FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
  });

  it('a form whose d somehow diverged is not', () => {
    const form = loadForEdit();
    expect(isInPlaceEdit({ ...form, d: 'farm:produce:tomato' }, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
  });

  it('somebody else viewing the same loaded form is not', () => {
    expect(isInPlaceEdit(loadForEdit(), OTHER)).toBe(false);
  });
});
