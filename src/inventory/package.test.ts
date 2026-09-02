import { describe, expect, it } from 'vitest';

import {
  KIND_GAME_ITEM_DEFINITION,
  buildGameItemDefinitionFilter,
  type BuildGameItemDefinitionFilterOptions,
  type GameItemDefinitionFilter,
} from './package';

/**
 * The kind:31632 filter comes from `@nostr-games/inventory`; the Farm carries
 * no copy of it. These tests exercise it through the boundary re-export — the
 * only path any Farm module is allowed to use — so they fail if the boundary
 * ever stops exposing it or starts exposing something else.
 */

const AUTHOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('kind:31632 filter', () => {
  it('always targets kind 31632 and nothing else', () => {
    const filter = buildGameItemDefinitionFilter();
    expect(filter.kinds).toEqual([KIND_GAME_ITEM_DEFINITION]);
    expect(filter.kinds).toEqual([31632]);
    expect(Object.keys(filter)).toEqual(['kinds']);
  });

  it('scopes by authors', () => {
    expect(buildGameItemDefinitionFilter({ authors: [AUTHOR] })).toEqual({
      kinds: [31632],
      authors: [AUTHOR],
    });
  });

  it('scopes by item ids on the #d tag', () => {
    expect(buildGameItemDefinitionFilter({ itemIds: ['farm:produce:carrot'] })).toEqual({
      kinds: [31632],
      '#d': ['farm:produce:carrot'],
    });
  });

  it('scopes by topics on the #t tag', () => {
    expect(buildGameItemDefinitionFilter({ topics: ['edible'] })).toEqual({
      kinds: [31632],
      '#t': ['edible'],
    });
  });

  it('combines every scope in one filter', () => {
    expect(
      buildGameItemDefinitionFilter({ authors: [AUTHOR], itemIds: ['farm:produce:carrot'], topics: ['edible'] })
    ).toEqual({
      kinds: [31632],
      authors: [AUTHOR],
      '#d': ['farm:produce:carrot'],
      '#t': ['edible'],
    });
  });
});

describe('value handling', () => {
  it('removes duplicates while keeping first-seen order', () => {
    expect(buildGameItemDefinitionFilter({ authors: [AUTHOR, AUTHOR, OTHER] }).authors).toEqual([AUTHOR, OTHER]);
  });

  it('drops blank and whitespace-only values', () => {
    expect(buildGameItemDefinitionFilter({ authors: [AUTHOR, '', '   '] }).authors).toEqual([AUTHOR]);
  });

  it('omits a key entirely rather than emitting an empty array', () => {
    const filter = buildGameItemDefinitionFilter({ authors: [], itemIds: ['  '], topics: undefined });
    expect(filter).toEqual({ kinds: [31632] });
    expect(filter).not.toHaveProperty('authors');
    expect(filter).not.toHaveProperty('#d');
    expect(filter).not.toHaveProperty('#t');
  });

  it('treats an absent options object as no scoping', () => {
    expect(buildGameItemDefinitionFilter()).toEqual(buildGameItemDefinitionFilter({}));
  });
});

describe('boundary surface', () => {
  it('re-exports the filter types the Farm builds against', () => {
    // Compile-time assertions: these fail the typecheck if the boundary stops
    // exporting the package's types.
    const options: BuildGameItemDefinitionFilterOptions = { authors: [AUTHOR], itemIds: ['d'], topics: ['t'] };
    const filter: GameItemDefinitionFilter = buildGameItemDefinitionFilter(options);
    expect(filter.kinds).toEqual([31632]);
  });
});
