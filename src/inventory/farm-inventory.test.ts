import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { KIND_GAME_INVENTORY, parseGameInventory, type GameInventory } from './package';
import { FARM_OFFICIAL_ISSUER_PUBKEY, FARM_GAME_CONTEXT } from './constants';
import { PRODUCE_CATALOG } from './produce-catalog';
import {
  FARM_HARVEST_MARKER,
  FARM_HARVEST_RECORD_TAG,
  FARM_INVENTORY_D,
  MAX_LEGACY_HARVEST_MARKERS,
  buildCreditEvent,
  harvestRecords,
  harvestedEventIds,
  isHarvestCredited,
  retainFarmTags,
  nextCreatedAt,
  produceQuantity,
  selectNewestInventory,
  emptyFarmInventory,
  farmInventoryAddress,
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

describe('fold reference', () => {
  const base = parse(
    signed({
      kind: KIND_GAME_INVENTORY,
      content: '',
      tags: [
        ['d', FARM_INVENTORY_D],
        ['revision', '3'],
        ['a', PUMPKIN.address, PUMPKIN.relayHint, '2'],
        ['e', 'aa'.repeat(32), 'wss://relay.primal.net', 'fold'],
        ['e', PLANT_EVENT, GAME_RELAY, FARM_HARVEST_MARKER],
      ],
    })
  );

  it('keeps the base fold reference when nothing new was settled', () => {
    const next = signed(buildCreditEvent({ base, produce: CARROT, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY }));
    expect(next.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'fold')).toEqual([
      ['e', 'aa'.repeat(32), 'wss://relay.primal.net', 'fold'],
    ]);
    expect(parse(next).fold).toEqual({ eventId: 'aa'.repeat(32), relay: 'wss://relay.primal.net' });
  });

  it('replaces it with the new manifest when one was published, keeping exactly one', () => {
    const next = signed(
      buildCreditEvent({
        base,
        produce: CARROT,
        consumedEventId: 'd'.repeat(64),
        consumedEventRelay: GAME_RELAY,
        fold: { eventId: 'bb'.repeat(32), relay: 'wss://relay.ditto.pub' },
      })
    );
    expect(next.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'fold')).toEqual([
      ['e', 'bb'.repeat(32), 'wss://relay.ditto.pub', 'fold'],
    ]);
    // The harvest marker and the revision survive alongside it.
    expect(harvestedEventIds(parse(next))).toEqual([PLANT_EVENT, 'd'.repeat(64)]);
    expect(parse(next).revision).toBe(4);
  });

  it('a first inventory can reference a manifest too', () => {
    const next = parse(
      signed(
        buildCreditEvent({
          base: null,
          produce: CARROT,
          consumedEventId: PLANT_EVENT,
          consumedEventRelay: GAME_RELAY,
          fold: { eventId: 'bb'.repeat(32), relay: '' },
        })
      )
    );
    expect(next.fold).toEqual({ eventId: 'bb'.repeat(32), relay: '' });
    expect(next.revision).toBe(1);
  });
});

describe('the empty base', () => {
  it('is the owner\'s farm:main with nothing in it', () => {
    const empty = emptyFarmInventory(OWNER);
    expect(empty.address).toBe(farmInventoryAddress(OWNER));
    expect(empty.owner).toBe(OWNER);
    expect(empty.items).toEqual([]);
    expect(empty.contexts).toEqual([FARM_GAME_CONTEXT]);
    expect(empty.fold).toBeUndefined();
    expect(empty.revision).toBeUndefined();
    expect(harvestedEventIds(empty)).toEqual([]);
  });

  it('names the inventory by the full address, never by d alone', () => {
    expect(farmInventoryAddress(OWNER)).toBe(`31633:${OWNER}:farm:main`);
  });
});

