import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { FARM_OFFICIAL_ISSUER_PUBKEY, ITEM_REGISTRY_RELAYS, ITEM_REGISTRY_SECONDARY_RELAYS } from '@/inventory/constants';
import { readFromRelays } from '@/nostr/query';
import { PRIMARY_RELAY_URL } from '@/nostr/relays';
import { relaySync } from '@/nostr/relay-sync';
import { FakeRelayNetwork } from '@/test/fake-relay';
import { carryOfficialDefinitions, collectDefinitions, toRelayQueryResult } from './useItemDefinitions';

/** kind:31632 over the primary relay and the cross-client ones, against in-memory relays only. */
const STRANGER = 'b'.repeat(64);
const FILTER: NostrFilter = { kinds: [31632], limit: 500 };

function definition(label: string, pubkey: string, createdAt = 1_700_000_000): NostrEvent {
  return {
    id: `def-${label}`.padEnd(64, '0'),
    pubkey,
    created_at: createdAt,
    kind: 31632,
    tags: [['d', `farm:produce:${label}`], ['name', label], ['type', 'consumable']],
    content: '',
    sig: 'x'.repeat(128),
  };
}

async function readAndCarry(network: FakeRelayNetwork, account: string | undefined = FARM_OFFICIAL_ISSUER_PUBKEY) {
  const read = await readFromRelays(network.pool, ITEM_REGISTRY_RELAYS, [FILTER], { timeoutMs: 50 });
  carryOfficialDefinitions(network.pool, account, read.reads, [FILTER]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return read;
}

describe('the registry relay table', () => {
  it('asks the primary relay first and keeps the cross-client relays', () => {
    expect(ITEM_REGISTRY_RELAYS[0]).toBe(PRIMARY_RELAY_URL);
    expect(ITEM_REGISTRY_RELAYS.slice(1)).toEqual(ITEM_REGISTRY_SECONDARY_RELAYS);
  });
});

describe('reading definitions from every registry relay', () => {
  it('lists a definition the primary relay does not hold', async () => {
    const network = new FakeRelayNetwork();
    const carrot = definition('read-carrot', FARM_OFFICIAL_ISSUER_PUBKEY);
    network.seed(carrot);
    network.withhold(PRIMARY_RELAY_URL, carrot.id);

    const read = await readFromRelays(network.pool, ITEM_REGISTRY_RELAYS, [FILTER], { timeoutMs: 50 });
    const rows = collectDefinitions(read.reads.map(toRelayQueryResult));

    expect(rows.map((row) => row.event.id)).toEqual([carrot.id]);
    expect(rows[0].relays).toEqual([...ITEM_REGISTRY_SECONDARY_RELAYS]);
  });

  it('reports a relay that closed before EOSE as a failure, not as an empty answer', async () => {
    const network = new FakeRelayNetwork();
    for (const relay of ITEM_REGISTRY_RELAYS) network.closeBeforeEose(relay);

    const read = await readFromRelays(network.pool, ITEM_REGISTRY_RELAYS, [FILTER], { timeoutMs: 50 });

    expect(() => collectDefinitions(read.reads.map(toRelayQueryResult))).toThrow(/Could not reach any registry relay/);
  });
});

describe('carrying official definitions', () => {
  const ISSUER = FARM_OFFICIAL_ISSUER_PUBKEY;
  afterEach(() => {
    relaySync.consent.disable(ISSUER);
    relaySync.consent.disable(STRANGER);
  });

  it('sends nothing while the issuer account has not turned copying on', async () => {
    const network = new FakeRelayNetwork();
    const carrot = definition('ro-carrot', ISSUER);
    network.seed(carrot);
    network.withhold(PRIMARY_RELAY_URL, carrot.id);

    await readAndCarry(network, ISSUER);

    expect(network.offers).toEqual([]);
  });

  it('sends nothing from any other account, even one that turned copying on, and nothing when signed out', async () => {
    relaySync.consent.enable(STRANGER, ITEM_REGISTRY_RELAYS);
    const network = new FakeRelayNetwork();
    const carrot = definition('other-carrot', ISSUER);
    network.seed(carrot);
    network.withhold(PRIMARY_RELAY_URL, carrot.id);

    await readAndCarry(network, STRANGER);
    await readAndCarry(network, undefined);

    expect(network.offers).toEqual([]);
  });

  it('offers an official Farm definition to the primary relay when only the cross-client relays hold it, for the issuer account that turned copying on', async () => {
    relaySync.consent.enable(ISSUER, ITEM_REGISTRY_RELAYS);
    const network = new FakeRelayNetwork();
    const carrot = definition('carry-carrot', FARM_OFFICIAL_ISSUER_PUBKEY);
    network.seed(carrot);
    network.withhold(PRIMARY_RELAY_URL, carrot.id);

    await readAndCarry(network);

    await vi.waitFor(() => expect(network.offers).toEqual([{ relay: PRIMARY_RELAY_URL, event: carrot, accepted: true }]));
  });

  it("never copies somebody else's definition anywhere", async () => {
    relaySync.consent.enable(ISSUER, ITEM_REGISTRY_RELAYS);
    relaySync.consent.enable(STRANGER, ITEM_REGISTRY_RELAYS);
    const network = new FakeRelayNetwork();
    const foreign = definition('carry-foreign', STRANGER);
    network.seed(foreign);
    network.withhold(PRIMARY_RELAY_URL, foreign.id);

    await readAndCarry(network);

    expect(network.offers).toEqual([]);
  });

  it('never pushes an official definition from the primary relay to the public cross-client relays', async () => {
    relaySync.consent.enable(ISSUER, ITEM_REGISTRY_RELAYS);
    const network = new FakeRelayNetwork();
    const pumpkin = definition('carry-pumpkin', FARM_OFFICIAL_ISSUER_PUBKEY);
    network.seed(pumpkin);
    for (const relay of ITEM_REGISTRY_SECONDARY_RELAYS) network.withhold(relay, pumpkin.id);

    await readAndCarry(network);

    expect(network.offers).toEqual([]);
  });
});
