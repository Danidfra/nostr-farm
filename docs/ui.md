# UI primitives and theme

The Farm's chrome is the stock shadcn component set, re-themed, plus a small
set of game primitives. There is deliberately no second design system.

## Theme

`src/index.css` defines the shadcn CSS variables for two themes:

| | Light ("sunlit almanac") | Dark ("evening farm") |
| --- | --- | --- |
| ground (`--background`) | linen | soil |
| surface (`--card`, `--popover`) | paper | lamplit paper |
| text (`--foreground`) | bark | cream |
| primary | leaf green | brighter leaf |

Four game colours the shadcn set has no word for are added as `--farm-*`
variables and exposed as Tailwind colours: `farm-wood`, `farm-wood-dark`,
`farm-harvest`, `farm-water`, `farm-rot`, `farm-meadow`. Components use
these tokens; raw hex values do not belong in components.

Three composed classes live in `index.css` because they are used by more
than one component: `farm-paper` (the panel surface), `farm-rail` (the HUD
bar) and `farm-frame` (the wooden frame around the field).

Typography: Inter for everything, Fraunces (`font-display`) for the farm
name, panel titles, produce counts and the welcome headline. Both are
self-hosted through `@fontsource-variable`; the page's CSP allows no
external fonts.

## Primitives (`src/components/game/`)

| Primitive | Use |
| --- | --- |
| `Panel`, `PanelTitle`, `PanelDescription` | the gate screens and any paper panel |
| `HudRail`, `HudPill` | the bar at the top and the capsules on it |
| `StateTag` | a crop's state on the field (ready, water, timer, rotten) |
| `ProduceItem` | a crop sprite with a count; its accessible name says "14 Carrot" |
| `GameDialog` | the shadcn dialog with the paper surface and display-face title |

Add a primitive only when a second place needs it. Everything used once
stays where it is used.

## Copy

Player-facing words live in `src/components/farm/copy.ts`. Protocol
vocabulary (relays, kinds, snapshots, settlement) stays out of the game
unless a player opens a "how it works" disclosure on purpose.