describe('per-plot harvest records', () => {
  const PLOT = 'slot:farm.field:3:2';
  const OTHER_PLOT = 'slot:farm.field:0:0';
  const planting = (plantedAt: number, slotD = PLOT) => ({ slotD, plantedAt });
  const records = (tags: string[][]) => tags.filter(([t]) => t === FARM_HARVEST_RECORD_TAG);

  it('writes the planting as a record next to the event marker', () => {
    const first = buildCreditEvent({ base: null, produce: CARROT, consumedEventId: PLANT_EVENT, consumedEventRelay: GAME_RELAY, planting: planting(100) });
    expect(records(first.tags)).toEqual([[FARM_HARVEST_RECORD_TAG, PLOT, '100']]);
    expect(harvestRecords(parse(signed(first)))).toEqual(new Map([[PLOT, 100]]));
  });

  it('keeps one record per plot, replacing the plot\'s older one and keeping every other plot\'s', () => {
    let base = parse(signed(buildCreditEvent({ base: null, produce: CARROT, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY, planting: planting(100) })));
    base = parse(signed(buildCreditEvent({ base, produce: PUMPKIN, consumedEventId: 'e'.repeat(64), consumedEventRelay: GAME_RELAY, planting: planting(50, OTHER_PLOT) }), 1_700_000_001));
    const next = parse(signed(buildCreditEvent({ base, produce: CARROT, consumedEventId: 'f'.repeat(64), consumedEventRelay: GAME_RELAY, planting: planting(900) }), 1_700_000_002));

    expect(harvestRecords(next)).toEqual(new Map([[OTHER_PLOT, 50], [PLOT, 900]]));
    expect(records(next.event.tags)).toHaveLength(2);
    expect(produceQuantity(next, CARROT.address)).toBe(2);
    expect(produceQuantity(next, PUMPKIN.address)).toBe(1);
  });

  it('answers "credited" for the same planting under any event id, and for older cycles of the plot', () => {
    const inv = parse(signed(buildCreditEvent({ base: null, produce: CARROT, consumedEventId: PLANT_EVENT, consumedEventRelay: GAME_RELAY, planting: planting(500) })));

    // Same planting, seen through a later watering's event id.
    expect(isHarvestCredited(inv, { consumedEventId: 'e'.repeat(64), planting: planting(500) })).toBe(true);
    // An older cycle of the plot that resurfaced.
    expect(isHarvestCredited(inv, { consumedEventId: 'e'.repeat(64), planting: planting(499) })).toBe(true);
    // The next cycle of the plot: not credited yet.
    expect(isHarvestCredited(inv, { consumedEventId: 'e'.repeat(64), planting: planting(501) })).toBe(false);
    // A different plot: not credited.
    expect(isHarvestCredited(inv, { consumedEventId: 'e'.repeat(64), planting: planting(500, OTHER_PLOT) })).toBe(false);
    // The legacy check still answers by id alone.
    expect(isHarvestCredited(inv, PLANT_EVENT)).toBe(true);
    expect(isHarvestCredited(inv, { consumedEventId: PLANT_EVENT })).toBe(true);
  });

  it('a legacy snapshot with markers and no records still answers by id, and never by record', () => {
    const legacy = parse(signed(firstCredit()));
    expect(harvestRecords(legacy).size).toBe(0);
    expect(isHarvestCredited(legacy, { consumedEventId: PLANT_EVENT, planting: planting(1) })).toBe(true);
    expect(isHarvestCredited(legacy, { consumedEventId: 'e'.repeat(64), planting: planting(1) })).toBe(false);
  });

  it('ignores malformed records rather than trusting them', () => {
    const inv = parse(
      signed(
        buildCreditEvent({
          base: parse(signed(firstCredit())),
          produce: CARROT,
          consumedEventId: 'd'.repeat(64),
          consumedEventRelay: GAME_RELAY,
        })
      )
    );
    const tampered = parse({
      ...(inv.event as NostrEvent),
      tags: [...inv.event.tags, [FARM_HARVEST_RECORD_TAG, '', '5'], [FARM_HARVEST_RECORD_TAG, PLOT, 'soon'], [FARM_HARVEST_RECORD_TAG, PLOT, '-1'], [FARM_HARVEST_RECORD_TAG, PLOT]],
    });
    expect(harvestRecords(tampered).size).toBe(0);
  });

  it('never drops a record because of its age', () => {
    let base = parse(signed(buildCreditEvent({ base: null, produce: CARROT, consumedEventId: 'a'.repeat(64), consumedEventRelay: GAME_RELAY, planting: planting(1, OTHER_PLOT) })));
    for (let i = 0; i < 300; i += 1) {
      const id = i.toString(16).padStart(64, '0');
      base = parse(signed(buildCreditEvent({ base, produce: CARROT, consumedEventId: id, consumedEventRelay: GAME_RELAY, planting: planting(1000 + i), liveSlotEventIds: [] }), 1_700_000_001 + i));
    }
    expect(harvestRecords(base).get(OTHER_PLOT)).toBe(1);
    expect(harvestRecords(base).get(PLOT)).toBe(1299);
    expect(records(base.event.tags)).toHaveLength(2);
  });
});

