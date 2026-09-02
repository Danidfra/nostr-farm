# Renderpacks

A renderpack supplies **artwork and sprite geometry only**. Gameplay numbers
live in `src/farm/crops/catalog.ts`, under version control and code review.

## The problem this fixes

The previous client read its renderpack from:

```
https://raw.githubusercontent.com/Danidfra/farm-nostr-game/master/renderpacks/cozy-pixel-v1
```

That URL tracks a branch. Any push to the art repository changed every running
game instantly, and a bug report could not be tied to the assets that produced
it. Worse, gameplay timings lived in `crops.json`, so an art commit could
rebalance the game.

## Pinning

`src/world/renderpack/registry.ts` is the only file allowed to name a renderpack
URL. Each release pins a full 40-character commit SHA and is served through a
CDN that honours the pin:

```
https://cdn.jsdelivr.net/gh/Danidfra/farm-nostr-game@26bf77115a46fea907bc0a5e1c135a3501a59be4/renderpacks/cozy-pixel-v1
```

`WorldState` events carry only `renderpack` + `renderpack_version`. An unknown
reference is refused outright rather than falling back to a mutable URL, and the
resolved version is shown in the game's top bar.

`src/world/world.test.ts` fails the build if any release references
`master`/`main`/`HEAD` or `raw.githubusercontent.com`, or if a commit is not an
exact 40-hex SHA.

## Publishing a new version

1. Commit and **push** the artwork change in `Danidfra/farm-nostr-game`.
2. Add a new entry to `RENDERPACK_RELEASES` with the new commit SHA and a new
   version string. Do not edit an existing entry — old worlds keep resolving to
   the assets they were built against.
3. Point maps and/or `DEFAULT_RENDERPACK_REF` at the new version.

## Relationship to `farm-nostr-game`

That repository holds artwork and nothing else this app depends on for rules.

- Its `renderpacks/` directory is consumed, pinned, by this app.
- Its `docs/` copies of the 31415/31416/31417/14159 specs are **stale**: they
  describe v1, including the dead kind 14159. `docs/` in *this* repository is
  authoritative. No spec copy is maintained there — that is how the two drifted.

## Load failures

`loadRenderpack` throws `RenderpackLoadError` carrying the pinned reference and
the exact URL that failed, and the Farm page shows both. Failure modes handled
explicitly: unknown ref, unreachable host, non-2xx response, invalid JSON,
missing `tileSize`, missing `crops` dictionary, no usable sprites.

## Known quirks normalized on read

`cozy-pixel-v1` declares crop sheets as `assets/crops/<name>.png` but the rotten
sprite as `crops/crop-rotten.png`. Rather than mutate published artwork, the
loader normalizes any path lacking an `assets/` prefix.
