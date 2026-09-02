import { describe, expect, it } from 'vitest';

import { parseGameItemDefinition, type GameItemDefinition } from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { applyFilters, blankFilters, countEditable, facetValues, matchesFilters, sortForDisplay } from './filters';

const EXTERNAL = 'b'.repeat(64);

function item(
  pubkey: string,
  d: string,
  overrides: { name?: string; type?: string; category?: string; contexts?: string[]; topics?: string[] } = {}
): GameItemDefinition {
  const tags: string[][] = [
    ['d', d],
    ['name', overrides.name ?? d],
    ['type', overrides.type ?? 'consumable'],
  ];
  if (overrides.category) tags.push(['category', overrides.category]);
  for (const c of overrides.contexts ?? []) tags.push(['context', c]);
  for (const t of overrides.topics ?? []) tags.push(['t', t]);

  return parseGameItemDefinition({ kind: 31632, pubkey, created_at: 0, tags, content: '' })!;
}

const carrot = item(FARM_OFFICIAL_ISSUER_PUBKEY, 'farm:produce:carrot', {
  name: 'Carrot',
  category: 'food',
  contexts: ['game:farm', 'cross-game'],
  topics: ['edible', 'vegetable'],
});
const hoe = item(FARM_OFFICIAL_ISSUER_PUBKEY, 'farm:tool:hoe', { name: 'Hoe', type: 'tool', category: 'tool', topics: ['tool'] });
const stranger = item(EXTERNAL, 'other:food:apple', {
  name: 'Apple',
  category: 'food',
  contexts: ['cross-game'],
  topics: ['edible'],
});

const all = [carrot, hoe, stranger];

describe('search', () => {
  it('matches on name, d and address', () => {
    expect(applyFilters(all, { ...blankFilters(), search: 'carrot' })).toEqual([carrot]);
    expect(applyFilters(all, { ...blankFilters(), search: 'farm:tool' })).toEqual([hoe]);
    expect(applyFilters(all, { ...blankFilters(), search: EXTERNAL.slice(0, 10) })).toEqual([stranger]);
  });

  it('is case-insensitive and matches everything when blank', () => {
    expect(applyFilters(all, { ...blankFilters(), search: 'CARROT' })).toEqual([carrot]);
    expect(applyFilters(all, blankFilters())).toHaveLength(3);
  });
});

describe('issuer scope', () => {
  it('shows only official Farm items', () => {
    expect(applyFilters(all, { ...blankFilters(), issuer: 'official' })).toEqual([carrot, hoe]);
  });

  it('shows only external items', () => {
    expect(applyFilters(all, { ...blankFilters(), issuer: 'external' })).toEqual([stranger]);
  });

  it('filters by a specific issuer prefix', () => {
    expect(applyFilters(all, { ...blankFilters(), issuerQuery: EXTERNAL.slice(0, 8) })).toEqual([stranger]);
    expect(applyFilters(all, { ...blankFilters(), issuerQuery: 'ffff' })).toEqual([]);
  });
});

describe('facet filters', () => {
  it('filters by type, category, context and topic', () => {
    expect(applyFilters(all, { ...blankFilters(), type: 'tool' })).toEqual([hoe]);
    expect(applyFilters(all, { ...blankFilters(), category: 'food' })).toEqual([carrot, stranger]);
    expect(applyFilters(all, { ...blankFilters(), context: 'game:farm' })).toEqual([carrot]);
    expect(applyFilters(all, { ...blankFilters(), topic: 'edible' })).toEqual([carrot, stranger]);
  });

  it('combines filters as an intersection', () => {
    expect(applyFilters(all, { ...blankFilters(), topic: 'edible', issuer: 'official' })).toEqual([carrot]);
  });

  it('collects distinct facet values for the dropdowns', () => {
    expect(facetValues(all, 'type')).toEqual(['consumable', 'tool']);
    expect(facetValues(all, 'category')).toEqual(['food', 'tool']);
    expect(facetValues(all, 'context')).toEqual(['cross-game', 'game:farm']);
    expect(facetValues(all, 'topic')).toEqual(['edible', 'tool', 'vegetable']);
  });
});

describe('display order', () => {
  it('puts official items first, then sorts by name', () => {
    expect(sortForDisplay([stranger, hoe, carrot]).map((i) => i.name)).toEqual(['Carrot', 'Hoe', 'Apple']);
  });

  it('does not mutate its input', () => {
    const input = [stranger, carrot];
    sortForDisplay(input);
    expect(input).toEqual([stranger, carrot]);
  });
});

describe('same d under two issuers', () => {
  it('keeps them as two distinct items', () => {
    const mine = item(FARM_OFFICIAL_ISSUER_PUBKEY, 'shared:d');
    const theirs = item(EXTERNAL, 'shared:d');

    expect(mine.address).not.toBe(theirs.address);
    expect(matchesFilters(mine, { ...blankFilters(), issuer: 'official' })).toBe(true);
    expect(matchesFilters(theirs, { ...blankFilters(), issuer: 'official' })).toBe(false);
    expect(applyFilters([mine, theirs], { ...blankFilters(), search: 'shared:d' })).toHaveLength(2);
  });
});

describe('editable-by-me scope', () => {
  it('selects items the signer issued, whatever their official status', () => {
    // The signer here IS the Farm issuer, so both official items match.
    expect(applyFilters(all, { ...blankFilters(), issuer: 'mine' }, { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY })).toEqual([
      carrot,
      hoe,
    ]);
  });

  it('is about the signer, not about being an official Farm item', () => {
    // A signer who is NOT the Farm issuer sees only their own external item.
    const mine = applyFilters(all, { ...blankFilters(), issuer: 'mine' }, { signerPubkey: EXTERNAL });
    expect(mine).toEqual([stranger]);

    // ...which the official filter excludes, and the external filter includes.
    expect(applyFilters(mine, { ...blankFilters(), issuer: 'official' })).toEqual([]);
    expect(applyFilters(mine, { ...blankFilters(), issuer: 'external' })).toEqual([stranger]);
  });

  it('matches nothing when signed out', () => {
    expect(applyFilters(all, { ...blankFilters(), issuer: 'mine' }, { signerPubkey: null })).toEqual([]);
    expect(applyFilters(all, { ...blankFilters(), issuer: 'mine' })).toEqual([]);
  });

  it('combines with the other filters', () => {
    expect(
      applyFilters(all, { ...blankFilters(), issuer: 'mine', type: 'tool' }, { signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY })
    ).toEqual([hoe]);
  });

  it('agrees with the per-row edit affordance', () => {
    for (const item of all) {
      const editableByFarm = matchesFilters(item, { ...blankFilters(), issuer: 'mine' }, {
        signerPubkey: FARM_OFFICIAL_ISSUER_PUBKEY,
      });
      expect(editableByFarm).toBe(item.issuer === FARM_OFFICIAL_ISSUER_PUBKEY);
    }
  });
});

describe('countEditable', () => {
  it('counts only the signer own items', () => {
    expect(countEditable(all, FARM_OFFICIAL_ISSUER_PUBKEY)).toBe(2);
    expect(countEditable(all, EXTERNAL)).toBe(1);
    expect(countEditable(all, null)).toBe(0);
  });
});
