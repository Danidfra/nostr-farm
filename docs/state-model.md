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
