# World / Map / Slot state

Schema version `v = 2`. Version 1 state is **not migrated** — see "Why v1 is
gone" below.

All three kinds are addressable (NIP-01 30000–39999), so the relay keeps the
newest event per `(pubkey, kind, d)` on its own.

## WorldState — kind 31415

The root of one player's world.

| Tag | Value |
| --- | --- |
| `d` | world id, e.g. `farm` |
| `v` | `2` |
| `type` | `farm` |
| `name` | display name |
| `entry_map` | `d` of the map the player enters |
| `renderpack` | pinned renderpack id |
| `renderpack_version` | pinned renderpack version |

No URL appears anywhere in the event. The id + version pair resolves through
`src/world/renderpack/registry.ts`.

## MapState — kind 31416

| Tag | Value |
| --- | --- |
| `d` | map id, e.g. `farm.field` |
| `v` | `2` |
| `a` | `31415:<pubkey>:<worldId>` |
| `map_def` | id of the source-controlled map definition |
| `map_def_revision` | revision of that definition |
| `name` | optional display name |

The map does **not** carry its layout. Geometry is code
(`src/world/definitions/maps/`), so level design stays under review.

## SlotState — kind 31417

| Tag | Value |
| --- | --- |
| `d` | `slot:<mapId>:<x>:<y>` |
| `v` | `2` |
| `a` | `31416:<pubkey>:<mapId>` |
| `slot` | `<x>`, `<y>` |
| `type` | `plant` or `empty` |
| `crop` | crop id (plant only) |
| `planted_at` | unix seconds (plant only) |
| `growth_sec` | banked growth (plant only) |
| `growth_updated_at` | accrual reference (plant only) |
| `wet_until` | wetness deadline (plant only) |
| `last_harvested_at` | unix seconds (empty only, optional) |

Only inputs. Everything else is recomputed.

## Ownership and authority

V1 farms are **personal**. The owner is the sole authority for their own state.

- Every query is scoped `authors: [ownerPubkey]`.
- A `MapState` is rejected unless its `a` tag names a world owned by the *same*
  pubkey that signed it.
- A `SlotState` is rejected unless its `a` tag names a map owned by the same
  pubkey, and unless its `d`, `slot` tag and parent map id all agree.
- `collectOwnedSlots` drops every event not authored by the owner **before**
  de-duplicating.

There is no ambient host, no host election, and no third-party writer whose
`SlotState` is treated as authoritative.

## Relays: a primary, the ones the game always used, and no relay believed alone

| Flow | Kinds | Read from | Written to | A write counts when |
| --- | --- | --- | --- | --- |
| Game state | 31415, 31416, 31417 | `relay.blobbi.pet` (primary) + `relay.primal.net` | both | `relay.primal.net` accepted |
| Inventory ledger | 31633 `farm:main`, 1416 (read only), 1417 | primary + `relay.primal.net` + `relay.ditto.pub` | all three | primal or ditto accepted |
| Item Registry | 31632 | the same three | all three | reported per relay |
| Profiles | 0 | `relay.primal.net` (pool default) | never written | n/a |
| Login (NIP-46) | 24133 | the relays in the `bunker://` URI | same | n/a |
| Uploads | 24242 | HTTP header to the Blossom server | n/a | n/a |

The tables are `GAME_RELAYS` (`src/nostr/relays.ts`), `INVENTORY_RELAYS`
(`src/hooks/farm/inventory-relays.ts`) and `ITEM_REGISTRY_RELAYS`
(`src/inventory/constants.ts`). The rules shared with the other apps of the
ecosystem (merge, certainty of absence, what may be carried) are in
`src/lib/relay-routing.ts`, vendored verbatim from `@blobbi-kit/core`.

The primary relay is listed first and is **not** `required`: its write list is
a pilot allowlist, so most players are refused there
(`blocked: this relay is in pilot mode; author is not on the write list`), and
it rejects events above its size cap (`invalid:`). Neither fails an action.
The publish result records each relay's verdict, and "About this farm" shows
whether the primary is up to date, pending or refusing.

Because the primary relay may hold nothing for a player, **order carries no
authority and no read believes one relay**:

- **Merge.** Every read asks every relay of its flow and deduplicates by id.
  An addressable event keeps its NIP-01 winner (newer `created_at`, then the
  lower id) wherever it came from; 1416 and 1417 are history and all are kept.
- **A relay answered only by reaching `EOSE`.** One that closed the
  subscription, timed out or failed did not answer; it did not answer "empty".
- **Empty is a fact only when every relay said so.** Otherwise the state is
  unknown: the field keeps what it last showed (`readFarmField`), planting on
  a plot not confirmed bare is refused (`readPlotNow`), no farm is created
  (`lookupFarm`) and `farm:main` is not started at revision 1
  (`readConfirmedBase`).
