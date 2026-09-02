import { nip19 } from 'nostr-tools';

import { FARM_ISSUER_PUBKEY } from './constants';

/**
 * Who issued an item, and who is signing.
 *
 * The entire trust story of the registry is one comparison: an item is
 * official when its event author is the Farm issuer. Everything else is
 * external.
 *
 * External is NOT a synonym for invalid or malicious. Anybody may publish a
 * kind:31632 event with any `d` from any client, and that is the protocol
 * working as designed — two issuers using the same `d` are simply two
 * different items. What the registry must never do is let an external
 * definition *look* official, so the classification is computed in one place
 * and shown on every row, in the editor header and in the publish review.
 */

export type IssuerKind = 'official' | 'external';

export interface IssuerIdentity {
  kind: IssuerKind;
  pubkey: string;
  /** bech32 `npub…`, or `null` when encoding fails. */
  npub: string | null;
  /** Abbreviated npub for dense UI, falling back to abbreviated hex. */
  short: string;
  isOfficial: boolean;
}

/** Abbreviate an identifier as `abcdefgh…123456`. */
export function abbreviate(value: string, lead = 8, tail = 6): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * Encode a pubkey as an npub, or return `null`.
 *
 * Never throws: a malformed pubkey is a display problem, not a crash, and this
 * runs inside list rows that must render whatever a relay returned.
 */
export function safeNpub(pubkey: string | null | undefined): string | null {
  if (!pubkey) return null;
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

/** Is this pubkey the official Farm item issuer? */
export function isFarmIssuer(pubkey: string | null | undefined): boolean {
  return !!pubkey && pubkey === FARM_ISSUER_PUBKEY;
}

/** Describe an item's issuer for display. */
export function describeIssuer(pubkey: string): IssuerIdentity {
  const npub = safeNpub(pubkey);
  const isOfficial = isFarmIssuer(pubkey);
  return {
    kind: isOfficial ? 'official' : 'external',
    pubkey,
    npub,
    short: npub ? abbreviate(npub, 10, 6) : abbreviate(pubkey),
    isOfficial,
  };
}

/** Human label for an issuer classification. */
export function issuerLabel(kind: IssuerKind): string {
  return kind === 'official' ? 'Official Farm Item' : 'External Item';
}

export type SignerMode = 'signed-out' | 'official' | 'external';

export interface SignerIdentity {
  mode: SignerMode;
  pubkey: string | null;
  npub: string | null;
  short: string | null;
  /** The signer IS the Farm issuer. */
  isOfficialIssuer: boolean;
  /** Publishing is possible at all (i.e. there is a signer). */
  canPublish: boolean;
}

/**
 * Describe the connected signer.
 *
 * An external signer may publish. Refusing would be theatre — the same event
 * can be published from any other client — and it would also block the honest
 * case of somebody authoring their own Farm-compatible items. What matters is
 * that the resulting item is labelled by its actual issuer everywhere.
 */
export function describeSigner(pubkey: string | null | undefined): SignerIdentity {
  if (!pubkey) {
    return { mode: 'signed-out', pubkey: null, npub: null, short: null, isOfficialIssuer: false, canPublish: false };
  }
  const npub = safeNpub(pubkey);
  const isOfficialIssuer = isFarmIssuer(pubkey);
  return {
    mode: isOfficialIssuer ? 'official' : 'external',
    pubkey,
    npub,
    short: npub ? abbreviate(npub, 10, 6) : abbreviate(pubkey),
    isOfficialIssuer,
    canPublish: true,
  };
}

/**
 * May the connected signer edit and re-publish this item definition?
 *
 * kind:31632 is addressable: re-publishing with the same author and `d`
 * replaces the definition. So editing is only meaningful — and only possible —
 * when the signer IS the item's issuer. Editing somebody else's item would
 * silently create a *different* item under your own key, which is a derivation,
 * not an edit, and the UI offers that separately.
 */
export function canEditItem(signerPubkey: string | null | undefined, itemIssuer: string): boolean {
  return !!signerPubkey && signerPubkey === itemIssuer;
}
