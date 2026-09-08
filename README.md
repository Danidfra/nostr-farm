# Nostr Farm

A small farming game where the farm belongs to a Nostr key.

It is a browser-only React app with no application backend. Everything the
game persists (the farm, its field, each planted plot, the harvested produce)
is a Nostr event signed by the player and stored on public relays. The app
reads those events back and derives everything else from them.

**Play it:** <https://farm.blobbi.pet>

## Running it locally

```bash
npm install
npm run dev          # http://localhost:8080, with developer tools at /dev
npm test             # typecheck + lint + unit tests + production build
```

Requires Node 22.

| Script | Does |
| --- | --- |
| `npm run dev` | dev server, dev tools enabled |
| `npm run build` | production build for the official site; fails if a dev-tools chunk leaks in or an asset path misses the base |
| `npm run build:pages` | the same build for the GitHub Pages `/nostr-farm/` path |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run test:unit` | vitest |
| `npm test` | all of the above |

## Playing

1. Sign in with a NIP-07 browser extension, a `bunker://` remote signer
   (NIP-46), or a secret key. You can also generate a new key on the spot and
   download a backup of it.
2. Name your farm. That publishes the farm and its field to the game relay.
3. Click a plot to plant a seed, water it, and harvest it when it is ready.
   Harvested produce appears in the tray at the top.

## Game mechanics

Each player has one personal farm: a world, one map, and a 9x4 grid of plots.
Four crops exist (carrot, parsnip, pumpkin, strawberry) and they share the
same timings on purpose; balance is a later milestone.

A planted crop stores five values: crop id, `planted_at`, `growth_sec`,
`growth_updated_at` and `wet_until`. Everything else is computed from those
and the current time:

```
totalGrowth(now) = growthSec + max(0, min(now, wetUntil) - growthUpdatedAt)
```

- A seed starts dry and does not grow until watered.
- Growth accrues only while the crop is wet (`now < wetUntil`). Dry time
  contributes nothing, and watering a dry crop resumes growth without
  crediting the gap.
- Watering extends `wetUntil` by a fixed amount, capped at a maximum buffer
  ahead of now. You cannot stack hours of wetness in one sitting.
- A crop rots once it has been dry for a fixed period. A wet crop never rots.
  Watering a ripe crop is allowed because it postpones rot.
- A ripe crop is harvested for one unit of produce, which is credited to the
  player's Farm inventory. A rotten crop can only be cleared.

Because the model is a function of `(state, now)`, nothing has to tick, and
two clients evaluating the same state at the same time derive the same result. The rules live in `src/farm`, which
imports no React, no Nostr and no clock; a test fails the build if that
changes. Timings are in `src/farm/crops/catalog.ts`, not in the artwork.

## Nostr state model

The farm is stored as three addressable event kinds, all written by the
player's key:

| Kind | Name | `d` tag | Holds |
| --- | --- | --- | --- |
| `31415` | WorldState | `farm` | name, entry map, pinned renderpack id and version |
| `31416` | MapState | `farm.field` | `a` ref to the world, the id and revision of a source-controlled map definition |
| `31417` | SlotState | `slot:<map>:<x>:<y>` | `a` ref to the map, `type` (`plant` or `empty`), and the five plant values above |

Only inputs are stored. Stage, readiness and rot are never written to a relay.
Map geometry is code (`src/world/definitions/maps/`), not relay data. Artwork
comes from a renderpack pinned to an exact commit of the art repository, so a
push to that repository cannot change a running game.

Ownership works like this:

- Every query is scoped to `authors: [ownerPubkey]`.
- A map is rejected unless its `a` tag names a world owned by the same pubkey
  that signed it. A slot is rejected unless its `a` tag, `d` tag and `slot`
  tag all agree and name the same owner.
- The app only ever writes the signed-in player's own events. There is no
  host, no shared farm and no third-party writer.

This is what the client accepts, not a guarantee the network makes. Relays
store and return events; they do not enforce game rules, and no relay set
gives a complete or globally consistent view. Game state is written to a
single relay (`wss://relay.primal.net`, see `src/nostr/relays.ts`). There is
no relay settings UI.

These kinds, and the inventory kinds below, are defined by this project and
the inventory package. They are not part of any NIP. Details, including why
the v1 schema was dropped, are in [docs/state-model.md](docs/state-model.md).

## Inventory interoperability

