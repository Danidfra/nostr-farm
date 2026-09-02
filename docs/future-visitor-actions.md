# Future: visitor actions

**Not implemented. Nothing in this repository publishes or consumes a visitor
action event.** This document records the design so today's boundaries stay
compatible with it.

## The idea

Later, a player may visit a neighbour's farm and help — watering, most likely.
The visitor cannot be allowed to write the farm's authoritative state, because
that state is owned by the farm's pubkey.

## The shape it would take

```
visitor  ──► regular action event (intent)
                     │
farm owner ──► validate permission + run the SAME pure transition
                     │
farm owner ──► publish the resulting SlotState (31417)
```

The candidate kind is **1415** — a regular event kind, so every action is kept.
We checked current relay usage and found nothing apparent, but that is **not**
a formal kind registration and the protocol has not been reviewed. `1415` is
recorded in `src/nostr/kinds.ts` as
`RESERVED_VISITOR_ACTION_KIND_CANDIDATE` purely so the number is not reused by
accident.

Do **not** repeat the v1 mistake of putting a many-events-needed kind in the
replaceable range (see [state-model.md](./state-model.md)).

## Why today's code is already ready

The seam is `applyFarmAction(slot, action, catalog)` in
`src/farm/slots/transitions.ts`:

```ts
applyFarmAction(slot, { type: 'water', nowSec, cropId }, CROP_CATALOG)
```

It is a pure function of `(slot, action, catalog)`. It has no notion of *who*
asked. In V1 the asker is the owner; a visitor flow adds an authorization step
in front of the same call and publishes the same result.

Adding visitors therefore requires:

1. a new event kind and its parser, in `src/nostr/`
2. a permission check, in the application layer
3. an owner-side subscription that reacts to intents

and **zero** changes to `src/farm`.
