# Nostr Farm

A Nostr-native farming game. Your farm is a set of addressable Nostr events
signed by your own key — plant, water, and harvest crops on land nobody else
can write to.

Repository: <https://github.com/Danidfra/nostr-farm> · Live:
<https://danidfra.github.io/nostr-farm/> (formerly `nostr-worlds`; the Nostr
protocol identifiers — `farm:main`, `farm:produce:*`, `game:farm`, kinds and
the issuer key — are unchanged by the rename).

## Quick start

```bash
npm install
npm run dev          # http://localhost:8080
```

Sign in with a NIP-07 extension, a bunker URI or an nsec, then create your farm.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | dev server, dev tools enabled |
| `npm run build` | production build, dev tools stripped |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run test:unit` | vitest |
| `npm test` | typecheck + lint + unit tests + build |

## Deployment

Pushes to `main` deploy to GitHub Pages as a project site at
`https://danidfra.github.io/nostr-farm/`. The build is emitted for that base
path (`PAGES_BASE_PATH` in `vite.config.ts`); the dev server serves from `/`.

## Layout

```
src/farm/        pure domain — no React, no Nostr, no clock, no browser
src/world/       map definitions, pinned renderpacks, render geometry
src/nostr/       world / map / slot event schemas
src/inventory/   kind:31632 item registry, farm:main kind:31633 credit + spend-aware reads
src/hooks/       React glue
src/components/  UI
src/dev/         build-flag gated developer tools (/dev, /dev/worlds)
docs/            architecture and protocol notes
```

## Documentation

- [Architecture](docs/architecture.md)
- [Growth model](docs/growth-model.md) — the rules, their boundaries, and the
  bugs the previous implementation had
- [World / Map / Slot state](docs/state-model.md)
- [Renderpacks](docs/renderpacks.md)
- [Game Item Registry](docs/item-registry.md) — kind:31632 browsing and authoring
- [Developer tools](docs/dev-tools.md)
- [Future: visitor actions](docs/future-visitor-actions.md)

## Status

V1 is a personal-farm vertical slice: enter farm → see the field → plant →
water → watch it grow → harvest. Harvesting yields a domain result and stops
there; harvested produce is credited to the player's `farm:main` inventory (see `docs/farm-inventory.md`); economy, multiplayer and visitor actions are future work.
