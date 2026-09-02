import { useMutation } from '@tanstack/react-query';
import { BlossomUploader } from '@nostrify/nostrify/uploaders';

import { useCurrentUser } from './useCurrentUser';

/** Blossom servers uploads are offered to, in order. */
export const BLOSSOM_SERVERS = ['https://blossom.primal.net/'] as const;

/**
 * The application's one Blossom uploader.
 *
 * The upload is authorized by a signed Blossom auth event produced by the
 * user's own signer — the same account object the rest of the app signs with.
 * No key material is read, stored or passed around here.
 *
 * Returns NIP-94 style tags whose first entry is `["url", "<url>"]`.
 */
export function useUploadFile() {
  return useUploadFileWith(BLOSSOM_SERVERS);
}

function useUploadFileWith(servers: readonly string[]) {
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async (file: File) => {
      if (!user) throw new Error('Sign in before uploading files.');

      const uploader = new BlossomUploader({ servers: [...servers], signer: user.signer });
      return uploader.upload(file);
    },
  });
}
