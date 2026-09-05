# Pre-alpha security audit (September 2026)

Notes from the pass made before sharing Nostr Farm with early testers. The
one architectural finding was deliberately not fixed in that pass and is
recorded here so it is not rediscovered.

## Platform

Nostr Farm is a browser-only single-page app: Vite + React, served as static
files from Vercel (official) and GitHub Pages (project copy). There is no
Android/iOS wrapper, no Capacitor, Cordova, Electron, Tauri or React Native,
no service worker, and the manifest is a plain PWA manifest with no protocol
handlers. The Ditto Android class of bug (native code building JavaScript
from a link) has no equivalent surface here: the only "native → UI" edge is
the browser's own URL bar, and React Router hands the path over as data.

The application source contains no code-execution sink at all: no `eval`,
`Function`, `innerHTML`, `dangerouslySetInnerHTML`, `document.write`,
dynamic `<script>` or `javascript:` URL. Every relay-provided string (item
names, descriptions, profile names) is rendered as React text. Item image
URLs land in `<img src>` unvalidated, which is a tracking-pixel surface, not a
script one.

## Not fixed here: the secret key is stored in plaintext

The app uses `@nostrify/react`'s `NostrLoginProvider`, which persists every
login, including the raw `nsec`, as JSON in `localStorage` under
`nostr-worlds:login`. Any script running in the origin can read it; nothing in
the app logs it, puts it in a URL or sends it anywhere, but a future XSS would
be a key-theft bug rather than a defacement bug. This is the mkstack default
shared with Blobbi Island; changing it means a signer-in-worker or
encrypted-at-rest design in the login layer, which is a product decision for
after alpha. Extension (NIP-07) and bunker (NIP-46) logins never hold the
user's key in the page.

## Defence in depth

`index.html` carries a `<meta>` CSP with `script-src 'self'` and no
`unsafe-inline`. `vercel.json` adds the headers a meta tag cannot express:
`frame-ancestors 'none'` / `X-Frame-Options: DENY` against clickjacking,
`X-Content-Type-Options: nosniff`, a `Referrer-Policy` and a restrictive
`Permissions-Policy`. The GitHub Pages copy cannot set headers and has only
the meta CSP.
