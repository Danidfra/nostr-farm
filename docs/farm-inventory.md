# Farm inventory: `farm:main`, spends and folds

The Farm owns exactly one kind:31633 inventory context per player:

```
31633:<player-pubkey>:farm:main
```

Harvested produce is credited there as official kind:31632 items (Carrot,
Parsnip, Pumpkin, Strawberry). Those items are deliberately cross-game: another
game may consume them. This document describes only what the **Farm** does
about that. The protocol itself — kind:1416 Game Inventory Spend and kind:1417
Game Inventory Fold Manifest — is specified in
[`@nostr-games/inventory`](https://github.com/Danidfra/nostr-games-inventory)
(`docs/1416-1417-game-inventory-spend.md`), and that specification is
canonical. Nothing here restates or reinterprets it.

## The one-writer rule

| Who | May do | May not do |
| --- | --- | --- |
| The Farm | replace `farm:main` (kind:31633); publish kind:1417 manifests for it | publish a kind:1416 of its own; write any other game's inventory |
| Any other game | publish a player-signed kind:1416 that debits `farm:main` | replace `farm:main`; publish a kind:1417 for it |

A consuming game never replaces the Farm's snapshot. It publishes a spend that
names the **full** inventory address, the **full** item address and a
positive integer quantity, signed by the player. Two applications replacing the
same addressable event would silently destroy each other's writes; the spend
model is what makes that unnecessary.

## What the Farm reads

`useFarmInventory` does not show the raw snapshot. It shows the **effective**
inventory:

```
effective = snapshot − applied pending spends
```

where "pending" means "not settled by the fold chain the snapshot references".
The derivation runs in `src/inventory/effective-inventory.ts` and delegates
every rule — author must equal owner, `(created_at, id)` ordering, overdraw
rejected in full, folded ids excluded, voided ids permanently closed — to the
package's `resolveGameInventoryState`. The Farm only fetches.

What is fetched, and from where:

- the snapshot: `kinds:[31633]`, `authors:[player]`, `#d:[farm:main]`;
- spends: `kinds:[1416]`, `authors:[player]`, `#a:[31633:<player>:farm:main]` —
  **never with `since`**. A spend older than the snapshot that is not in its
  chain is still pending, and a timestamp cut-off would lose it;
- manifests: `kinds:[1417]`, `authors:[player]`, `#a:[…farm:main]` when the
  snapshot carries a fold reference, then any still-missing manifest by id,
  on the configured relays plus each relay hint the chain carries.

All three go to every relay in `INVENTORY_RELAYS` (the same cross-client set the
Item Registry publishes to) and are deduplicated by event id. This is not a
claim of global completeness; no relay set gives that.

### Live: the ledger and its tail

The displayed balance reacts to events other games publish while the Farm is
open. The read side keeps a **ledger** (`src/inventory/ledger.ts`) for the
player's `farm:main` — the canonical snapshot plus every valid spend and
manifest seen, keyed by id — and derives the view from it with
`resolveGameInventoryState`. `src/hooks/farm/inventory-live.ts` keeps it fed:

```
subscribe: one REQ per inventory relay, the same three filters as above
    │  (events held until the fetch below has committed)
authoritative fetch → commit (merge) → flush held events → live
live EVENT → admit → re-derive → UI
```

The order is enforced, not scheduled: the query's `queryFn` waits on a gate
the controller opens only after every `REQ` has been sent, so React's own
ordering of the mount fetch and the effect cannot put the read first.

- **Admission** is a gate, not a derivation: an event enters only if it is the
  owner's own, well-formed per the package's parser, and scoped to the full
  `31633:<player>:farm:main` address. Whether a spend is pending, folded,
  voided or an overdraw is the package's decision at derivation time.
- **Merging is monotonic.** Spends and manifests are unioned by id; the
  snapshot only moves to a newer `created_at` (lowest id on a tie). A fetch
  that returns after a live event is merged into the cache at TanStack Query's
  commit (`structuralSharing`), so a stale response cannot erase a spend, a
  manifest or a newer snapshot the tail already delivered.
- **Settlement is continuous.** When the Farm folds a pending spend and
  publishes the new snapshot, the manifest arrives, then the snapshot; the
  chain then excludes the spend that the old view was subtracting. `4 − 2 = 2`
  becomes a snapshot of `2` with nothing pending — never `0`. A snapshot whose
  manifest has not arrived yet is *unresolved* (see below) until it does; the
  live side fetches the missing manifest by exact id, and while it stays
  missing keeps one timer armed for the next attempt at a delay that doubles
  up to five minutes. The timer exists only because that manifest is missing:
  its arrival, resolution, a different missing head, or unmount clears it.
- **Recovery is event-driven, not polled.** A relay reconnect re-sends the
  `REQ` and replays (Nostrify); the second `EOSE` triggers an authoritative
  refetch. A `CLOSED` or failed subscription is reopened after a capped
  exponential backoff for as long as the Farm is open, and the refetch that
  covers the gap is sent only after the new `REQ` is out. Coming back online
  refetches. There is no
  interval and no `since` watermark: every read asks for the whole ledger and
  the merge keeps what is newest.
- **Nothing partial is shown.** Until the first authoritative fetch has
  committed, live events are held rather than displayed: the snapshot without
  its spends is not a balance.

The harvest write path does not consume this cache. `creditHarvest` performs
its own confirmed read inside the write lock, as before; after an accepted
write the signed snapshot, its manifest and the spends it saw are merged into
the ledger so the counter is right at once.

### The unresolved state

If the snapshot references a manifest the Farm cannot retrieve or verify —
missing, malformed, scoped to another inventory, wrong author, cyclic, or
claiming a spend it could not have settled — there **is no balance**. The
package refuses to derive one, and so does the Farm:

- the read model reports `status: 'unresolved'` with the problems, `produce`
  empty and `inventory: null`. The top bar shows "Produce unavailable" rather
  than the raw numbers, because the raw numbers could include items another
  game already consumed;
- a harvest is **blocked** (`creditHarvest` returns `unresolved`, signs nothing,
  and the crop stays planted).

Falling back to the raw quantities would resurrect consumed items. Falling
back to "everything is pending" would debit the player twice. Neither is done.

## What the Farm writes

There is no background folding job and no periodic write. The Farm settles
spends **only when it is already replacing the snapshot**, which today means
the harvest credit. Inside the same write lock as before:

```
confirmed read of farm:main
→ resolve the fold chain, read the candidate spends
→ derive against the PRE-HARVEST snapshot: applied / rejected, effective
→ preflight the harvest mutation (package rules: stack limits, addresses)
→ if anything was applied or rejected:
     build one kind:1417  (applied → spend, rejected → void,
                           previous → the snapshot's current fold)
     sign it, publish it, require acceptance
→ add the harvested unit to the EFFECTIVE inventory
→ build the kind:31633 through the lossless round-trip,
     fold → the new manifest, or the base's own reference if none was made
     revision → previous + 1, created_at strictly after the base
→ sign it, publish it
```

The manifest input comes from the package's `toBuildGameInventoryFoldInput`;
the Farm does not classify spends itself.

### Settle first, then harvest

Spends are evaluated against the inventory as it stood **before** the harvest.
A spend that overdrew at its deterministic position is voided in the manifest
and stays void forever — it does not become applicable because this same write
adds stock:

```
snapshot: Strawberry 0      pending S1: spend 1 Strawberry      harvest: +1
→ manifest: void S1;  new snapshot: Strawberry 1        (not 0)
```

`src/inventory/credit-harvest.test.ts` pins this.

### Nothing to settle

When no pending spend is applied or rejected, no manifest is written and the
new snapshot keeps the base's fold reference unchanged. Dropping it would make
every spend in the chain pending again. A no-spend harvest is otherwise
byte-for-byte the write it was before: same revision rule, same `created_at`
rule, same `farm-harvest` idempotency markers, same preserved tags.

### With no snapshot at all

A first inventory is still only created after a **confirmed** empty read. If
spends against the address exist anyway, the derivation runs against an empty
base: every such spend is an overdraw, and the first snapshot references a
first manifest that voids them.

## Failure handling

| Situation | What happens |
| --- | --- |
| Manifest rejected by every relay | No snapshot is built. Nothing credited. Crop stays. Retry is safe. |
| Manifest publish ambiguous | The exact id is looked up on the configured relays. Found → it is established and the write continues. Not found → `fold-unconfirmed`; nothing credited; the signed manifest is remembered by the tab. |
| Manifest accepted, snapshot rejected | The manifest is an orphan: it settles nothing, the old snapshot stays authoritative, the spends stay pending. The manifest is remembered by the tab. |
| Manifest accepted, snapshot ambiguous | Existing reconciliation: re-read, look for the harvest marker. Found → done. Not found → the orphan is remembered; retry is safe. |
| Retry after any of the above | The transaction re-derives from the authoritative snapshot. If the manifest it now needs is the **same** manifest (same previous, same spends, same voids), the remembered signed event is republished as-is; otherwise a fresh one is signed. A remembered manifest is never treated as settled on its own — only a snapshot that references it settles anything. |
| Chain unresolved | Nothing is signed. See above. |
| Package refuses the mutation (e.g. stack overflow) | Fails in the preflight, before any manifest is published. |

The "remembered manifest" lives in memory per tab (`useFarmActions`). After a
reload the retry signs a semantically identical manifest with a different id;
both exist, only the one the new snapshot references counts. Harmless.

## Cache behaviour

There is one query (`farm-inventory`) holding the ledger and the view derived
from it, so a stale spend list cannot be subtracted from a fresh snapshot.
After an accepted write the signed snapshot **plus the manifests and spends
the transaction saw, including the manifest it just published** are merged
into that ledger, so a spend that snapshot folded is excluded by the chain
rather than subtracted a second time. The query is then invalidated and
refetched from the relays; the refetch merges, it does not replace.

## Revision, markers, and what did not change

- `revision` stays advisory and independent of folding. A folding snapshot is
  an ordinary replacement at `previous + 1`.
- `["e", "<consumed-plant-event>", "<relay>", "farm-harvest"]` markers are
  still written, for reconciling an ambiguous publish by exact id and for
  change attribution. They are no longer what prevents a second credit; the
  per-plot record below is. kind:1417 settles spends; it does not replace
  either, and the round-trip preserves both.
- Same-origin Web Lock + per-tab serialization, the confirmed empty read, the
  fresh read inside the lock, monotonic `created_at`, multi-relay publish and
  read-back reconciliation are all unchanged.

## Harvest identity: the planting, not the event

A credit used to be keyed on the id of the kind:31417 event being consumed.
That id changes every time the plant is watered — one planting is E1 when
sown, E2 after the first watering, E3 after the next — so two harvesters
holding different versions of the same ripe plant presented different ids and
**both credited it**. Two tabs of one browser could do it (the Web Lock
serialises them, but the keys differ); two devices could do it with no lock
at all.

A planting is now identified by `(slot d, plantedAt)`. `plantedAt` is set
once by `plantSeed`, carried unchanged by every transition, and kept
strictly increasing per plot by `plantingTime` in `src/farm`
(`max(now, lastHarvestedAt + 1)`), so two cycles of one plot never share it
even under a developer tool that ripens instantly or a device whose clock
runs behind.

Each credit writes the plot's **record**:

```text
["harvest", "<slot d>", "<plantedAt>"]      one per plot: the newest planting credited there
credited(d, plantedAt)  ⇔  record(d) exists  and  record(d) ≥ plantedAt
```

A planting at or below the record is the same cycle seen through another
event, or an older cycle that resurfaced; either way it was credited, and
the harvest path takes the existing `already-applied` branch, which clears
the plant without crediting. Records are **never dropped because of their
age**: the only record ever removed is the one the new credit replaces for
the same plot. A legacy snapshot without records answers by `e` marker
alone, exactly as before, and gains a record for each plot as it is
harvested.

Legacy `e` markers are bounded to the newest 64, with one exception: a
marker whose event is still the current state of some plot (as the client
last read the field) is kept whatever its age, because that event could
still be presented for harvest. With no field in hand nothing is dropped. A
dropped marker can only matter again if a relay loses the newer slot events
and an old plant event resurfaces as current **and** the plot was last
credited before records existed; from the first record onward the plot is
covered regardless.

### Before a credit: the plot and the snapshot must both be current

Two reads guard every credit, and each refuses rather than guesses:

- **The plot is re-read by `d` from the game relays** (`readPlotNow` in
  `useFarmActions`). The harvest is recomputed on what comes back: a watering
  from another device is honoured and its event is the one consumed; a plot
  holding a different planting, or nothing, is refused with "changed from
  another device"; a read in which no relay reached `EOSE` is refused even if
  the plant was seen, because presence proves nothing about what replaced it.
- **The snapshot must not be older than one this session has seen.** The
  highest `revision` this session has read or written is remembered
  (`knownRevisions`) and passed to `creditHarvest` as `minRevision`. A
  confirmed read that returns a lower revision, no revision, or no snapshot
  at all ends in `stale-read` with nothing signed: building on it would drop
  every later harvest and could credit one again. The floor is per session;
  a fresh page load has nothing to compare against and trusts the confirmed
  read, which is the remaining multi-device gap (two devices never share a
  floor, and a relay that loses the newest snapshot between two loads is not
  detected).

Neither read makes the harvest atomic. The credit and the empty-slot publish
are still two events, and a watering from another device can still land
between them; the per-plot record is what makes that harmless.

### After a credit: one look back

Three seconds after an accepted credit (`HARVEST_VERIFY_DELAY_MS`), the
inventory is read once more (`verifyCredit`):

| Relays hold | Outcome | What happens |
| --- | --- | --- |
| our snapshot, or a later one carrying our record | `confirmed` | nothing; the harvest toast already said so |
| a newer snapshot without our record | `overwritten` | the credit runs **once** more under the same `(d, plantedAt)`; the record makes it a no-op if the harvest survived somewhere after all; "Harvest saved again", or "Harvest may be missing" if that run is refused |
| nothing, an older snapshot, or no answer | `uncertain` | reported ("Harvest not yet confirmed"); never retried on no evidence |

The retry never uses a new identity and never loops. The check is one read
of the configured relays while the device is still online; it is not a
guarantee that the snapshot is durable on every relay, and a device that
goes offline inside those three seconds never looks at all.

### Scalability limitation

The record set is bounded by the number of plots ever harvested, which is 36
on every farm that exists today (about 2 KB) and will grow with the field.
It is **not** a design for an unbounded procedural world: at 256 plots per
region a nine-region farm would carry up to ~110 KB of records, beyond what
some relays accept. Before large-scale expansion ships, records have to move
out of `farm:main` — per-region (for example on the region's own kind:31416,
keyed by local plot) or into a folded, append-only credit log in the
inventory protocol — and the credit path has to read the plot's record from
wherever it lives. Until then, relay size limits must be checked against the
largest field the client allows.

## Residual limitation

Two independent Farm writer instances (two devices, or two browsers) can still
race on the replaceable snapshot: `revision` is advisory and the Web Lock is
same-origin only. Both derive, both fold, both publish; the loser's own
harvest is lost exactly as before this milestone. The spend protocol solves
**cross-application debit coordination**, not distributed owner-writer
consensus. Readers still never double-debit: whichever chain wins, each spend
is excluded once. The loser never double-**credits** either: the record is
keyed on the planting, so re-crediting the lost harvest is idempotent.

## Dependency

The spend protocol is implemented in `@nostr-games/inventory` 0.5.0, which
`package.json` takes from npm (`^0.5.0`).

## For a consuming game

To consume a Farm item, publish a kind:1416 signed by the player with exactly:

```json
["a", "31633:<player-pubkey>:farm:main", "<relay>", "inventory"]
["a", "31632:<farm-issuer-pubkey>:farm:produce:<slug>", "<relay>", "item"]
["quantity", "<positive-integer>"]
```

Publish it to the relays in `INVENTORY_RELAYS` (`src/inventory/constants.ts`),
which is where the Farm looks. Read the balance the same way the Farm does —
snapshot, chain, spends, `resolveGameInventoryState` — and expect that a spend
which overdraws at its deterministic position will be **voided** by the Farm's
next snapshot, permanently. Never replace `farm:main`, never write a kind:1417
for it, and never identify the inventory or the item by `d` alone.
