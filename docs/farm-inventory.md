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

`useFarmInventory` no longer shows the raw snapshot. It shows the **effective**
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

There is one query (`farm-inventory`) holding the whole derived view, so a
stale spend list cannot be subtracted from a fresh snapshot. After an accepted
write the view is set directly from the signed snapshot **plus the manifests
and spends the transaction saw, including the manifest it just published**, so
a spend that snapshot folded is excluded by the chain rather than subtracted a
second time. The query is then invalidated and refetched from the relays as
before.

## Revision, markers, and what did not change

- `revision` stays advisory and independent of folding. A folding snapshot is
  an ordinary replacement at `previous + 1`.
- `["e", "<consumed-plant-event>", "<relay>", "farm-harvest"]` markers remain
  the harvest idempotency mechanism. kind:1417 settles spends; it does not
  replace this marker, and the round-trip preserves it exactly as before.
- Same-origin Web Lock + per-tab serialization, the confirmed empty read, the
  fresh read inside the lock, monotonic `created_at`, multi-relay publish and
  read-back reconciliation are all unchanged.

## Residual limitation

Two independent Farm writer instances (two devices, or two browsers) can still
race on the replaceable snapshot: `revision` is advisory and the Web Lock is
same-origin only. Both derive, both fold, both publish; the loser's own
harvest is lost exactly as before this milestone. The spend protocol solves
**cross-application debit coordination**, not distributed owner-writer
consensus. Readers still never double-debit: whichever chain wins, each spend
is excluded once.

## Dependency

The spend protocol is implemented in `@nostr-games/inventory` at commit
`c3e777e`, which is not yet released to npm. Until it is, `package.json` links
the sibling checkout (`file:../nostr-games-inventory`, built with `pnpm build`
in that repository). Replace the link with the released version when it ships.

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
