# Nostr Farm — agent guide

A Nostr-native farming game. React 18 + TypeScript + Vite + TailwindCSS +
shadcn/ui + Nostrify + TanStack Query + Vitest.

Read [`docs/architecture.md`](docs/architecture.md) before making structural
changes. This file is the short version.

## The rules that are enforced by tests

1. **`src/farm` is pure.** No React, no Nostrify/nostr-tools, no TanStack Query,
   no `@/` imports outside itself, no browser API, no `Date.now()`. Time enters
   as an explicit `nowSec` argument. — `src/farm/purity.test.ts`
2. **No other game's vocabulary in `src/`.** — `src/farm/purity.test.ts`
3. **Kind 14159 is dead.** It must not reappear outside the note recording that
   it is dead. — `src/nostr/world-map-state.test.ts`
4. **`@nostr-games/inventory` may only ever be imported by
   `src/inventory/package.ts`,** and `src/farm` must contain no inventory code.
   Every registry module goes through the `@/inventory/package` re-export.
   — `src/inventory/boundary.test.ts`
5. **Renderpacks are pinned to exact commits.** No `master`/`main`/`HEAD`, no
   `raw.githubusercontent.com`. — `src/world/world.test.ts`

If a change requires breaking one of these, that is a design conversation, not a
test to relax.

## Where things go

| You are adding… | It goes in |
| --- | --- |
| a growth/harvest/rot rule | `src/farm/` |
| crop balance | `src/farm/crops/catalog.ts` |
| map geometry | `src/world/definitions/maps/` |
| a renderpack version | `src/world/renderpack/registry.ts` |
| an event tag or parser | `src/nostr/` |
| a relay query or mutation | `src/hooks/farm/` |
| a developer-only tool | `src/dev/` (gated, see `docs/dev-tools.md`) |
| a reusable piece of game chrome | `src/components/game/`, see `docs/ui.md` |
| words a player reads | `src/components/farm/copy.ts` |
| kind:31632 item logic | `src/inventory/registry/`, see `docs/item-registry.md` |
| farm:main inventory, spends, folds | `src/inventory/`, see `docs/farm-inventory.md` |

Gameplay decisions belong in `src/farm` and nowhere else. Hooks and components
move values around; they do not re-derive rules.

## Growth model in one line

```
totalGrowth(now) = growthSec + max(0, min(now, wetUntil) - growthUpdatedAt)
```

Growth accrues only while wet; nothing derived is ever persisted. Full
specification: [`docs/growth-model.md`](docs/growth-model.md), and the tests in
`src/farm/growth/evaluate.test.ts` are authoritative.

## Authority model

V1 farms are personal. The owner's pubkey is the sole authority for their own
state; every query is scoped `authors: [ownerPubkey]` and every parser rejects
events whose `a` tag names a parent owned by somebody else. There is no host,
no election, and no processor. See [`docs/state-model.md`](docs/state-model.md).

## Validation

```bash
npm test    # typecheck + lint + vitest + production build
```

Run it before claiming anything works. `npm run build` fails on its own if a
`TestLabPage`, `WorldEditorPage`, `InventoryPanelPage` or `DevLayout` chunk is
emitted (`scripts/check-dev-chunks.mjs`).

## Conventions

- shadcn/ui components live in `src/components/ui/`; add with
  `npx shadcn@latest add <component>`. Unused ones are deleted, not kept.
- Colours come from the theme tokens (`index.css`, `tailwind.config.ts`), never
  raw hex or Tailwind palette classes in components. Fraunces (`font-display`)
  is for names, titles and counts only.
- The HUD shows no relay, kind or artwork version; that belongs in the About
  dialog or under `/dev`.
- `@/` is the alias for `src/`.
- Domain functions take `nowSec` explicitly and return new values; nothing in
  `src/farm` mutates its arguments.
- Prefer deriving over storing. If a value can be recomputed from inputs and a
  timestamp, do not persist it.

## Out of scope right now

Shared farms, host election, command polling, visitor actions (kind 1415 is a
recorded candidate only), economy, animals, NPCs, shops, crafting, quests,
progression, tilesets and player movement. The Farm publishes kind:31633 and
kind:1417 for `farm:main` only; it never publishes a kind:1416 spend, never
writes another game's inventory, and has no UI for spending items.
