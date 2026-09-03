import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import App from './App';
import { DEV_TOOLS_ENABLED } from '@/dev/enabled';

describe('App', () => {
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
});
