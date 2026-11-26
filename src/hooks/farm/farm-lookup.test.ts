import { describe, expect, it } from 'vitest';
import type { NostrFilter } from '@nostrify/nostrify';

import { KIND_MAP_STATE, KIND_WORLD_STATE } from '@/nostr/kinds';
import { readFromRelays } from '@/nostr/query';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { FARM_OWNER, mapEvent, worldEvent } from '@/test/farm-fixtures';
import { lookupFarm, type FarmLookupDeps } from './farm-lookup';

const A = 'wss://a.example';
const B = 'wss://b.example';

/** Production wiring minus the clock: real multi-relay reads over the fake network, no pause. */
function harness(network: FakeRelayNetwork, relays = [A, B]) {
  const reads: NostrFilter[][] = [];
  let waits = 0;
  const deps: FarmLookupDeps = {
    ownerPubkey: FARM_OWNER,
    read: (filters) => {
      reads.push(filters);
      return readFromRelays(network.pool, relays, filters, { timeoutMs: 50 });
    },
    wait: async () => {
      waits += 1;
    },
  };
  const kinds = () => reads.map((filters) => filters[0].kinds?.[0]);
  return { deps, reads, kinds, waits: () => waits };
}

describe('lookupFarm', () => {
  it('finds an existing farm from one completed read of each kind', async () => {
    const network = new FakeRelayNetwork();
    network.seed(worldEvent({ name: 'Willow Patch' }), mapEvent());
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.farm.world.name).toBe('Willow Patch');
    expect(lookup.farm.map.id).toBe('farm.field');
    expect(lookup.farm.definition.id).toBe('farm.field');
    expect(h.kinds()).toEqual([KIND_WORLD_STATE, KIND_MAP_STATE]);
    expect(h.waits()).toBe(0);
  });

  it('confirms absence only after every relay said EOSE twice, with a pause between', async () => {
    const network = new FakeRelayNetwork();
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup).toEqual({ status: 'absent' });
    expect(h.kinds()).toEqual([KIND_WORLD_STATE, KIND_WORLD_STATE]);
    expect(h.waits()).toBe(1);
  });

  it('never treats a relay that closed before EOSE as an empty one', async () => {
    const network = new FakeRelayNetwork();
    network.closeBeforeEose(A);
    network.closeBeforeEose(B);
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup.status).toBe('unknown');
    if (lookup.status !== 'unknown') return;
    expect(lookup.reason).toBe('unreachable');
    expect(lookup.detail).toContain('closed');
    // It did not bother re-reading: nothing it saw was worth confirming.
    expect(h.reads).toHaveLength(1);
  });

  it('still finds a farm whose events arrived before the relay cut the stream off', async () => {
    const network = new FakeRelayNetwork();
    network.seed(worldEvent(), mapEvent());
    network.closeBeforeEose(A);
    network.closeBeforeEose(B);
    const h = harness(network);

    // An incomplete read can prove presence; only absence needs EOSE.
    expect((await lookupFarm(h.deps)).status).toBe('found');
  });

  it('never treats a timeout as absence', async () => {
    const network = new FakeRelayNetwork();
    network.silence(A);
    network.silence(B);
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup).toMatchObject({ status: 'unknown', reason: 'unreachable' });
    if (lookup.status === 'unknown') expect(lookup.detail).toContain('timeout');
  });

  it('is unknown, not absent, when one relay finished empty and the other did not finish at all', async () => {
    const network = new FakeRelayNetwork();
    network.closeBeforeEose(B);
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup).toMatchObject({ status: 'unknown', reason: 'partial' });
  });

  it('is unknown when the only relay errors', async () => {
    const network = new FakeRelayNetwork();
    network.failRelay(A, new Error('connection refused'));
    const h = harness(network, [A]);

    const lookup = await lookupFarm(h.deps);

    expect(lookup).toMatchObject({ status: 'unknown', reason: 'unreachable' });
    if (lookup.status === 'unknown') expect(lookup.detail).toContain('connection refused');
  });

  it('finds the farm when only one relay holds it and both finished', async () => {
    const network = new FakeRelayNetwork();
    const world = worldEvent();
    const map = mapEvent();
    network.seed(world, map);
    network.withhold(B, world.id, map.id);
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup.status).toBe('found');
  });

  it('finds a farm that appears on the confirming read', async () => {
    const network = new FakeRelayNetwork();
    const h = harness(network);
    h.deps.wait = async () => {
      network.seed(worldEvent(), mapEvent());
    };

    const lookup = await lookupFarm(h.deps);

    expect(lookup.status).toBe('found');
    expect(h.kinds()).toEqual([KIND_WORLD_STATE, KIND_WORLD_STATE, KIND_MAP_STATE]);
  });

  it('reports a world without a field as field-missing, after confirming the field is absent', async () => {
    const network = new FakeRelayNetwork();
    network.seed(worldEvent({ name: 'Willow Patch' }));
    const h = harness(network);

    const lookup = await lookupFarm(h.deps);

    expect(lookup.status).toBe('field-missing');
    if (lookup.status !== 'field-missing') return;
    expect(lookup.world.name).toBe('Willow Patch');
    expect(h.kinds()).toEqual([KIND_WORLD_STATE, KIND_MAP_STATE, KIND_MAP_STATE]);
    expect(h.waits()).toBe(1);
  });

  it('is unknown, never field-missing, when the map read did not complete', async () => {
    const network = new FakeRelayNetwork();
    const world = worldEvent();
    network.seed(world);
    const h = harness(network);
    let calls = 0;
    const read = h.deps.read;
    h.deps.read = (filters) => {
      calls += 1;
      if (calls === 2) network.closeBeforeEose(B);
      return read(filters);
    };

    const lookup = await lookupFarm(h.deps);

    expect(lookup).toMatchObject({ status: 'unknown', reason: 'partial' });
  });

  it('ignores worlds and maps signed by anybody but the owner', async () => {
    const network = new FakeRelayNetwork();
    network.seed(worldEvent({ owner: 'b'.repeat(64) }), mapEvent({ owner: 'b'.repeat(64) }));
    const h = harness(network);

    expect(await lookupFarm(h.deps)).toEqual({ status: 'absent' });
  });

  it('throws, rather than reporting absence, for a map whose definition this build does not know', async () => {
    const network = new FakeRelayNetwork();
    const map = mapEvent();
    map.tags = map.tags.map((tag) => (tag[0] === 'map_def' ? ['map_def', 'moon.base'] : tag));
    network.seed(worldEvent(), map);
    const h = harness(network);

    await expect(lookupFarm(h.deps)).rejects.toThrow(/unknown map definition "moon.base"/);
  });
});
