import type { GameItemDefinition } from '@/inventory/package';
import { canEditItem, isFarmIssuer } from '@/inventory/issuer';

/**
 * Client-side narrowing of an already-fetched item list.
 *
 * Relay filters do the coarse scoping (issuer, topics); these predicates do
 * everything a relay cannot index — `type`, `category` and `context` are not
 * single-letter tags, so they are not queryable and must be applied here.
 */

/**
 * Issuer scopes.
 *
 * `mine` is about the CONNECTED SIGNER, not about the Farm. A signer can own
 * plenty of items that are not official Farm items, and the official issuer is
 * somebody else's key unless you happen to hold it — so "editable by me" and
 * "Official Farm Item" are independent questions and must never be conflated.
 */
export type IssuerScope = 'all' | 'mine' | 'official' | 'external';

export interface RegistryFilters {
  /** Free text matched against name, `d` and address. */
  search: string;
  issuer: IssuerScope;
  type: string;
  category: string;
  context: string;
  topic: string;
  /** Exact issuer pubkey or npub prefix; blank means any. */
  issuerQuery: string;
}

export function blankFilters(): RegistryFilters {
  return { search: '', issuer: 'all', type: '', category: '', context: '', topic: '', issuerQuery: '' };
}

function matchesSearch(item: GameItemDefinition, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    item.name.toLowerCase().includes(needle) ||
    item.id.toLowerCase().includes(needle) ||
    item.address.toLowerCase().includes(needle)
  );
}

export interface FilterContext {
  /** The connected signer, needed only by the `mine` scope. */
  signerPubkey?: string | null;
}

export function matchesFilters(
  item: GameItemDefinition,
  filters: RegistryFilters,
  context: FilterContext = {}
): boolean {
  if (!matchesSearch(item, filters.search)) return false;

  // `mine` reuses the same predicate that decides whether Edit is offered, so
  // the filter can never disagree with the affordance on the row.
  if (filters.issuer === 'mine' && !canEditItem(context.signerPubkey, item.issuer)) return false;
  if (filters.issuer === 'official' && !isFarmIssuer(item.issuer)) return false;
  if (filters.issuer === 'external' && isFarmIssuer(item.issuer)) return false;

  if (filters.type !== '' && item.type !== filters.type) return false;
  if (filters.category !== '' && item.category !== filters.category) return false;
  if (filters.context !== '' && !item.contexts.includes(filters.context)) return false;
  if (filters.topic !== '' && !item.topics.includes(filters.topic)) return false;

  const issuerQuery = filters.issuerQuery.trim().toLowerCase();
  if (issuerQuery !== '' && !item.issuer.toLowerCase().startsWith(issuerQuery)) return false;

  return true;
}

export function applyFilters(
  items: readonly GameItemDefinition[],
  filters: RegistryFilters,
  context: FilterContext = {}
): GameItemDefinition[] {
  return items.filter((item) => matchesFilters(item, filters, context));
}

/** How many of these items the connected signer could edit in place. */
export function countEditable(
  items: readonly GameItemDefinition[],
  signerPubkey: string | null | undefined
): number {
  return items.filter((item) => canEditItem(signerPubkey, item.issuer)).length;
}

/** Distinct non-empty values of a facet, sorted, for building filter dropdowns. */
export function facetValues(
  items: readonly GameItemDefinition[],
  facet: 'type' | 'category' | 'context' | 'topic'
): string[] {
  const values = new Set<string>();
  for (const item of items) {
    if (facet === 'type') values.add(item.type);
    else if (facet === 'category') { if (item.category) values.add(item.category); }
    else if (facet === 'context') for (const c of item.contexts) values.add(c);
    else for (const t of item.topics) values.add(t);
  }
  values.delete('');
  return [...values].sort();
}

/**
 * Sort for display: official items first, then by name.
 *
 * Ordering is presentation only — it never implies an external item is less
 * valid, and the issuer badge says which is which on every row regardless.
 */
export function sortForDisplay(items: readonly GameItemDefinition[]): GameItemDefinition[] {
  return [...items].sort((a, b) => {
    const officialA = isFarmIssuer(a.issuer) ? 0 : 1;
    const officialB = isFarmIssuer(b.issuer) ? 0 : 1;
    if (officialA !== officialB) return officialA - officialB;
    return a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
}
