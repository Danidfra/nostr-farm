import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { DEV_TOOLS_ENABLED } from '@/dev/enabled';

describe('App', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.pushState({}, '', '/');
  });

  it('renders the farm shell and asks an anonymous visitor to sign in', async () => {
    render(<App />);
    expect(await screen.findByText(/Grow a little farm that is truly yours/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    expect(screen.getAllByText('Nostr Farm').length).toBeGreaterThan(0);
  });

  it('keeps dev tools disabled unless a build opts in', () => {
    // The test environment provides no `__DEV_TOOLS_ENABLED__`, which is the
    // same situation a production build without the flag is in.
    expect(DEV_TOOLS_ENABLED).toBe(false);
  });

  it('routes /dev/inventory to the not-found page when dev tools are off', async () => {
    window.history.pushState({}, '', '/dev/inventory');
    render(<App />);
    expect(await screen.findByText(/not part of the farm/i)).toBeInTheDocument();
    expect(screen.queryByText(/farm:main accounting/i)).not.toBeInTheDocument();
  });

  it('mounts the router at the base the build was emitted for', async () => {
    // The router's basename is `import.meta.env.BASE_URL`, which Vite sets
    // from the deployment target. Under the GitHub Pages base an unknown path
    // below it still reaches the farm's own 404 and links home under the base.
    vi.stubEnv('BASE_URL', '/nostr-farm/');
    window.history.pushState({}, '', '/nostr-farm/nowhere');
    render(<App />);
    expect(await screen.findByText(/not part of the farm/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to your farm/i })).toHaveAttribute('href', '/nostr-farm/');
  });

  it('mounts the router at the domain root for the official build', async () => {
    expect(import.meta.env.BASE_URL).toBe('/');
    window.history.pushState({}, '', '/nowhere');
    render(<App />);
    expect(await screen.findByText(/not part of the farm/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to your farm/i })).toHaveAttribute('href', '/');
  });
});
