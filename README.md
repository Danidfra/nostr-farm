# Nostr Worlds

A Nostr-native farming game. Your farm is a set of addressable Nostr events
signed by your own key — plant, water, and harvest crops on land nobody else
can write to.

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

## Layout

```
src/farm/        pure domain — no React, no Nostr, no clock, no browser
src/world/       map definitions, pinned renderpacks, render geometry
src/nostr/       world / map / slot event schemas
src/inventory/   boundary for a later inventory integration
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
- [Developer tools](docs/dev-tools.md)
- [Future: visitor actions](docs/future-visitor-actions.md)

## Status

V1 is a personal-farm vertical slice: enter farm → see the field → plant →
water → watch it grow → harvest. Harvesting yields a domain result and stops
there; inventory, economy, multiplayer and visitor actions are future work.
