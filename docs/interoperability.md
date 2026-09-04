# How Farm produce travels between games

Nostr Farm never talks to another game. It writes signed Nostr events to
public relays, and any application that reads the same events can use what
the player grew. That is the whole integration surface: **state
interoperability happens through Nostr**, and no shared runtime, API, SDK
hand-off or message bridge exists between the Farm and anything else.

Blobbi Island is the first independent application to consume Farm produce.
It runs its own code on its own origin, reads the player's Farm inventory
from relays, and publishes its own spend events. The Farm does not know
Blobbi Island exists; it only knows how to read a spend.

## The events

| Kind | Name | Who writes it | What it says |
| --- | --- | --- | --- |
| `31632` | Game Item Definition | the Farm issuer key | "Carrot is an official Farm item" (addressable, `farm:produce:carrot`) |
| `31633` | Game Inventory | the player, through the Farm | "This player holds N carrots in `farm:main`" (addressable, replaceable) |
| `1416` | Game Inventory Spend | the player, through **another** game | "Debit 2 pumpkins from `farm:main`" (immutable) |
| `1417` | Game Inventory Fold Manifest | the player, through the Farm | "These spends are now settled into the snapshot" (immutable) |

All four are specified and implemented once, in
[`@nostr-games/inventory`](https://github.com/Danidfra/nostr-games-inventory).
Every game in the ecosystem uses the same parser, the same validation and the
same resolver, so they agree on every balance by construction.

## The flow

```text
  Nostr Farm                         relays                       another game
  ──────────                         ──────                       ────────────
  harvest a strawberry
  └─ publish kind:31633 ──────────►  farm:main snapshot  ────────►  reads the snapshot,
     (strawberry: 1)                                                 shows "1 strawberry"

                                                                    player uses it
  live subscription                                                 └─ publish kind:1416
  receives the spend  ◄────────────  spend: strawberry −1  ◄───────    (signed by the player)
  └─ effective balance
     = snapshot − pending spends
     = 0   (no refresh, no poll)

  next harvest (+1)
  └─ publish kind:1417 ──────────►  fold manifest (settles −1)
  └─ publish kind:31633 ──────────►  new snapshot (strawberry: 1) ─►  reads the new snapshot,
     referencing the manifest                                        sees 1, not 2 and not 0
```

Three rules make this safe:

1. **One writer per snapshot.** Only the Farm replaces `farm:main`. A
   consuming game never rewrites it; it appends a spend. Two applications
   replacing the same addressable event would silently destroy each other's
   writes.
2. **Effective, not raw.** Every reader, the Farm included, shows
   `snapshot − pending spends`, where pending means "not yet settled by the
   fold chain the snapshot references". A spend is debited exactly once, and
   an overdraw is rejected in full.
3. **Settle, then credit.** When the Farm next replaces the snapshot, it first
   folds the pending spends into a `kind:1417` manifest, then adds the new
   harvest on top of the *effective* balance. Snapshot 0, pending spend −1,
   harvest +3 yields 3, never 2.

If a snapshot points at a manifest the Farm cannot retrieve or verify, there
is no balance to show. The Farm says "produce unavailable" and refuses to
harvest rather than guess in either direction.

## What the Farm knows about the other game

Only what the spend says. A `kind:1416` may carry a self-declared `client`
tag; when it does, the Farm shows "Used in *that name*", and when it does not,
"Used in another Nostr game". The Farm keeps no list of consumers and grants
none of them special treatment.

## Launching the Farm from another app

The Farm is an ordinary web app at a public URL. An app that wants to offer
it should open that URL in a new tab or window. That keeps the Farm's own
storage, its signer integrations and its cross-tab write lock intact. Nothing
about the accounting depends on how the page was opened.

## Reading and writing as a consuming game

Publish a `kind:1416` signed by the player with exactly:

```json
["a", "31633:<player-pubkey>:farm:main", "<relay>", "inventory"]
["a", "31632:<farm-issuer-pubkey>:farm:produce:<slug>", "<relay>", "item"]
["quantity", "<positive-integer>"]
```

Publish it to the relays the Farm reads (`INVENTORY_RELAYS` in
`src/hooks/farm/inventory-relays.ts`). Read the balance the way the Farm does:
snapshot, fold chain, spends, `resolveGameInventoryState`. Never replace
`farm:main`, never publish a `kind:1417` for it, and never identify an
inventory or an item by its `d` tag alone. The Farm-side details are in
[farm-inventory.md](./farm-inventory.md).