- **What was found may be built on only if a relay that makes writes count
  answered.** Every successful write is on one of those, so a copy found only
  elsewhere can be arbitrarily old (`current` in `readPlotNow`, `anchored` in
  `InventoryReadResult`).
- **A found answer is not held back for a slow relay** (`graceMs` in
  `readFromRelays`); an empty one waits for everyone.

**Copying existing records is off until the account turns it on.** Opening
the app, restoring a saved login and receiving query results send no `EVENT`.
The switch is "Copy existing records" in "About this farm": off by default,
per pubkey, it lists the relays that would receive copies, and it can be
turned off again. The answer (`SyncConsent`, stored under
`nostr-worlds:relay-sync-consent`) covers exactly the relays shown; a relay
added later is not covered until the account turns it on again.

Once on, after a read `relaySync.carryMissing` (`src/nostr/relay-sync.ts`)
offers the original signed event to the consented relays of the flow that
certainly lack it: they reached `EOSE`, the filter was not filled to its
limit, and the event is the signed-in account's own (31632: only when that
account is the Farm issuer, and only toward the primary relay). Only the
winning revision of an addressable event travels.

With it off, one thing is still re-offered: an event the player's action
published in this page session to a relay that gave no verdict. That finishes
the publication and ends with the session; after a reload it is an existing
record like any other. A ledger kept in
`localStorage` stops repeats: accepted is never offered again, refused not for
six hours, silence after a growing wait and at most six times; a relay that
refused the author is not offered that author's other events for an hour.

## Creating a farm: absence must be confirmed

`WorldState` and `MapState` are replaceable, so publishing them over an
existing farm silently renames it and re-points its entry map. "No farm" is
therefore a claim the relays have to back, not the default for an empty
answer. `lookupFarm` (`src/hooks/farm/farm-lookup.ts`) reads every configured
game relay until `EOSE` (`readFromRelays` in `src/nostr/query.ts`) and
reports one of:

| Result | Meaning | May publish |
| --- | --- | --- |
| `found` | a world and a map parsed, from a completed or an incomplete read | nothing |
| `absent` | every relay said `EOSE` with no world, on two reads a pause apart | world, then map |
| `field-missing` | world confirmed, entry map confirmed absent the same way | map only |
| `unknown` | a relay closed before `EOSE`, timed out or errored | nothing |

A relay that answers `CLOSED` (auth required, rate limited) ends Nostrify's
`req` stream without `EOSE`, which `relay.query()` reports as an empty array;
only `readUntilEose` tells the two apart. An event that arrives before the
stream is cut off still proves the farm exists, so an incomplete read can
find a farm but never confirm there is none.

`useCreateFarm` repeats the lookup itself immediately before publishing and
acts on that result alone: `found` publishes nothing, `field-missing` restores
the map and keeps the world, `absent` publishes both, `unknown` refuses.
Repeating a create is therefore safe, and a create that landed halfway is
completed rather than restarted.

## Slot identity

Slot addresses stay **coordinate-derived**: `slot:<mapId>:<x>:<y>`.

A farm map is a fixed grid over a baked background — one slot per cell, forever.
A coordinate address replaces itself naturally on every replant, needs no id
allocation, and lets a client address a cell it has never seen. A surrogate id
would need a lookup table to draw a grid and would buy nothing.

The v1 problem was never the coordinates. It was that:

- the address was built by string-mangling (`mapId.split(':').pop()`), and
- readers de-duplicated on the `d` tag alone across arbitrary authors.

Both are fixed. World and map ids are now validated against
`/^[a-z0-9][a-z0-9._-]{0,63}$/` — no colons — which makes
`slot:<mapId>:<x>:<y>` split unambiguously into exactly four parts.

## Planting identity

A slot address names a plot, not a planting: the same address holds one
crop after another. A **planting** is `(slot d, planted_at)`. `planted_at`
is assigned once when the seed goes in and copied unchanged by every later
`SlotState` (watering, developer acceleration), so it survives the event id
changing with each write. `plantingTime` in `src/farm/slots/transitions.ts`
stamps every planting strictly after the plot's `last_harvested_at`, which
makes `planted_at` monotonic per plot across devices and clocks. The
inventory credits a harvest under this identity; see
[`farm-inventory.md`](farm-inventory.md). Existing events need no change:
`planted_at` has been a required tag since schema v2.

## Why v1 is gone

- It persisted derived values (`stage`, `ready_at`, `expires_at`) next to the
  inputs they came from.
- It carried a deprecated `watered_at` / `water_count` pair the growth model no
  longer used.
- It de-duplicated slots blind to the author.
- It depended on **kind 14159** for action intent. That kind needed many
  immutable events, but 14159 sits in NIP-01's *replaceable* range, so relays
  were entitled to keep only the newest. Kind 14159 is dead and is not read or
  written anywhere; `src/nostr/world-map-state.test.ts` fails the build if it
  reappears.

Old relay state is disposable and no migration path exists by design.
