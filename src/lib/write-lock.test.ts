import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasCrossTabLocks, serializeWrite, withCrossTabLock, withSerializedWrite } from './write-lock';

afterEach(() => vi.unstubAllGlobals());

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('per-tab serialization', () => {
  it('never overlaps two writes on the same key', async () => {
    const order: string[] = [];
    const first = defer();

    const a = serializeWrite('inv', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = serializeWrite('inv', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('lets different keys run concurrently', async () => {
    const order: string[] = [];
    const gate = defer();

    const a = serializeWrite('one', async () => {
      order.push('a:start');
      await gate.promise;
    });
    const b = serializeWrite('two', async () => {
      order.push('b:start');
    });

    await b;
    gate.resolve();
    await a;

    expect(order).toEqual(['a:start', 'b:start']);
  });

  it('a rejection does not wedge the chain for later writers', async () => {
    const failed = serializeWrite('inv', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    await expect(serializeWrite('inv', async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the caller its own rejection', async () => {
    await expect(serializeWrite('k', async () => Promise.reject(new Error('mine')))).rejects.toThrow('mine');
  });
});

describe('cross-tab lock', () => {
  it('uses the Web Locks API when present', async () => {
    const request = vi.fn(async (_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb());
    vi.stubGlobal('navigator', { locks: { request } });

    expect(hasCrossTabLocks()).toBe(true);
    await expect(withCrossTabLock('inv', async () => 'done')).resolves.toBe('done');
    expect(request).toHaveBeenCalledWith('inv', { mode: 'exclusive' }, expect.any(Function));
  });

  it('still runs, without cross-tab protection, when the API is missing', async () => {
    vi.stubGlobal('navigator', {});

    expect(hasCrossTabLocks()).toBe(false);
    await expect(withCrossTabLock('inv', async () => 'done')).resolves.toBe('done');
  });

  it('does not throw when navigator itself is absent', async () => {
    vi.stubGlobal('navigator', undefined);
    await expect(withCrossTabLock('inv', async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates errors out of the lock', async () => {
    vi.stubGlobal('navigator', {});
    await expect(withCrossTabLock('inv', async () => Promise.reject(new Error('inner')))).rejects.toThrow('inner');
  });
});

describe('combined', () => {
  it('serializes even when no cross-tab lock exists', async () => {
    vi.stubGlobal('navigator', {});
    const order: string[] = [];
    const gate = defer();

    const a = withSerializedWrite('combo', async () => {
      order.push('a');
      await gate.promise;
    });
    const b = withSerializedWrite('combo', async () => {
      order.push('b');
    });

    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });
});
