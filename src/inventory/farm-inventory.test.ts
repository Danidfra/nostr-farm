import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { KIND_GAME_INVENTORY, parseGameInventory, type GameInventory } from './package';
import { FARM_OFFICIAL_ISSUER_PUBKEY, FARM_GAME_CONTEXT } from './constants';
import { PRODUCE_CATALOG } from './produce-catalog';
import {
  FARM_HARVEST_MARKER,
  FARM_INVENTORY_D,
  buildCreditEvent,
  harvestedEventIds,
  isHarvestCredited,
  nextCreatedAt,
  produceQuantity,
  selectNewestInventory,
} from './farm-inventory';

const OWNER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const CARROT = PRODUCE_CATALOG.carrot;
const PUMPKIN = PRODUCE_CATALOG.pumpkin;
const PLANT_EVENT = 'c'.repeat(64);
const GAME_RELAY = 'wss://relay.primal.net';

function signed(template: { kind: number; content: string; tags: string[][] }, createdAt = 1_700_000_000, pubkey = OWNER): NostrEvent {
  return { ...template, id: `${createdAt}`.padEnd(64, '0'), pubkey, created_at: createdAt, sig: 'x'.repeat(128) };
}

function parse(event: NostrEvent): GameInventory {
  const parsed = parseGameInventory(event, { mode: 'permissive' });
  if (!parsed) throw new Error('inventory did not parse');
  return parsed;
}

const firstCredit = () =>
  buildCreditEvent({ base: null, produce: CARROT, consumedEventId: PLANT_EVENT, consumedEventRelay: GAME_RELAY });

const tagsNamed = (tags: string[][], name: string) => tags.filter(([tag]) => tag === name);

describe('creating the first farm:main', () => {
  const template = firstCredit();

  it('is a kind:31633 for the farm:main context with empty content', () => {
    expect(template.kind).toBe(KIND_GAME_INVENTORY);
    expect(template.content).toBe('');
    expect(tagsNamed(template.tags, 'd')).toEqual([['d', FARM_INVENTORY_D]]);
    expect(FARM_INVENTORY_D).toBe('farm:main');
  });

  it('starts at revision 1', () => {
    expect(tagsNamed(template.tags, 'revision')).toEqual([['revision', '1']]);
  });

  it('declares the game:farm context and nothing else', () => {
    expect(tagsNamed(template.tags, 'context')).toEqual([['context', FARM_GAME_CONTEXT]]);
  });

  it('credits one unit at the full official address, with a relay hint', () => {
    expect(tagsNamed(template.tags, 'a')).toEqual([['a', CARROT.address, CARROT.relayHint, '1']]);
    expect(CARROT.address).toContain(FARM_OFFICIAL_ISSUER_PUBKEY);
  });

  it('records the consumed plant event with the farm-harvest marker', () => {
    expect(tagsNamed(template.tags, 'e')).toEqual([['e', PLANT_EVENT, GAME_RELAY, FARM_HARVEST_MARKER]]);
  });

  it('never uses the grant marker', () => {
    expect(JSON.stringify(template.tags)).not.toContain('"grant"');
  });

  it('carries no name and no alt', () => {
    expect(tagsNamed(template.tags, 'name')).toEqual([]);
    expect(tagsNamed(template.tags, 'alt')).toEqual([]);
  });
});

describe('crediting an existing inventory', () => {
  const base = parse(signed(firstCredit()));

  it('increments the same item rather than adding a second entry', () => {
    const next = parse(
      signed(buildCreditEvent({ base, produce: CARROT, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY }))
    );

    expect(produceQuantity(next, CARROT.address)).toBe(2);
    expect(next.items.filter((item) => item.address === CARROT.address)).toHaveLength(1);
  });

  it('leaves other items untouched', () => {
    const withPumpkin = parse(
      signed(buildCreditEvent({ base, produce: PUMPKIN, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY }))
    );
    const next = parse(
      signed(buildCreditEvent({ base: withPumpkin, produce: CARROT, consumedEventId: 'e'.repeat(64), consumedEventRelay: GAME_RELAY }))
    );

    expect(produceQuantity(next, CARROT.address)).toBe(2);
    expect(produceQuantity(next, PUMPKIN.address)).toBe(1);
  });

  it('increments the revision', () => {
    const next = buildCreditEvent({ base, produce: CARROT, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY });
    expect(tagsNamed(next.tags, 'revision')).toEqual([['revision', '2']]);
  });

  it('appends exactly one marker and keeps the earlier ones', () => {
    const second = 'd'.repeat(64);
    const next = parse(signed(buildCreditEvent({ base, produce: CARROT, consumedEventId: second, consumedEventRelay: GAME_RELAY })));

    expect(harvestedEventIds(next)).toEqual([PLANT_EVENT, second]);
    expect(next.event.tags.filter((tag) => tag[1] === second)).toHaveLength(1);
  });
});

