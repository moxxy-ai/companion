import { useCallback, useState } from 'react';
import { useLive } from '@companion/core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RefinementListEntry } from '../../contract/index.js';
import { refinementApi } from '../api.js';

/** The active workspace's refinements, kept live over refinement.changed. */
export function useRefinements(): {
  current: WorkspaceRecord | null;
  /** null until the first load resolves. */
  refinements: RefinementListEntry[] | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [refinements, setRefinements] = useState<RefinementListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      setRefinements((await refinementApi.list(current.id)).refinements);
      setError(null);
    } catch (err) {
      setError(String(err));
      setRefinements([]);
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'refinement.changed');

  return { current, refinements, error, refresh };
}
