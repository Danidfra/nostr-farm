import { render, screen } from '@testing-library/react';
import { createHead, UnheadProvider } from '@unhead/react/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import NotFound from './NotFound';

/**
 * The app can be deployed under a base path (`/nostr-farm/` on the GitHub
 * Pages copy). A raw `href="/"` escaped to the domain root; the link must
 * resolve through the router's basename instead.
 */
describe('NotFound', () => {
  it('links home through the router basename rather than the domain root', () => {
    render(
      <UnheadProvider head={createHead()}>
        <MemoryRouter basename="/nostr-farm" initialEntries={['/nostr-farm/nope']}>
          <Routes>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </MemoryRouter>
      </UnheadProvider>
    );

    const link = screen.getByRole('link', { name: /back to your farm/i });
    expect(link).toHaveAttribute('href', '/nostr-farm');
    expect(link.getAttribute('href')).not.toBe('/');
  });
});
