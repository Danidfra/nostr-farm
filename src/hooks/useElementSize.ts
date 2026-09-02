import { useCallback, useLayoutEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Track an element's content-box size, so the renderer can fit itself to it.
 *
 * Two things keep this from looping:
 *
 * 1. The observed node lives in state, set by the callback ref, so the layout
 *    effect can depend on `[node]` honestly. Keying the effect on a ref instead
 *    would force it to re-run every render to notice a late attachment.
 * 2. `setSize` returns the previous object when the dimensions are unchanged.
 *    `useState` bails out on `Object.is`, which a fresh object literal never
 *    satisfies — measuring into a new object on every commit is precisely what
 *    turns a layout effect into an infinite update loop.
 */
export function useElementSize<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  // Identity-stable, so React does not detach and reattach the ref every render.
  const ref = useCallback((next: T | null) => setNode(next), []);

  useLayoutEffect(() => {
    if (!node) return;

    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { ref, size };
}
