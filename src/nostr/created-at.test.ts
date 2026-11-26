import { beforeEach, describe, expect, it } from 'vitest';

import {
  forgetSessionStamps,
  isReplaceableKind,
  MAX_FUTURE_SKEW_SEC,
  replaceableAddress,
  stampAfter,
  stampReplaceable,
} from './created-at';

const NOW = 1_800_000_000;
const PLOT = '31417:' + 'a'.repeat(64) + ':slot:farm.field:1:1';

beforeEach(() => forgetSessionStamps());

describe('stampAfter', () => {
  it('uses the clock when there is no predecessor', () => {
    expect(stampAfter(undefined, NOW)).toEqual({ createdAt: NOW, previousAhead: false });
  });

  it('uses the clock when the predecessor is in the past', () => {
    expect(stampAfter(NOW - 10, NOW)).toEqual({ createdAt: NOW, previousAhead: false });
  });

  it('steps one second past a predecessor from the same second', () => {
    expect(stampAfter(NOW, NOW)).toEqual({ createdAt: NOW + 1, previousAhead: false });
  });

  it('follows a predecessor stamped by a device whose clock is ahead, within the bound', () => {
    expect(stampAfter(NOW + 30, NOW)).toEqual({ createdAt: NOW + 31, previousAhead: false });
    expect(stampAfter(NOW + MAX_FUTURE_SKEW_SEC - 1, NOW)).toEqual({ createdAt: NOW + MAX_FUTURE_SKEW_SEC, previousAhead: false });
  });

  it('does not chase a predecessor further ahead than the bound', () => {
    expect(stampAfter(NOW + MAX_FUTURE_SKEW_SEC, NOW)).toEqual({ createdAt: NOW, previousAhead: true });
    expect(stampAfter(NOW + 3600, NOW)).toEqual({ createdAt: NOW, previousAhead: true });
  });

  it('ignores a predecessor timestamp that is not an integer', () => {
    expect(stampAfter(Number.NaN, NOW).createdAt).toBe(NOW);
    expect(stampAfter(Number.POSITIVE_INFINITY, NOW).createdAt).toBe(NOW);
  });

  it('keeps the bound well under what relays accept from the future', () => {
    // strfry's default and the primary relay's default window are 900 s,
    // the primary relay's tightest per-kind window 300 s.
    expect(MAX_FUTURE_SKEW_SEC).toBeGreaterThan(0);
    expect(MAX_FUTURE_SKEW_SEC).toBeLessThanOrEqual(120);
  });
});

describe('stampReplaceable', () => {
  it('stamps a second write in the same second after the first, with no read in between', () => {
    const first = stampReplaceable(PLOT, undefined, NOW);
    const second = stampReplaceable(PLOT, undefined, NOW);
    expect(first.createdAt).toBe(NOW);
    expect(second.createdAt).toBe(NOW + 1);
  });

  it('takes the later of the relay hint and its own last stamp', () => {
    stampReplaceable(PLOT, undefined, NOW);
    expect(stampReplaceable(PLOT, NOW + 10, NOW).createdAt).toBe(NOW + 11);
    expect(stampReplaceable(PLOT, NOW - 50, NOW).createdAt).toBe(NOW + 12);
  });

  it('keeps addresses apart', () => {
    stampReplaceable(PLOT, undefined, NOW);
    expect(stampReplaceable(PLOT.replace(':1:1', ':2:2'), undefined, NOW).createdAt).toBe(NOW);
  });

  it('does not drift past the bound however many writes land in one second', () => {
    const stamps: number[] = [];
    for (let i = 0; i < 50; i += 1) stamps.push(stampReplaceable(PLOT, stamps.at(-1), NOW).createdAt);

    for (let i = 1; i < stamps.length; i += 1) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    expect(Math.min(...stamps)).toBe(NOW);
    expect(Math.max(...stamps)).toBeLessThanOrEqual(NOW + MAX_FUTURE_SKEW_SEC);

    // Keep going far beyond the window: still never past it.
    for (let i = 0; i < 500; i += 1) {
      const { createdAt } = stampReplaceable(PLOT, undefined, NOW);
      expect(createdAt).toBeGreaterThanOrEqual(NOW);
      expect(createdAt).toBeLessThanOrEqual(NOW + MAX_FUTURE_SKEW_SEC);
    }
  });

  it('resumes stepping once the clock catches up', () => {
    for (let i = 0; i < 100; i += 1) stampReplaceable(PLOT, undefined, NOW);
    expect(stampReplaceable(PLOT, undefined, NOW + MAX_FUTURE_SKEW_SEC).createdAt).toBe(NOW + MAX_FUTURE_SKEW_SEC + 1);
  });

  it('reports, and does not follow, a far-future predecessor from the relays', () => {
    const result = stampReplaceable(PLOT, NOW + 86_400, NOW);
    expect(result).toEqual({ createdAt: NOW, previousAhead: true });
    // Nor does it poison the next write.
    expect(stampReplaceable(PLOT, undefined, NOW).createdAt).toBe(NOW + 1);
  });
});

describe('replaceableAddress', () => {
  const pk = 'b'.repeat(64);

  it('addresses addressable events by kind, author and d', () => {
    expect(replaceableAddress(31417, pk, [['d', 'slot:x'], ['v', '2']])).toBe(`31417:${pk}:slot:x`);
    expect(replaceableAddress(31415, pk, [])).toBe(`31415:${pk}:`);
  });

  it('addresses replaceable events by kind and author', () => {
    expect(replaceableAddress(0, pk, [['d', 'ignored']])).toBe(`0:${pk}`);
    expect(replaceableAddress(10002, pk, [])).toBe(`10002:${pk}`);
  });

  it('has no address for regular and ephemeral events', () => {
    for (const kind of [1, 1417, 7, 20001]) {
      expect(isReplaceableKind(kind), String(kind)).toBe(false);
      expect(replaceableAddress(kind, pk, [['d', 'x']])).toBeUndefined();
    }
  });
});
