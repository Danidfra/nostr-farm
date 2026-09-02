import { useCallback, useRef, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useElementSize } from './useElementSize';

/**
 * These tests exist because `useElementSize` shipped with an infinite update
 * loop: a layout effect with no dependency array measured into a fresh object
 * literal on every commit, so `useState` could never bail out and React threw
 * "Maximum update depth exceeded" the moment `FarmField` first mounted.
 *
 * Everything here is about convergence — that repeated identical measurements
 * cost nothing.
 */

interface ObserverRecord {
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnected: boolean;
}

const observers: ObserverRecord[] = [];

/** A controllable ResizeObserver, so a test can fire callbacks on demand. */
class FakeResizeObserver implements ResizeObserver {
  private readonly record: ObserverRecord;

  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, targets: [], disconnected: false };
    observers.push(this.record);
  }

  observe(target: Element) {
    this.record.targets.push(target);
  }

  unobserve() {}

  disconnect() {
    this.record.disconnected = true;
  }
}

/** Fire every live observer, as the browser would after a layout change. */
function fireResize() {
  for (const observer of observers) {
    if (!observer.disconnected) act(() => observer.callback([], {} as ResizeObserver));
  }
}

/** Pin an element's measured size, since jsdom reports 0 for every dimension. */
function setMeasuredSize(node: HTMLElement, width: number, height: number) {
  Object.defineProperty(node, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(node, 'clientHeight', { value: height, configurable: true });
}

const liveObservers = () => observers.filter((o) => !o.disconnected);

const renders = { count: 0 };

/** Mirrors how `FarmField` consumes the hook: the ref is passed straight through. */
function Probe() {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const identities = useRef(new Set<unknown>());

  renders.count += 1;
  identities.current.add(size);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) setMeasuredSize(node, 800, 600);
      ref(node);
    },
    [ref]
  );

  return (
    <div
      ref={attach}
      data-testid="probe"
      data-size={`${size.width}x${size.height}`}
      data-identities={identities.current.size}
    />
  );
}

beforeEach(() => {
  observers.length = 0;
  renders.count = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useElementSize', () => {
  it('measures the element and settles in a bounded number of renders', () => {
    render(<Probe />);

    expect(screen.getByTestId('probe')).toHaveAttribute('data-size', '800x600');
    // Mount, then the node lands in state, then the measurement lands. Any
    // growth beyond that means the layout effect is re-scheduling itself.
    expect(renders.count).toBeLessThanOrEqual(3);
  });

  it('converges to zero renders under repeated identical measurements', () => {
    render(<Probe />);
    const settled = renders.count;

    // React's `useState` eager bailout only applies when the fiber has no
    // pending lanes, so the first callback after a state-changing commit costs
    // one render, during which React sees the identical object and bails out.
    fireResize();
    const afterFirst = renders.count;
    expect(afterFirst).toBe(settled + 1);

    // Everything after that is free. The broken hook rendered 50 more times
    // and then threw "Maximum update depth exceeded".
    for (let i = 0; i < 50; i++) fireResize();
    expect(renders.count).toBe(afterFirst);
  });

  it('keeps the size object identity stable across identical measurements', () => {
    render(<Probe />);
    for (let i = 0; i < 10; i++) fireResize();

    // One identity for the initial {0,0}, one for the measurement. A fresh
    // object per measurement is exactly what defeats React's bailout.
    expect(Number(screen.getByTestId('probe').getAttribute('data-identities'))).toBeLessThanOrEqual(2);
  });

  it('re-renders once for a real size change, then settles again', () => {
    render(<Probe />);
    const settled = renders.count;

    setMeasuredSize(screen.getByTestId('probe'), 400, 300);
    fireResize();

    expect(screen.getByTestId('probe')).toHaveAttribute('data-size', '400x300');
    expect(renders.count).toBe(settled + 1);

    // One settling render (see above), and then nothing, however many
    // callbacks arrive.
    fireResize();
    const afterSettling = renders.count;
    expect(afterSettling).toBe(settled + 2);

    for (let i = 0; i < 20; i++) fireResize();
    expect(renders.count).toBe(afterSettling);
  });

  it('observes exactly one element and disconnects it on unmount', () => {
    const { unmount } = render(<Probe />);

    expect(liveObservers()).toHaveLength(1);
    expect(liveObservers()[0].targets).toHaveLength(1);

    unmount();
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  it('does not churn observers while the element stays the same', () => {
    render(<Probe />);
    const created = observers.length;

    for (let i = 0; i < 10; i++) fireResize();

    // The old hook rebuilt a ResizeObserver on every commit.
    expect(observers.length).toBe(created);
    expect(created).toBe(1);
  });

  it('converges even when the consumer passes an unstable ref callback', () => {
    function UnstableProbe() {
      const { ref, size } = useElementSize<HTMLDivElement>();
      renders.count += 1;
      return (
        <div
          data-testid="unstable"
          data-size={`${size.width}x${size.height}`}
          ref={(node) => {
            // A new function identity every render: React detaches and
            // reattaches, so the hook sees null then the node again.
            if (node) setMeasuredSize(node, 640, 480);
            ref(node);
          }}
        />
      );
    }

    render(<UnstableProbe />);

    expect(screen.getByTestId('unstable')).toHaveAttribute('data-size', '640x480');
    expect(renders.count).toBeLessThanOrEqual(6);
  });

  it('re-measures when the observed element is swapped for a different one', () => {
    function SwapProbe() {
      const { ref, size } = useElementSize<HTMLDivElement>();
      const [which, setWhich] = useState<'a' | 'b'>('a');

      const attach = useCallback(
        (node: HTMLDivElement | null) => {
          if (node) setMeasuredSize(node, node.dataset.box === 'a' ? 800 : 200, node.dataset.box === 'a' ? 600 : 100);
          ref(node);
        },
        [ref]
      );

      return (
        <div>
          <button type="button" onClick={() => setWhich('b')}>swap</button>
          {which === 'a' ? (
            <div key="a" data-box="a" ref={attach} data-testid="box" data-size={`${size.width}x${size.height}`} />
          ) : (
            <div key="b" data-box="b" ref={attach} data-testid="box" data-size={`${size.width}x${size.height}`} />
          )}
        </div>
      );
    }

    render(<SwapProbe />);
    expect(screen.getByTestId('box')).toHaveAttribute('data-size', '800x600');

    act(() => screen.getByText('swap').click());

    expect(screen.getByTestId('box')).toHaveAttribute('data-size', '200x100');
    // The previous element's observer is torn down, exactly one stays live.
    expect(liveObservers()).toHaveLength(1);
  });

  it('reports a zero size before the element is attached', () => {
    const seen: Array<{ width: number; height: number }> = [];

    function FirstRenderProbe() {
      const { ref, size } = useElementSize<HTMLDivElement>();
      seen.push(size);
      return <div ref={ref} />;
    }

    render(<FirstRenderProbe />);
    expect(seen[0]).toEqual({ width: 0, height: 0 });
  });
});
