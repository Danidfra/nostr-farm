# Growth model

Implemented in `src/farm/growth/evaluate.ts`. Specified by
`src/farm/growth/evaluate.test.ts` — the tests describe intent, not
implementation, and are the authority if this document drifts.

## Persisted state

A planted crop is exactly five fields:

| Field | Meaning |
| --- | --- |
| `cropId` | which crop, resolved against the catalog |
| `plantedAt` | when the seed went in |
| `growthSec` | growth seconds banked as of `growthUpdatedAt` |
| `growthUpdatedAt` | reference point for accruing more growth |
| `wetUntil` | the crop is wet while `now < wetUntil` |

Nothing derived is stored. No `stage`, no `ready_at`, no `expires_at`, no
`watered_at`, no `water_count`.

## The single equation

```
totalGrowth(now) = growthSec + max(0, min(now, wetUntil) - growthUpdatedAt)
```

Growth accrues **only while wet**, because the accrual window is clipped at
`wetUntil`.

## Rules

| Rule | Statement | Boundary |
| --- | --- | --- |
| Wetness | wet while `now < wetUntil` | at exactly `wetUntil` the crop is dry |
| Growth | only wet time accrues | dry time contributes exactly zero |
| Stage | `floor(totalGrowth / stageDurationSec)`, clamped to `[0, harvestStage]` | inclusive: exactly `n × stageDurationSec` is stage `n` |
| Harvestable | `stage >= harvestStage` and not rotten | — |
| Rot | rotten once `now >= wetUntil + rotAfterDrySec` | inclusive |
| Wet crops never rot | follows from `rotAfterDrySec >= 1` | no special case needed |

## Planting

A seed starts **dry** (`wetUntil === plantedAt`). It does not grow until it is
watered, and it rots `rotAfterDrySec` after planting if it never is.

## Watering

```
growthSec        := totalGrowth(now)          // bank what was earned
growthUpdatedAt  := now
wetUntil         := min(max(wetUntil, now) + waterDurationSec,
                        now + maxWetBufferSec)
```

- Watering a dry crop **resumes** progression; it never credits the dry gap.
- Watering a wet crop **extends** from the existing `wetUntil`, so nothing is
  wasted, up to `maxWetBufferSec` ahead of `now`.
- A watering that would be entirely discarded by the cap is rejected as
  `already_saturated` rather than silently swallowed.
- Watering a ripe crop is allowed: it does not grow further, but the wetness
  postpones rot, which is how a player protects a ripe crop.

## Why it is deterministic

The whole model is a function of `(state, now)`. Evaluating at `t` a thousand
times, or jumping straight from `t` to `t + 10 years`, gives the same answer.
Consequences:

- No banked-time exploit: dry time is outside the accrual window.
- No processor: nothing has to tick, so nothing can fall behind or race.
- Two clients agree without talking to each other.

## Bugs found in the previous implementation

1. **Stage progression was not a function of time.**
   `computeGrowthStageWithWater` advanced *at most one stage per call*, and
   required a background processor to persist each step. Evaluating once after
   ten stage durations returned `+1` stage. Growth therefore depended on how
   often somebody happened to be looking.
2. **Derived values were persisted and could disagree.**
   `stage`, `ready_at` and `expires_at` were written to relays alongside the
   inputs they were derived from, so a formula change silently invalidated
   stored state.
3. **`computeReadyTime` ignored the wetness model.**
   It returned `plantedAt + harvestStage × stageDurationSec` — wall-clock time
   from planting — while actual progression required wet time. The two never
   agreed for any crop that was ever dry.
4. **A wetness epsilon papered over a boundary bug.**
   `WET_EPSILON_SEC = 2` made a crop count as wet for two seconds after
   `wetUntil`. The new inclusive/exclusive boundaries are exact and the epsilon
   is gone.
5. **Rot could not be reasoned about locally.**
   `isRotten` depended on a stored `expires_at` that only the processor
   maintained, so a crop with a missing tag could never rot.
6. **Crop config and code disagreed.**
   `waterDurationSec` and `maxWetBufferSec` were read by the code but absent
   from `crops.json`, so every crop silently fell back to defaults.
7. **The rotten sprite path was wrong.**
   `crops.json` declared `crops/crop-rotten.png` while every other path was
   relative to the pack root. Normalized on read in the renderpack loader.
