import { useQuery } from '@tanstack/react-query';

import { formatRenderpackRef, type RenderpackRef } from '@/world/renderpack/registry';
import { loadRenderpack } from '@/world/renderpack/load';

/** Load a pinned renderpack. Immutable by construction, so it never goes stale. */
export function useRenderpack(ref: RenderpackRef | undefined) {
  return useQuery({
    queryKey: ['renderpack', ref ? formatRenderpackRef(ref) : null],
    queryFn: ({ signal }) => loadRenderpack(ref!, signal),
    enabled: !!ref,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}