describe('lossless rebuild', () => {
  /** An inventory another client wrote, with data this app does not model. */
  const foreign = parse(
    signed({
      kind: KIND_GAME_INVENTORY,
      content: '{"note":"written by another client","nested":{"keep":true}}',
      tags: [
        ['d', FARM_INVENTORY_D],
        ['revision', '7'],
        ['context', FARM_GAME_CONTEXT],
        ['context', 'cross-game'],
        ['name', 'Someone else set this'],
        ['a', PUMPKIN.address, PUMPKIN.relayHint, '4'],
        ['a', `31632:${STRANGER}:other:thing`, '', '9'],
        ['e', PLANT_EVENT, GAME_RELAY, FARM_HARVEST_MARKER],
        ['e', 'f'.repeat(64), '', 'some-other-marker'],
        ['future_tag', 'keep-me'],
      ],
    })
  );

  const next = parse(
    signed(buildCreditEvent({ base: foreign, produce: CARROT, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY }), 1_700_000_100)
  );

  it('preserves unrelated item quantities, including other issuers', () => {
    expect(produceQuantity(next, PUMPKIN.address)).toBe(4);
    expect(produceQuantity(next, `31632:${STRANGER}:other:thing`)).toBe(9);
    expect(produceQuantity(next, CARROT.address)).toBe(1);
  });

  it('preserves content byte for byte', () => {
    expect(next.content).toBe(foreign.content);
  });

  it('preserves every context and the name', () => {
    expect(next.contexts).toEqual(['game:farm', 'cross-game']);
    expect(next.name).toBe('Someone else set this');
  });

  it('preserves unknown tags', () => {
    expect(next.event.tags).toContainEqual(['future_tag', 'keep-me']);
  });

  it('preserves e tags carrying other markers', () => {
    expect(next.event.tags).toContainEqual(['e', 'f'.repeat(64), '', 'some-other-marker']);
  });

  it('preserves earlier harvest markers and adds the new one', () => {
    expect(harvestedEventIds(next)).toEqual([PLANT_EVENT, 'd'.repeat(64)]);
  });

  it('bumps the revision from the base', () => {
    expect(next.revision).toBe(8);
  });
});

describe('idempotency marker', () => {
  const base = parse(signed(firstCredit()));

  it('recognises a plant event that was already credited', () => {
    expect(isHarvestCredited(base, PLANT_EVENT)).toBe(true);
  });

  it('does not recognise a different plant event', () => {
    expect(isHarvestCredited(base, 'd'.repeat(64))).toBe(false);
  });

  it('treats a missing inventory as nothing credited', () => {
    expect(isHarvestCredited(null, PLANT_EVENT)).toBe(false);
    expect(harvestedEventIds(null)).toEqual([]);
  });

  it('ignores e tags that are not farm-harvest markers', () => {
    const other = parse(
      signed({
        kind: KIND_GAME_INVENTORY,
        content: '',
        tags: [
          ['d', FARM_INVENTORY_D],
          ['e', PLANT_EVENT, '', 'grant'],
          ['e', PLANT_EVENT, ''],
        ],
      })
    );
    expect(isHarvestCredited(other, PLANT_EVENT)).toBe(false);
  });
});

describe('selecting the authoritative inventory', () => {
  it('picks the newest event', () => {
    const older = signed(firstCredit(), 1_700_000_000);
    const newer = signed(firstCredit(), 1_700_000_100);
    expect(selectNewestInventory([older, newer], OWNER)?.event.created_at).toBe(1_700_000_100);
    expect(selectNewestInventory([newer, older], OWNER)?.event.created_at).toBe(1_700_000_100);
  });

  it('ignores events authored by anybody else', () => {
    expect(selectNewestInventory([signed(firstCredit(), 1_700_000_000, STRANGER)], OWNER)).toBeNull();
  });

  it('ignores other inventory contexts', () => {
    const otherContext = signed({ kind: KIND_GAME_INVENTORY, content: '', tags: [['d', 'chest:barn']] });
    expect(selectNewestInventory([otherContext], OWNER)).toBeNull();
  });

  it('ignores other kinds', () => {
    expect(selectNewestInventory([{ ...signed(firstCredit()), kind: 31632 }], OWNER)).toBeNull();
  });

  it('returns null for no events', () => {
    expect(selectNewestInventory([], OWNER)).toBeNull();
  });
});

describe('created_at', () => {
  it('is strictly after the event it replaces', () => {
    const base = parse(signed(firstCredit(), 1_700_000_000));
    expect(nextCreatedAt(base, 1_700_000_000)).toBe(1_700_000_001);
    expect(nextCreatedAt(base, 1_699_999_000)).toBe(1_700_000_001);
  });

  it('uses the clock when it is already ahead', () => {
    const base = parse(signed(firstCredit(), 1_700_000_000));
    expect(nextCreatedAt(base, 1_700_000_500)).toBe(1_700_000_500);
  });

  it('uses the clock when there is no previous event', () => {
    expect(nextCreatedAt(null, 1_700_000_500)).toBe(1_700_000_500);
  });
});
