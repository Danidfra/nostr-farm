/**
 * Attacker-controlled paths stay inert.
 *
 * A path carrying markup, quotes or a `javascript:` scheme must create no
 * element and run nothing: React Router hands the path over as a string and
 * React renders strings as text. The only link on the page goes home.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createHead, UnheadProvider } from '@unhead/react/client';
import NotFound from './NotFound';

const PROBE = 'farm-route-probe';

const HOSTILE_PATHS = [
  `/"><img src=x data-probe="${PROBE}">`,
  `/<script data-probe="${PROBE}">window.__routeProbe = 1</script>`,
  `/'onmouseover='window.__routeProbe=1`,
  `/javascript:window.__routeProbe=1`,
  `/%22%3E%3Cimg%20src%3Dx%20data-probe%3D%22${PROBE}%22%3E`,
  '/`${window.__routeProbe=1}`',
];

function renderAt(path: string) {
  return render(
    <UnheadProvider head={createHead()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>
    </UnheadProvider>,
  );
}

afterEach(() => {
  delete (window as { __routeProbe?: unknown }).__routeProbe;
});

describe('a hostile path reaching the 404 page', () => {
  it.each(HOSTILE_PATHS)('creates no element and runs nothing for %s', (path) => {
    const { container } = renderAt(path);

    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelector(`[data-probe="${PROBE}"]`)).toBeNull();
    expect((window as { __routeProbe?: unknown }).__routeProbe).toBeUndefined();
    for (const anchor of Array.from(container.querySelectorAll('a'))) {
      expect(anchor.getAttribute('href')).toBe('/');
    }
  });
});
