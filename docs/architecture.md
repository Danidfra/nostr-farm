# Nostr Worlds — architecture

Nostr Worlds is a **Farm application today** with **lightweight world primitives
underneath**. It is not a general game engine and does not pretend to be one:
abstractions exist only where the Farm already justifies them.

```
src/
  farm/        pure domain      no React, no Nostr, no clock, no browser
  world/       definitions, pinned renderpacks, render geometry
  nostr/       event schemas for world / map / slot state
  inventory/   boundary for a later inventory integration (no protocol yet)
  hooks/       React glue: queries, mutations, clock
  components/  UI
  dev/         build-flag gated developer tools
```

## The one rule that matters

`src/farm` is pure. It may not import React, Nostrify, nostr-tools, TanStack
Query, anything under `@/` outside itself, or any browser API, and it may not
read a clock. Time always arrives as an explicit `nowSec` argument.

This is enforced by `src/farm/purity.test.ts`, which fails the build rather than
relying on discipline.

## Layer responsibilities

| Layer | Owns | Must not |
| --- | --- | --- |
| `farm/` | growth maths, crop balance, slot transitions | know how state is stored or displayed |
| `world/` | map geometry, renderpack pinning | contain gameplay rules |
| `nostr/` | tag schemas, parsing, authority checks | contain gameplay rules |
| `hooks/` | queries, mutations, optimistic updates | re-implement domain rules |
| `components/` | rendering and input | compute growth itself |

Every gameplay decision — can this be watered, is it ripe, has it rotted — is a
call into `src/farm`. The UI and the Nostr layer only move values around.

## Data flow

```
relay ──► parseSlotState ──► FarmSlot ──► evaluatePlant(now) ──► PlantView ──► UI
                                  ▲                                      │
                                  └──── applyFarmAction(slot, action) ◄───┘
                                                  │
                                                  └──► buildSlotState ──► publish
```

Reads and writes go through the same pure transition. There is no server, no
processor and nothing to reconcile.

## Renderpacks

> Events and game state describe **state**. Renderpacks describe **visuals and
> layout**.

That principle survives from the earlier design. What did not survive is
fetching a renderpack from `raw.githubusercontent.com/.../master`: a push to the
art repository silently changed a running game and could not be reproduced
afterwards. See [renderpacks.md](./renderpacks.md).

Gameplay numbers were also moved *out* of the renderpack into
`src/farm/crops/catalog.ts`, so artwork edits can never rebalance the game.

## What is deliberately absent

Shared farms, host election, command polling, visitor actions, inventory
publishing, economy, animals, NPCs, crafting, quests and player movement. Each
would add architecture that V1 cannot yet justify.
