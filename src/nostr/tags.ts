import type { NostrEvent } from '@nostrify/nostrify';

/** An unsigned event ready to hand to a signer. */
export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

export function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(([tagName]) => tagName === name)?.[1];
}

export function getTagValues(event: NostrEvent, name: string): string[] | undefined {
  return event.tags.find(([tagName]) => tagName === name);
}

/** Parse a tag that must hold a whole number; `undefined` when absent or invalid. */
export function getIntTag(event: NostrEvent, name: string): number | undefined {
  const raw = getTag(event, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}
