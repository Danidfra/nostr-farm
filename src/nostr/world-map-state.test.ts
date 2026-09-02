import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { buildMapState, parseMapState } from './map-state';
import { buildWorldState, parseWorldState } from './world-state';
import { RESERVED_VISITOR_ACTION_KIND_CANDIDATE } from './kinds';

const OWNER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);

function sign(template: { kind: number; content: string; tags: string[][] }, pubkey = OWNER): NostrEvent {
  return { ...template, id: '0'.repeat(64), pubkey, created_at: 1_800_000_000, sig: 'x'.repeat(128) };
}

describe('world state', () => {
  const template = buildWorldState({
    worldId: 'farm',
    name: 'My Farm',
    entryMapId: 'farm.field',
    renderpack: { id: 'cozy-pixel-v1', version: '1.0.0' },
  });

  it('round trips', () => {
    const world = parseWorldState(sign(template));
    expect(world).toMatchObject({
      id: 'farm',
      owner: OWNER,
      type: 'farm',
      name: 'My Farm',
      entryMapId: 'farm.field',
      renderpack: { id: 'cozy-pixel-v1', version: '1.0.0' },
    });
  });

  it('pins the renderpack by id and version rather than a URL', () => {
    const tagNames = template.tags.map(([name]) => name);
    expect(tagNames).toContain('renderpack');
    expect(tagNames).toContain('renderpack_version');
    expect(tagNames).not.toContain('renderpack_url');
    expect(JSON.stringify(template)).not.toContain('http');
  });

  it('rejects an id that would break slot addressing', () => {
    const bad = buildWorldState({ worldId: 'my:farm', name: 'x', entryMapId: 'farm.field', renderpack: { id: 'cozy-pixel-v1', version: '1.0.0' } });
    expect(parseWorldState(sign(bad))).toBeNull();
  });
});

describe('map state', () => {
  const template = buildMapState({
    mapId: 'farm.field',
    worldId: 'farm',
    ownerPubkey: OWNER,
    definitionId: 'farm.field',
    definitionRevision: 1,
    name: 'Farm Field',
  });

  it('round trips and resolves its parent world from the `a` tag', () => {
    expect(parseMapState(sign(template))).toMatchObject({
      id: 'farm.field',
      worldId: 'farm',
      owner: OWNER,
      definitionId: 'farm.field',
      definitionRevision: 1,
    });
  });

  it('refuses to claim a world owned by someone else', () => {
    expect(parseMapState(sign(template, STRANGER))).toBeNull();
  });

  it('names a source-controlled map definition instead of embedding a layout', () => {
    const tagNames = template.tags.map(([name]) => name);
    expect(tagNames).toContain('map_def');
    expect(tagNames).not.toContain('layout');
    expect(tagNames).not.toContain('renderpack_url');
  });
});

describe('dead kinds', () => {
  it('never uses kind 14159 outside the note recording that it is dead', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
      });

    const allowed = [join('nostr', 'kinds.ts'), join('nostr', 'world-map-state.test.ts')];
    const offenders = walk(join(process.cwd(), 'src'))
      .filter((f) => !allowed.some((a) => f.endsWith(a)))
      .filter((f) => readFileSync(f, 'utf8').includes('14159'));
    expect(offenders).toEqual([]);
  });

  it('records the reserved visitor-action candidate without implementing it', () => {
    expect(RESERVED_VISITOR_ACTION_KIND_CANDIDATE).toBe(1415);
  });
});
