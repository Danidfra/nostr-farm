import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoginArea } from '@/components/auth/LoginArea';

/** Shown when nobody is signed in. */
export function SignInPanel() {
  return (
    <Panel title="Nostr Farm" description="Your farm lives on Nostr and belongs to your key.">
      <LoginArea />
    </Panel>
  );
}

/** Shown when the signed-in player has no farm yet. */
export function CreateFarmPanel({
  onCreate,
  isCreating,
}: {
  onCreate: (name: string) => void;
  isCreating: boolean;
}) {
  const [name, setName] = useState('My Farm');

  return (
    <Panel title="Start your farm" description="This publishes your world and its field to the game relay.">
      <div className="flex w-full max-w-sm gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Farm name" maxLength={60} />
        <Button onClick={() => onCreate(name)} disabled={isCreating}>
          {isCreating ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </Panel>
  );
}

/** Shown when something the player cannot fix went wrong. */
export function FarmErrorPanel({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <Panel title={title} description={message}>
      {onRetry && <Button variant="outline" onClick={onRetry}>Try again</Button>}
    </Panel>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">{children}</CardContent>
      </Card>
    </div>
  );
}
