import React, { useState } from 'react';
import { Download, Eye, EyeOff } from 'lucide-react';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/useToast';
import { useLoginActions } from '@/hooks/useLoginActions';

interface SignupDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Minimal key generation: make a key, let the player save it, log in.
 * Profile editing is intentionally not part of this game.
 */
const SignupDialog: React.FC<SignupDialogProps> = ({ isOpen, onClose }) => {
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const login = useLoginActions();

  const generateKey = () => {
    setNsec(nip19.nsecEncode(generateSecretKey()));
    setShowKey(false);
  };

  const downloadKey = () => {
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') throw new Error('Invalid key');

      const npub = nip19.npubEncode(getPublicKey(decoded.data));
      const blob = new Blob([nsec], { type: 'text/plain; charset=utf-8' });
      const url = globalThis.URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `nostr-farm-${npub.slice(5, 13)}.nsec.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      globalThis.URL.revokeObjectURL(url);
    } catch {
      toast({ variant: 'destructive', title: 'Could not save your key', description: 'Copy it manually instead.' });
    }
  };

  const finish = () => {
    try {
      login.nsec(nsec);
      setNsec('');
      onClose();
    } catch {
      toast({ variant: 'destructive', title: 'Sign up failed', description: 'The generated key could not be used.' });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create an account</DialogTitle>
          <DialogDescription>
            Your farm belongs to a Nostr key. Save it somewhere safe — it cannot be recovered.
          </DialogDescription>
        </DialogHeader>

        {!nsec ? (
          <Button onClick={generateKey} className="w-full">Generate a key</Button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-3 py-2 text-xs">
                {showKey ? nsec : '•'.repeat(48)}
              </code>
              <Button variant="ghost" size="icon" onClick={() => setShowKey((v) => !v)} aria-label="Toggle key visibility">
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <Button variant="outline" className="w-full" onClick={downloadKey}>
              <Download className="mr-2 h-4 w-4" />
              Save key to a file
            </Button>
            <Button className="w-full" onClick={finish}>I saved it — start farming</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default SignupDialog;
