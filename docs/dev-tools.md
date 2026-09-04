# Developer tools

Three routes, all gated by a **build-time literal**.

| Route | Purpose |
| --- | --- |
| `/dev` | simulation-only test lab |
| `/dev/worlds` | world/map editor foundation |
| `/dev/inventory` | read-only `farm:main` accounting panel |

## Gating

`vite.config.ts` computes `__DEV_TOOLS_ENABLED__` at config time and Vite
inlines it as a literal. Because it is a literal, the bundler drops the route
table **and its lazy chunks** from a production build — the tools are absent,
not merely unreachable.

| Build | Dev tools |
| --- | --- |
| `npm run dev` | on |
| `npm run build` | off; no dev chunk is emitted |
| `VITE_ENABLE_DEV_TOOLS=true npm run build` | on |

`npm run build` ends with `scripts/check-dev-chunks.mjs`, which fails the
build if a `TestLabPage`, `WorldEditorPage`, `InventoryPanelPage` or
`DevLayout` chunk is present in `dist/assets` (unless the build opted in with
`VITE_ENABLE_DEV_TOOLS=true`). `npm test` therefore covers the exclusion.

## `/dev` — test lab (simulation only)

Offline by construction: `src/dev/test-lab/simulation.ts` imports nothing but
`@/farm`, and a test enforces that. No relay, no signer, nothing publishes.

It drives the shipped domain, so a bug reproduced here is a real bug.

Controls:

- select a slot on a 6×3 grid; choose a crop
- real actions: plant, water, harvest, clear (rejections are logged with the
  domain's own reason code)
- virtual clock: `+10s / +1m / +5m / +15m / +1h / +1d`, `-5m` for clock skew,
  and reset
- force state, bypassing the rules: spawn seed, set wet, set dry,
  harvest-ready, rotten, jump to any stage
- failure injection: five malformed-state presets (negative growth, ten years of
  wetness, planted in the future, unknown crop, NaN timestamps) and a simulated
  renderpack load error
- inspection: computed `PlantView`, raw slot state, crop config, action log

### Live / Nostr area

Not built. The page carries a clearly marked, visually distinct placeholder.
When live tools arrive, each control must state exactly which event it signs and
publishes before it does anything.

## `/dev/inventory` — farm:main accounting (read only)

The player's `farm:main` as the read model sees it. It mounts the **same**
`useFarmInventory` query the HUD renders, so it shares the cache and the live
tail with the game; nothing is fetched or resolved a second time, and nothing
here can publish.

Shown, all read off `FarmInventoryView` and the `resolution` it keeps:

- inventory address, owner, the inventory relays
- status (`ready` / `unresolved`), resolver problems, missing manifests,
  resolver warnings, query state (pending / fetching / last update / error),
  whether the browser is online
- the snapshot: event id, `created_at`, revision, fold head, contexts,
  harvest-marker count
- balances per official produce item: raw (snapshot), pending delta,
  effective; the effective column is withheld while unresolved
- every candidate spend with its classification (applied, rejected, folded,
  voided, ignored, invalid), id, item, quantity, `created_at`, self-declared
  `client`, and the resolver's note (available → remaining, or why rejected)
- the fold chain head first, each manifest's `previous`, `spend` and `void`
  references, and the settled id counts
- the raw ledger events, expandable as JSON

Not shown, deliberately: per-relay tail state and retry timers. The live
controller keeps those internal, and the panel says "not exposed" rather than
reconstructing them.

## `/dev/worlds` — world editor foundation

The farm renders a **baked background**, not a tileset, so this edits *regions
and objects over a background*.

Implemented:

- load an official map, or import/export map-definition JSON
- edit id, name, revision, background path, tile size
- edit plant area, grid cols/rows/alignment, spawn point
- add, edit and remove zones (`interaction`, `collision`, `exit`, `decoration`)
- live preview with plant-area, per-cell grid, zone and spawn overlays
- continuous schema validation, including geometry checks the schema alone
  cannot express (grid fits the plant area, plant area fits the background,
  duplicate ids)

Deferred, deliberately:

- tile painting and collision brushes (no tileset exists to paint with)
- object placement UI — the schema supports `objects`, the editor does not yet
  expose a sprite browser for them
- warp wiring between maps (`exit` zones carry metadata, nothing consumes it)
- drag-to-resize handles; numeric fields only
- publishing definitions to a relay

## Hybrid authoring model

Official maps are **source-controlled**. The editor produces exactly the
`MapDefinition` shape that lives in `src/world/definitions/maps/`; the workflow
is edit → export → paste → commit. Relay-published world definitions may come
later, but making relays the only authoring source would put level design
outside code review.