Harvested produce is not a Farm-private counter. It is written in a shared
inventory event format so that other Nostr applications can read it without
running any Farm code. The format is defined by
[`@nostr-games/inventory`](https://github.com/Danidfra/nostr-games-inventory),
a project-defined draft, not a Nostr standard. The package implements the
parsing, validation and balance resolution. The Farm imports it through a
single module and carries no second implementation.

| Kind | Name | Who writes it |
| --- | --- | --- |
| `31632` | Game Item Definition | the Farm issuer key, one per crop (`farm:produce:<slug>`) |
| `31633` | Game Inventory | the player, through the Farm, as `farm:main` |
| `1416` | Game Inventory Spend | the player, through another application |
| `1417` | Game Inventory Fold Manifest | the player, through the Farm |

The rules:

- **One writer per snapshot.** By convention the Farm is the application that
  replaces the `farm:main` snapshot, and another application debits it by
  publishing a player-signed spend (kind 1416) against the full inventory
  address instead of rewriting the snapshot. Neither Nostr nor the package
  enforces this; the player's key can sign either event from any client.
- **Effective, not raw.** The Farm shows `snapshot - pending spends`, where
  pending means not yet settled by the fold chain the snapshot references.
  A spend is debited once; an overdraw is rejected in full.
- **Settle, then credit.** On the next harvest the Farm folds pending spends
  into a kind 1417 manifest, publishes a new snapshot that references it, and
  only then adds the harvested unit.

The Farm keeps a live subscription on the inventory relays, so a spend
published elsewhere lowers the displayed count without a refresh. If the
spend carries a `client` tag the HUD shows "Used in <that name>"; that tag is
self-declared and displayed as text only. The Farm keeps no list of consuming
applications and never publishes a spend of its own.

Inventory and item events go to `wss://relay.primal.net` and
`wss://relay.ditto.pub` (`INVENTORY_RELAYS` in
`src/hooks/farm/inventory-relays.ts`), because they have to be findable by
other clients.

A browser and editor for kind 31632 definitions lives at `/items`. See
[docs/interoperability.md](docs/interoperability.md) for the cross-game flow
and what a consuming application must publish, and
[docs/farm-inventory.md](docs/farm-inventory.md) for exactly what the Farm
reads and writes.

## Write and concurrency model

Plant, water and clear are optimistic replaceable writes: publishing the same
slot state twice is the same state. Harvest is different because it also
credits an item, and `+1` applied twice is `+2`. So harvest runs credit first
and clears the crop only after the inventory write was accepted.

The credit is a read-modify-write on a replaceable event, done as follows:

- A read that returns no inventory is re-read once before it is believed. A
  first snapshot is only created after that confirmed empty read.
- The consumed plant event id is recorded in the snapshot as an `e` tag
  marker. A retry finds the marker and credits nothing.
- The snapshot is rebuilt through the package's lossless round-trip, so tags
  the Farm does not manage survive. `created_at` is always strictly after the
  event being replaced.
- Publishing has three outcomes: accepted, rejected, and ambiguous (timeout).
  An ambiguous result is reconciled by re-reading for the marker, never by
  publishing another `+1`. A manifest that was signed but not confirmed is
  remembered per tab and republished as-is if the retry needs the same one.
- Writes are serialized per tab, and across same-origin tabs with the Web
  Locks API where the browser has it.

What this does not give you: two devices, or two browsers, can still race on
the replaceable snapshot. There is no compare-and-swap and no global lock; the
`revision` tag is advisory. Both would derive and publish, and the loser's own
harvest would be lost. What the resolver does guarantee is narrower: in a
resolved state, a spend reachable through the snapshot's fold chain is
excluded from pending and is not applied again, and if the chain cannot be
resolved no balance is derived at all.

If a snapshot references a fold manifest the Farm cannot retrieve or verify,
there is no balance. The HUD shows "Produce unavailable" and harvest is
blocked, rather than showing the raw snapshot (which could include items
another application already consumed) or treating every spend as pending
(which could debit twice).

## Trust and limitations

- The app is entirely client-side. Signing is done by whatever login method
  the player chose: extension, bunker, or a key held in the page. With a
  secret-key login the key is stored in plaintext in `localStorage` by the
  login library. Extension and bunker logins do not put the user's key in the
  page.
- An item is "official" when its author is the Farm issuer pubkey, which is
  fixed in source (`src/inventory/constants.ts`). Anybody can publish a kind
  31632 with any `d`; the registry labels those as external rather than
  rejecting them. Items are always identified by the full
  `31632:<pubkey>:<d>` address, never by `d` alone.
- Relay-provided strings are rendered as text. Item image URLs go into
  `<img src>` unvalidated.
- The page sets a CSP with `script-src 'self'`, and the Vercel deployment adds
  frame, sniffing, referrer and permissions headers. The GitHub Pages copy
  cannot set headers.
- Developer tools are excluded from a default production build and, when
  enabled, gate on a public key. That is a convenience gate, not authorization.

See [docs/security-audit-pre-alpha.md](docs/security-audit-pre-alpha.md).

## Testing

`npm run test:unit` runs about 660 vitest tests in 55 files. They cover the
growth model and slot transitions, the event parsers and ownership checks, the
harvest credit transaction including its relay failure branches, the live
inventory controller against an in-memory fake relay, the item registry, the
React hooks and components, and the deployment scripts.

Several tests enforce architecture rather than behaviour: `src/farm` must stay
pure, `@nostr-games/inventory` may only be imported from one file, renderpack
URLs must be pinned to a commit, and kind 14159 from the old schema must not
reappear. `npm run build` fails if a developer chunk is emitted.

There are no end-to-end tests and no tests against a real relay.

## How it is built

```
src/farm/        pure game rules: growth, watering, rot, harvest. No React, no Nostr, no clock.
src/world/       map definitions, pinned artwork (renderpacks), grid geometry
src/nostr/       the farm / field / plot event schemas (kinds 31415, 31416, 31417)
src/inventory/   farm:main accounting: ledger, effective balance, harvest credit, change attribution
src/hooks/       React glue: relay queries, the live inventory subscription, actions
src/components/  UI: the field, the HUD, the gate screens, and a few game primitives
src/dev/         developer tools, absent from production builds
docs/            architecture and protocol notes
```

Every gameplay decision is a call into `src/farm`; everything else moves
values around. See [docs/architecture.md](docs/architecture.md).

The artwork is a separate repository,
[`farm-nostr-game`](https://github.com/Danidfra/farm-nostr-game), pinned to an
exact commit in `src/world/renderpack/registry.ts`.

## Deployment

The official site is <https://farm.blobbi.pet>, deployed by Vercel from `main`
with `npm run build`, which emits assets for the domain root. Pushes to `main`
also deploy a GitHub Pages copy at <https://danidfra.github.io/nostr-farm/>,
built with `npm run build:pages` for the `/nostr-farm/` base path. The base
path is chosen with `DEPLOY_TARGET` at build time (`scripts/deploy-target.mjs`)
and nothing in the app knows about it beyond `import.meta.env.BASE_URL`. The
dev server serves from `/`.

A build ships the developer tools only with `VITE_ENABLE_DEV_TOOLS=true`. See
[docs/dev-tools.md](docs/dev-tools.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Interoperability](docs/interoperability.md): how produce moves between games
- [Farm inventory](docs/farm-inventory.md): what the Farm reads and writes
- [Growth model](docs/growth-model.md)
- [World / field / plot state](docs/state-model.md)
- [Renderpacks](docs/renderpacks.md)
- [Game Item Registry](docs/item-registry.md): browsing and authoring kind 31632
- [UI primitives and theme](docs/ui.md)
- [Developer tools](docs/dev-tools.md)
- [Pre-alpha security notes](docs/security-audit-pre-alpha.md)

## Status

Pre-alpha. Implemented today:

- a personal farm you can plant, water, harvest and clear
- produce credited to a `farm:main` inventory that other applications can
  read and spend
- live balance updates when a spend arrives, with settlement on the next
  harvest
- a kind 31632 item registry and editor at `/items`
- developer tools for simulation, map editing and inventory inspection

Not production-ready: the relay set is hardcoded, secret-key logins are stored
in plaintext, multi-device writes can race, and there is no end-to-end test
coverage.

This repository was previously named `nostr-worlds`. The Nostr identifiers
(`farm:main`, `farm:produce:*`, `game:farm`, the kinds and the issuer key)
are unchanged by the rename, as are the storage keys the app uses.

## Future direction

None of this is implemented; it is where the foundation is meant to lead.

- more crops, with distinct timings
- seeds and tools as items of their own
- processing produce into other goods
- buildings and more areas of the farm
- progression
- visitors and light social play
- further games that read and spend Farm produce

## License

MIT. See [LICENSE](LICENSE).
