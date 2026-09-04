# Nostr Farm

A cozy little farming game where the farm belongs to your Nostr key.

Plant, water and harvest on a field that is yours on any device, and keep the
produce as inventory that other Nostr games can use. There is no account to
create with us and no server of ours in the loop: everything you do is a
signed event on public relays.

**Play it:** <https://danidfra.github.io/nostr-farm/>

## Playing

1. Sign in with a NIP-07 browser extension, a `bunker://` remote signer, or a
   secret key. You can also generate a new key on the spot.
2. Name your farm. That publishes your farm and its field to the game relay.
3. Click a plot to plant a seed. Crops grow only while they are wet, so water
   them; a crop that stays dry too long rots and has to be cleared.
4. Click a ready crop to harvest it. The produce appears in the tray on the
   rail at the top.

Four crops exist today: carrot, parsnip, pumpkin and strawberry. They share
the same timings on purpose; balance is a later milestone.

## Why Nostr

- **You own the farm.** Your key signs every event. Nobody can edit, move or
  delete your field but you, and you can point any client at it.
- **Any relay can carry it.** The Farm writes to public relays and reads them
  back. If the Farm's own website disappeared, the events would not.
- **Any game can read it.** Harvested produce is written as a standard
  inventory event. Another application that speaks the same format can show
  it, use it and debit it, without asking the Farm.

## Interoperability

Harvesting credits an official Farm item to your `farm:main` inventory
(kind 31633). Another game can then publish a spend (kind 1416) against that
inventory. The Farm sees the spend live, lowers what it shows you, and tells
you the produce was "used in another Nostr game". On your next harvest it
settles the spend into a fold manifest (kind 1417) and a fresh snapshot.

Blobbi Island is the first independent application to consume Farm
produce. It shares no code with the
Farm and no runtime connection to it: both read and write the same Nostr
events, and that is the entire integration.

The protocol lives in one shared package,
[`@nostr-games/inventory`](https://github.com/Danidfra/nostr-games-inventory),
which defines kinds 31632, 31633, 31634, 1416 and 1417 and implements the
parsing, validation and balance resolution every game uses. The Farm carries
no second implementation of any of it.

Read [docs/interoperability.md](docs/interoperability.md) for the flow with
a diagram, and [docs/farm-inventory.md](docs/farm-inventory.md) for exactly
what the Farm reads and writes.

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
| `npm run build` | production build; fails if a dev-tools chunk leaks in |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run test:unit` | vitest |
| `npm test` | all of the above |

Pushes to `main` deploy to GitHub Pages at the URL above. The build is
emitted for the `/nostr-farm/` base path; the dev server serves from `/`.

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

The one rule that matters: `src/farm` is pure and a test fails the build if
it stops being so. Every gameplay decision is a call into it; everything else
moves values around. See [docs/architecture.md](docs/architecture.md).

The artwork is a separate repository,
[`farm-nostr-game`](https://github.com/Danidfra/farm-nostr-game), pinned to an
exact commit so a running game never changes under a player.

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

## Status

V1 foundation. A personal farm you can plant, water and harvest; produce
credited to an interoperable inventory; live updates when another game
spends it; a themed, standalone interface; and read-only accounting
observability for developers.

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
