# Nostr Farm — architecture

Nostr Farm (formerly Nostr Worlds) is a **Farm application today** with **lightweight world primitives
underneath**. It is not a general game engine and does not pretend to be one:
abstractions exist only where the Farm already justifies them.

```
src/
  farm/        pure domain      no React, no Nostr, no clock, no browser
  world/       definitions, pinned renderpacks, render geometry
  nostr/       event schemas for world / map / slot state
  inventory/   kind:31632 registry, farm:main kind:31633 credit, spend-aware reads,
               produce change attribution (presentation over the resolved view)
  hooks/       React glue: queries, mutations, clock, the live inventory tail
  components/  UI: farm/ (field, HUD, gate, copy), game/ (a few primitives), items/, ui/
  dev/         build-flag gated developer tools (/dev, /dev/worlds, /dev/inventory)
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
| `components/` | rendering and input | compute growth itself, or derive a balance |

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

## Inventory

The Farm owns one kind:31633 context per player, `farm:main`, and credits
harvested produce there. Other games debit it with player-signed kind:1416
spends; the Farm displays the effective balance (snapshot minus pending
spends), keeps it current from a live relay subscription merged monotonically
with an authoritative fetch, and settles those spends in a kind:1417 manifest
only when it is already replacing the snapshot. Unresolved settlement history
is shown as unavailable, never guessed. Protocol rules live in
`@nostr-games/inventory`; the Farm's integration is described in
[farm-inventory.md](./farm-inventory.md), and the cross-game flow in
[interoperability.md](./interoperability.md).

The read model (`FarmInventoryView`) keeps the resolution it derived the
balance from. Two consumers read it rather than re-deriving anything: the
`/dev/inventory` panel, and `diffProduceViews`, which attributes a change in
the displayed counts to a harvest, an external spend, or neither, so the HUD
can say why a number moved. Both are presentation; neither is accounting.

## Presentation

The chrome is the shadcn component set re-themed through its own CSS
variables, plus a handful of game primitives (`src/components/game`). See
[ui.md](./ui.md). Player-facing copy lives in `src/components/farm/copy.ts`
so protocol vocabulary stays out of the game.

## What is deliberately absent

Shared farms, host election, command polling, visitor actions, economy,
animals, NPCs, crafting, quests and player movement. Each would add
architecture that V1 cannot yet justify. The Farm never publishes a kind:1416
spend and never writes another game's inventory.
