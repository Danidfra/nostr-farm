import { useSeoMeta } from '@unhead/react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';

/**
 * Unknown route. The home link goes through the router so it lands on the
 * farm under whatever basename the app is served from (the GitHub Pages
 * project path in production), rather than the domain root.
 */
export default function NotFound() {
  useSeoMeta({
    title: 'Page not found — Nostr Farm',
    description: 'That path is not part of the farm.',
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="text-center">
        <p className="font-display text-6xl font-semibold">404</p>
        <p className="mt-2 text-lg text-muted-foreground">That path is not part of the farm.</p>
        <Button asChild className="mt-6">
          <Link to="/">Back to your farm</Link>
        </Button>
      </div>
    </div>
  );
}
