import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// This file is on the boundary allowlist, so it may import the package
// directly — which is what lets it prove the re-export IS the package.
import * as protocolPackage from '@nostr-games/inventory';

import * as boundary from './package';
import { FARM_INVENTORY_CONTEXT, INVENTORY_KINDS } from './package';

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
  });
}

/** Comments may name the package and explain the boundary; code may not cross it. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('inventory boundary', () => {
  it('confines the protocol package to src/inventory/package.ts', () => {
    const allowed = [join('inventory', 'package.ts'), join('inventory', 'boundary.test.ts')];
    const offenders = walk(SRC)
      .filter((f) => !allowed.some((a) => f.endsWith(a)))
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes('@nostr-games/inventory'));

    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it('re-exports the package implementations rather than local copies', () => {
    // Identity, not shape: a local re-implementation with the same behaviour
    // would pass a behavioural test and fail this one.
    expect(boundary.buildGameItemDefinitionFilter).toBe(protocolPackage.buildGameItemDefinitionFilter);
    expect(boundary.buildGameItemDefinitionEvent).toBe(protocolPackage.buildGameItemDefinitionEvent);
    expect(boundary.parseGameItemDefinitionResult).toBe(protocolPackage.parseGameItemDefinitionResult);
    expect(boundary.getPrimaryItemImage).toBe(protocolPackage.getPrimaryItemImage);
    expect(boundary.buildGameItemAddress).toBe(protocolPackage.buildGameItemAddress);
    expect(boundary.validateGameItemDefinition).toBe(protocolPackage.validateGameItemDefinition);
  });

  it('routes every registry module through the boundary re-export', () => {
    const registryFiles = walk(join(SRC, 'inventory', 'registry')).concat(walk(join(SRC, 'hooks', 'items')));
    expect(registryFiles.length).toBeGreaterThan(3);

    // Importing `@/inventory/package` is the sanctioned path; importing the npm
    // package directly is what the assertion above forbids.
    for (const file of registryFiles) {
      expect(stripComments(readFileSync(file, 'utf8'))).not.toContain('@nostr-games/inventory');
    }
  });

  it('keeps the farm domain free of any inventory code', () => {
    const offenders = walk(join(SRC, 'farm')).filter((f) => /inventor/i.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it('writes to its own context and never another game\'s', () => {
    expect(FARM_INVENTORY_CONTEXT).toBe('farm:main');
  });

  it('records the protocol kinds', () => {
    expect(INVENTORY_KINDS).toEqual({ itemDefinition: 31632, inventory: 31633, placement: 31634, spend: 1416, fold: 1417 });
  });
});
