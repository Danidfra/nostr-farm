import { describe, expect, it } from 'vitest';

import { KIND_GAME_ITEM_DEFINITION } from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { importEventJson, isInPlaceEdit, lockedItemId, formToUnsignedEvent } from './form-event';

const OTHER = 'b'.repeat(64);

const CARROT_TAGS: string[][] = [
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
  ['t', 'crop'],
  ['a', `31632:${OTHER}:other:food:carrot`, '', 'based_on'],
  ['alt', 'Game item definition: Carrot'],
  ['future_tag', 'keep-me'],
];

const CONTENT = JSON.stringify({ description: 'A crunchy carrot.', futureKey: { nested: true } });

const template = () => JSON.stringify({ kind: KIND_GAME_ITEM_DEFINITION, content: CONTENT, tags: CARROT_TAGS });

const signed = (pubkey: string = FARM_OFFICIAL_ISSUER_PUBKEY) =>
  JSON.stringify({
    id: 'e'.repeat(64),
    pubkey,
    created_at: 1_700_000_000,
    kind: KIND_GAME_ITEM_DEFINITION,
    content: CONTENT,
    tags: CARROT_TAGS,
    sig: 'f'.repeat(128),
  });

describe('rejections', () => {
  it('rejects an empty paste', () => {
    expect(importEventJson('   ')).toMatchObject({ ok: false });
  });

  it('rejects malformed JSON with the parser reason', () => {
    const result = importEventJson('{ "kind": 31632, ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Not valid JSON');
  });

  it('rejects a JSON array or scalar', () => {
    expect(importEventJson('[]').ok).toBe(false);
    expect(importEventJson('"hello"').ok).toBe(false);
    expect(importEventJson('42').ok).toBe(false);
  });

  it('rejects the wrong kind with a useful message', () => {
    const result = importEventJson(JSON.stringify({ kind: 1, content: '', tags: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('31632');
    expect(result.error).toContain('kind 1');
  });

  it('rejects a missing or non-numeric kind', () => {
    expect(importEventJson(JSON.stringify({ content: '', tags: [] })).ok).toBe(false);
    expect(importEventJson(JSON.stringify({ kind: '31632', content: '', tags: [] })).ok).toBe(false);
  });

  it('rejects malformed tags and content', () => {
    expect(importEventJson(JSON.stringify({ kind: 31632, tags: 'nope' })).ok).toBe(false);
    expect(importEventJson(JSON.stringify({ kind: 31632, tags: [['d', 1]] })).ok).toBe(false);
    expect(importEventJson(JSON.stringify({ kind: 31632, tags: [], content: {} })).ok).toBe(false);
  });

  it('rejects a 31632 event that is missing required tags', () => {
    const result = importEventJson(JSON.stringify({ kind: 31632, content: '', tags: [['d', 'x']] }));
    expect(result.ok).toBe(false);
  });
});

describe('importing an unsigned template object', () => {
  it('populates every supported field', () => {
    const result = importEventJson(template());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { form } = result.value;
    expect(form.d).toBe('farm:produce:carrot');
    expect(form.name).toBe('Carrot');
    expect(form.type).toBe('consumable');
    expect(form.category).toBe('food');
    expect(form.symbol).toBe('CARROT');
    expect(form.rarity).toBe('common');
    expect(form.maxStack).toBe('99');
    expect(form.version).toBe('1');
    expect(form.alt).toBe('Game item definition: Carrot');
    expect(form.model3d).toBe('https://example.com/carrot.glb');
    expect(form.audio).toBe('https://example.com/crunch.wav');
    expect(form.contexts).toEqual(['game:farm', 'cross-game']);
    expect(form.topics).toEqual(['edible', 'vegetable', 'crop']);
    expect(form.basedOn.map((row) => row.address)).toEqual([`31632:${OTHER}:other:food:carrot`]);
    expect(form.content.description).toBe('A crunchy carrot.');
  });

  it('maps images, making the unmarked one primary', () => {
    const result = importEventJson(template());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.form.images.map(({ url, marker }) => ({ url, marker }))).toEqual([
      { url: 'https://blossom.primal.net/carrot.png', marker: '' },
      { url: 'https://blossom.primal.net/carrot-front.png', marker: 'front' },
      { url: 'https://blossom.primal.net/carrot-back.png', marker: 'back' },
    ]);
  });

  it('preserves unknown tags and unknown content keys', () => {
    const result = importEventJson(template());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.form.extraTags).toContainEqual(['future_tag', 'keep-me']);

    const rebuilt = formToUnsignedEvent(result.value.form);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.tags).toContainEqual(['future_tag', 'keep-me']);
    expect(JSON.parse(rebuilt.value.content)).toMatchObject({ futureKey: { nested: true } });
  });

  it('sets no provenance, so d stays editable', () => {
    const result = importEventJson(template(), { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.form.loaded).toBeNull();
    expect(lockedItemId(result.value.form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBeNull();
    expect(isInPlaceEdit(result.value.form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
    expect(result.value.canLoadAsExisting).toBe(false);
    expect(result.value.source.isSignedEvent).toBe(false);
  });

  it('round trips back to an equivalent event', () => {
    const result = importEventJson(template());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rebuilt = formToUnsignedEvent(result.value.form);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    for (const tag of CARROT_TAGS) expect(rebuilt.value.tags).toContainEqual(tag);
  });
});

describe('importing a signed event', () => {
  it('reports it as signed and exposes its address', () => {
    const result = importEventJson(signed());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.source.isSignedEvent).toBe(true);
    expect(result.value.source.pubkey).toBe(FARM_OFFICIAL_ISSUER_PUBKEY);
    expect(result.value.source.address).toBe(`31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`);
  });

  it('still defaults to template semantics', () => {
    const result = importEventJson(signed(), { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.form.loaded).toBeNull();
    expect(isInPlaceEdit(result.value.form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(false);
  });

  it('offers "load as existing" only when the signer is the author', () => {
    expect(importEventJson(signed(), { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY })).toMatchObject({
      value: { canLoadAsExisting: true },
    });
    expect(importEventJson(signed(), { signerPubkey: OTHER })).toMatchObject({ value: { canLoadAsExisting: false } });
    expect(importEventJson(signed(), { signerPubkey: null })).toMatchObject({ value: { canLoadAsExisting: false } });
  });

  it('locks d when explicitly loaded as an existing event by its author', () => {
    const result = importEventJson(signed(), { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY, mode: 'existing' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.form.loaded?.address).toBe(`31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`);
    expect(lockedItemId(result.value.form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe('farm:produce:carrot');
    expect(isInPlaceEdit(result.value.form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(true);
  });

  it('refuses to lock d for another issuer signed event, even when asked', () => {
    // Pasting another issuer's event must not let you "edit" it.
    const result = importEventJson(signed(OTHER), { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY, mode: 'existing' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.form.loaded).toBeNull();
    expect(lockedItemId(result.value.form, FARM_OFFICIAL_ISSUER_PUBKEY)).toBeNull();
  });

  it('refuses to lock d for an unsigned object carrying a pubkey', () => {
    const withPubkeyOnly = JSON.stringify({
      pubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      kind: KIND_GAME_ITEM_DEFINITION,
      content: CONTENT,
      tags: CARROT_TAGS,
    });

    const result = importEventJson(withPubkeyOnly, { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY, mode: 'existing' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.canLoadAsExisting).toBe(false);
    expect(result.value.form.loaded).toBeNull();
  });
});
