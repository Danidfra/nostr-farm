# Developer tools

Two routes, both gated by a **build-time literal**.

| Route | Purpose |
| --- | --- |
| `/dev` | simulation-only test lab |
| `/dev/worlds` | world/map editor foundation |

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

Verify with `ls dist/assets/*.js`: a default production build produces one
application chunk and no `TestLabPage` / `WorldEditorPage` / `DevLayout` chunk.

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