describe('legacy marker retention', () => {
  const PLOT = 'slot:farm.field:3:2';
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(8, '0').padEnd(64, 'f'));
  const markerTags = (eventIds: string[]) => eventIds.map((id) => ['e', id, GAME_RELAY, FARM_HARVEST_MARKER]);

  it('drops nothing when no live-id list is supplied', () => {
    const tags = markerTags(ids(200));
    expect(retainFarmTags(tags, {})).toEqual(tags);
  });

  it('keeps the newest window and every marker whose event still holds a plot', () => {
    const all = ids(200);
    const stillLive = [all[3], all[77]];
    const kept = retainFarmTags(markerTags(all), { liveSlotEventIds: stillLive }).map((t) => t[1]);

    expect(kept).toHaveLength(MAX_LEGACY_HARVEST_MARKERS - 1 + stillLive.length);
    expect(kept.slice(-(MAX_LEGACY_HARVEST_MARKERS - 1))).toEqual(all.slice(-(MAX_LEGACY_HARVEST_MARKERS - 1)));
    expect(kept).toContain(all[3]);
    expect(kept).toContain(all[77]);
    expect(kept).not.toContain(all[4]);
    // Original order is preserved.
    expect(kept).toEqual(all.filter((id) => kept.includes(id)));
  });

  it('leaves tags that are not the Farm\'s untouched, in place', () => {
    const foreign = [['t', 'hello'], ['p', 'b'.repeat(64)], ['e', 'c'.repeat(64), '', 'mention']];
    const tags = [foreign[0], ...markerTags(ids(100)), foreign[1], foreign[2]];
    const kept = retainFarmTags(tags, { liveSlotEventIds: [] });
    expect(kept[0]).toEqual(foreign[0]);
    expect(kept.slice(-2)).toEqual([foreign[1], foreign[2]]);
    expect(kept.filter((t) => t[3] === FARM_HARVEST_MARKER)).toHaveLength(MAX_LEGACY_HARVEST_MARKERS - 1);
  });

  it('a snapshot with thousands of old markers is rebuilt bounded, with every quantity intact', () => {
    const old = ids(3000);
    const base = parse(
      signed({
        ...firstCredit(),
        tags: [...firstCredit().tags.filter((t) => !(t[0] === 'e' && t[3] === FARM_HARVEST_MARKER)), ...markerTags(old)],
      })
    );
    expect(harvestedEventIds(base)).toHaveLength(3000);

    const next = parse(
      signed(
        buildCreditEvent({ base, produce: PUMPKIN, consumedEventId: 'd'.repeat(64), consumedEventRelay: GAME_RELAY, planting: { slotD: PLOT, plantedAt: 7 }, liveSlotEventIds: [old[0]] }),
        1_700_000_001
      )
    );
    expect(harvestedEventIds(next)).toHaveLength(MAX_LEGACY_HARVEST_MARKERS + 1);
    expect(harvestedEventIds(next)).toContain(old[0]);
    expect(harvestedEventIds(next).at(-1)).toBe('d'.repeat(64));
    expect(produceQuantity(next, CARROT.address)).toBe(1);
    expect(produceQuantity(next, PUMPKIN.address)).toBe(1);
    expect(harvestRecords(next)).toEqual(new Map([[PLOT, 7]]));
  });
});
