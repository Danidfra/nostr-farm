# Game Item Registry (kind:31632)

A browser and editor for Game Item Definitions, at `/items`.

## What is shared and what is Farm-specific

Every protocol concern is delegated to **`@nostr-games/inventory`**, the package
the other games in this ecosystem already use: parsing, validation, primary
image resolution, address building and event construction. The Farm carries no
second implementation of any of it, and `src/inventory/boundary.test.ts` fails
the build if a module reaches for the package outside
`src/inventory/package.ts`.

Farm-specific, and deliberately so:

| Concern | Where |
| --- | --- |
| Official issuer, registry relays, `game:farm` context | `src/inventory/constants.ts` |
| Official/external classification, edit permission | `src/inventory/issuer.ts` |
| Authoring vocabulary (types, categories, topics) | `src/inventory/registry/form-model.ts` |

No other game's semantics appear in a Farm item definition. A Farm carrot says
it is `edible`; what "edible" *does* is decided by whichever game consumes it.

## Issuer model

An item is official when, and only when:

```
event.pubkey === FARM_OFFICIAL_ISSUER_PUBKEY
```

`FARM_OFFICIAL_ISSUER_PUBKEY` is `f47aaf2e…199fb4`
(`npub173a27t3j08lxlnw7243nd50hgpc9zfkf5dlx8y8zah3pzegen76q8fl9lm`), fixed in
source. There is deliberately **no environment override and no runtime
configuration**: "official" is a claim about one specific public identity, and a
build-time variable that could make a different key render as official would
turn the badge into something an operator can forge.

It is a public identifier; no secret key is stored, derived or read anywhere in
the application.

Every row shows **Official Farm Item** or **External Item** plus the abbreviated
npub. External is not a synonym for invalid: anybody may publish a kind:31632
event with any `d`, and two issuers using the same `d` are simply two different
items. What the registry guarantees is that an external item can never be
mistaken for an official one.

Items are always identified by the full address `31632:<pubkey>:<d>`. A `d`
alone is never treated as globally unique — not in the cache key, not in
de-duplication, not in the copy button.

## Browse

The default query scope asks the registry relays only for the official issuer's
items, which is a single indexed `authors` query. **All Nostr items** is an
explicit opt-in that drops the author filter.

Relay outcomes are distinguished rather than flattened: if some relays answer
their results are used; if **every** relay fails the query fails and the UI
shows the error, because "nobody answered" and "everybody answered, there is
nothing" look identical on an empty page and only one of them means the registry
is empty. A successful query returning no valid items is a legitimate empty
list.

Client-side filters cover search (name, `d`, address), issuer scope, issuer
pubkey prefix, type, category, context and topic. `type`, `category` and
`context` are not single-letter tags and therefore are not relay-indexable, so
they are necessarily applied after fetching.

The primary image comes from the package's `getPrimaryItemImage`, which
implements the spec rule: first unmarked image, else first valid image, else
none.

## Create and edit

Core fields are always visible; `model_3d`, `audio`, `version`, `alt`, effects,
metadata, `visual` and `based_on` live behind **Advanced**.

`type`, `category`, `context` and `t` are open strings on the wire, so every
picker is a suggestion list beside a free-text input, never a closed enum.

The `alt` tag is generated automatically as `Game item definition: <name>`; an
explicitly typed value wins.

Content is JSON and never duplicates tag metadata. Top-level content keys the
editor does not model are preserved verbatim, as are tags it does not manage, so
editing a definition published by a newer client cannot silently drop anything.

kind:31632 is addressable, so re-publishing with the same author and `d`
replaces the definition. **Edit is offered only when the connected signer is the
item's issuer** — publishing somebody else's item under your own key creates a
*different* item, which the UI offers separately as "Use as template" and
records as a `based_on` derivation.

### `d` is immutable during an in-place edit

`d` is half the item's address, so changing it during an edit would not edit
anything — it would create a second item and silently leave the original
behind. Once a form is loaded from the signer's own published definition the
`d` input is disabled, and two further guards make that structural rather than
cosmetic: `ItemForm` drops a `d` change while locked, and the page runs
`applyFormEdit`, which pins `d` to the loaded value whatever it is handed. The
"re-publishing replaces it" banner is shown only while `isInPlaceEdit` is true,
i.e. while the address genuinely still matches.

Creating a new identity from an existing definition stays an explicit action:
"Use as template" clears the provenance, unlocks `d`, and records the original
as a `based_on` reference.

## Blossom images

`useUploadFile` builds a `BlossomUploader` against `blossom.primal.net` and
authorizes it with the user's own signer. The queue in
`useItemImageUpload` uploads files one at a time (a signer prompted for five
signatures at once is a worse experience, and some signers simply fail), and
suggests a view marker from the filename — `carrot-side-left.png` proposes
`side-left` — always shown for editing before it is applied.

An upload does exactly one thing: it puts a URL into an image row. It never
signs an item definition and never publishes.

Only an explicit `["url", "<value>"]` tag counts as a result, and the value must
parse as an `http:`/`https:` URL. An upload that yields no usable URL is a
failed upload, not an item with a hash where its artwork should be.

Partial failure is preserved: successful uploads are applied to the form and
dropped from the queue, while failures stay listed with their error and can be
retried. `uploadAll` skips entries that already succeeded, so a retry never
uploads or re-applies the same image twice.

Markers supported: `front`, `side-right`, `side-left`, `back`,
`diagonal-front-right`, `diagonal-front-left`. None are required. The editor
warns when there is no unmarked image, or more than one.

## Publishing

The review dialog shows the exact unsigned event — `kind`, `content`, `tags` —
because that, not the form, is what gets signed. **The publisher signs the
template verbatim**: it appends, removes and reorders nothing, so the reviewed
event and the signed event cannot drift. Tags the app wants on everything it
publishes (`client`) are added during template construction, before the review,
which is why the review shows them. Publishing happens only from the explicit
button there; it is never wired to a form change, a blur, or the completion of
an upload.

The event is signed with `useCurrentUser().user.signer` and offered to every
registry relay individually, with each relay's answer reported. This does not go
through `useNostrPublish`, which targets the single game relay and reports
success generously — right for gameplay writes, wrong for a tool whose job is to
tell you what actually reached the network.

On success the caches are updated so the item appears immediately, and its full
address is shown with a copy button.
