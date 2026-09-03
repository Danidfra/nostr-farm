import { buildGameItemAddress } from './package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from './constants';

/**
 * The one mapping from a harvested crop to the official kind:31632 produce
 * definition it credits.
 *
 * WHY IT LIVES HERE. `src/farm` is the pure domain and may not know about Nostr
 * addresses — `purity.test.ts` fails the build if it learns any. So the domain
 * keeps emitting a plain `cropId` in its `HarvestResult`, and this boundary
 * module resolves that into an item address. Crop balance stays game design;
 * item identity stays protocol.
 *
 * Items are ALWAYS identified by the full `31632:<issuer>:<d>` address. A `d`
 * alone is not globally unique: two issuers using `farm:produce:carrot` are two
 * different items, and only the issuer half says whose carrot this is.
 */

export interface ProduceDefinition {
  /** The crop id the pure domain harvests. */
  cropId: string;
  /** Full `31632:<issuer>:<d>` address of the official definition. */
  address: string;
  /** The `d` of the official definition, for display and debugging only. */
  itemId: string;
  /** Display name, for harvest feedback like "+1 Carrot". */
  name: string;
  /** Short label for the compact produce counter. */
  emoji: string;
  /** A relay where the official definition is actually published. */
  relayHint: string;
}

/**
 * A relay that genuinely carries the official Farm item definitions, used as
 * the `a` tag relay hint so a foreign client can resolve what it finds.
 */
export const PRODUCE_DEFINITION_RELAY_HINT = 'wss://relay.primal.net';

function official(cropId: string, slug: string, name: string, emoji: string): ProduceDefinition {
  const itemId = `farm:produce:${slug}`;
  return {
    cropId,
    itemId,
    name,
    emoji,
    address: buildGameItemAddress(FARM_OFFICIAL_ISSUER_PUBKEY, itemId),
    relayHint: PRODUCE_DEFINITION_RELAY_HINT,
  };
}

/** Every crop the Farm can currently harvest into an item. */
export const PRODUCE_CATALOG: Readonly<Record<string, ProduceDefinition>> = Object.freeze({
  carrot: official('carrot', 'carrot', 'Carrot', '🥕'),
  parsnip: official('parsnip', 'parsnip', 'Parsnip', '🥔'),
  pumpkin: official('pumpkin', 'pumpkin', 'Pumpkin', '🎃'),
  strawberry: official('strawberry', 'strawberry', 'Strawberry', '🍓'),
});

export const PRODUCE_CROP_IDS: readonly string[] = Object.freeze(Object.keys(PRODUCE_CATALOG));

/**
 * Resolve a crop to its official produce definition.
 *
 * Returns `undefined` for anything unmapped. Callers MUST fail the harvest
 * before touching the network rather than clearing a crop that can never be
 * credited.
 */
export function getProduceForCrop(cropId: string | undefined): ProduceDefinition | undefined {
  if (!cropId) return undefined;
  return PRODUCE_CATALOG[cropId];
}

/** Reverse lookup, for rendering an inventory the Farm did not just write. */
export function getProduceByAddress(address: string): ProduceDefinition | undefined {
  return PRODUCE_CROP_IDS.map((id) => PRODUCE_CATALOG[id]).find((produce) => produce.address === address);
}
