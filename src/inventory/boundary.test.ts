import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNullInventoryAdapter } from './adapter';
import { FARM_INVENTORY_CONTEXT, INVENTORY_KINDS, inventoryPackageStatus } from './package';

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
    expect(createNullInventoryAdapter().context).toBe('farm:main');
  });

  it('records the protocol kinds', () => {
    expect(INVENTORY_KINDS).toEqual({ itemDefinition: 31632, inventory: 31633, placement: 31634 });
  });

  it('reports the protocol package as installed now that the registry uses it', () => {
    expect(inventoryPackageStatus().installed).toBe(true);
  });

  it('credits nothing in V1, so harvesting cannot silently publish', async () => {
    // The package is installed for kind:31632, but kind:31633 inventory writes
    // remain a separate milestone. Harvesting must not start publishing just
    // because the dependency arrived.
    const adapter = createNullInventoryAdapter();
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.credit({ cropId: 'carrot', quantity: 1, harvestedAt: 0, growthSec: 900 })).resolves.toBeNull();
  });
});
