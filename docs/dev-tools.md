# Developer tools

Three routes and one panel on the field, all gated by a **build-time literal**.

| Where | Purpose |
| --- | --- |
| `/dev` | simulation-only test lab |
| `/dev/worlds` | world/map editor foundation |
| `/dev/inventory` | read-only `farm:main` accounting panel |
| the farm page | live field tools for one authorized key (see below) |

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
build if a `TestLabPage`, `WorldEditorPage`, `InventoryPanelPage`,
`DevLayout` or `DevFarmTools` chunk is present in `dist/assets` (unless the
build opted in with `VITE_ENABLE_DEV_TOOLS=true`). `npm test` therefore
covers the exclusion. The flag is resolved by `resolveDevToolsEnabled` in
`scripts/deploy-target.mjs`, and only the literal string `true` counts.

## Field tools — live, one authorized key

`src/dev/farm-tools/`. A small panel in the corner of the farm page whose
one action, **Make harvestable**, lets the real Farm → `farm:main` → other
game flow be exercised in seconds instead of waiting out crop timers.

**Purpose.** Interoperability testing against the live deployment, with the
real signed-in identity, the real farm state and the real events. It is not
a gameplay feature and is not mentioned to players.

**Who sees it.** The panel renders, and the hook behind it agrees to sign,
only when both hold:

1. the build opted in (`__DEV_TOOLS_ENABLED__` is `true`), and
2. the signed-in hex public key equals `DEV_FARM_TOOLS_PUBKEY` in
   `src/dev/farm-tools/access.ts`, which is the official Farm issuer key
   (`FARM_OFFICIAL_ISSUER_PUBKEY`). The comparison is on the normalized hex
   key; an npub is only its display form.

Anyone else, and anyone logged out, gets no panel and no control. A default
production build contains neither the panel nor its chunk.

**What it does.** For the selected planted slot it publishes one ordinary
kind:31417 replacement — the same `buildSlotState` + `useNostrPublish` write
that plant and water use — carrying the state the crop would have had after
growing to its harvest stage plus one normal watering
(`acceleratedToReady`). Nothing else is written: no inventory, no item, no
quantity. The crop is then harvested with the **normal** click on the field,
and that harvest runs the production pipeline unchanged: guard → produce
lookup → `creditHarvest` (confirmed read, idempotency marker, spend
settlement, kind:31633) → clear the slot. The idempotency marker is the id of
the accelerated plant event, so a second harvest of the same crop credits
nothing. Consuming games see an ordinary Farm Strawberry and nothing more.

What it deliberately does not do: grant produce, edit `farm:main`, change
crop timings or definitions, or publish anything when the panel is merely
opened. Every publish is one explicit click, signed by the current signer.
Rotten crops are refused; clear them on the field.

**Enable for a test deployment** (Vercel): set the environment variable
`VITE_ENABLE_DEV_TOOLS=true` on the project and redeploy. The build log will
say `[check-dev-chunks] dev tools enabled for this build; skipping`. Sign in
with the authorized key and the panel appears on the farm page.

**Disable afterwards:** remove the variable and redeploy. The build log goes
back to `[check-dev-chunks] ok: no developer chunk …`, and the panel's chunk
is absent from `dist/assets`.

**Not a security boundary.** The gate is client-side and only decides
whether a convenience renders. Everything it can publish is an owner-signed
event the same user could publish by hand; nothing server-side trusts the
check, and it must never be described as authorization. What it does
guarantee: no private key or secret in source, explicit build-time
enablement that defaults to off, and a public-key check before anything is
signed.

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

Not built here. The page carries a clearly marked, visually distinct
placeholder. The one live tool that exists lives on the farm page itself
(see "Field tools" above) and states which event it publishes.

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
