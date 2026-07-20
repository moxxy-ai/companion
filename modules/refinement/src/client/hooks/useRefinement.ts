import { useCallback, useMemo, useState } from 'react';
import { ApiError, useLive } from '@companion/core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RefineContextOptions, RefineMethodRecord } from '../../contract/index.js';
import { refinementApi, type RefinementDetail } from '../api.js';

export interface RefinementActions {
  update(fields: { title?: string; story?: string; branch?: string }): Promise<void>;
  decompose(methodId: string, specIds: string[], docIds: string[]): Promise<void>;
  importItem(itemId: string, queue: boolean): Promise<void>;
  importAll(queue: boolean): Promise<void>;
  dismissItem(itemId: string): Promise<void>;
  /** Resolves true when deleted (the caller navigates away). */
  remove(): Promise<boolean>;
  saveMethod(fields: { name: string; description: string; instructions: string }): Promise<void>;
  updateMethod(id: string, fields: { name?: string; description?: string; instructions?: string }): Promise<void>;
  deleteMethod(id: string): Promise<void>;
}

/**
 * One refinement's detail view: the record + its items, the workspace's
 * decomposition methods and the spec/doc picker options — kept live over
 * refinement.changed (every mutation and agent transition broadcasts it).
 */
export function useRefinement(id: string): {
  current: WorkspaceRecord | null;
  detail: RefinementDetail | null;
  methods: RefineMethodRecord[];
  context: RefineContextOptions | null;
  /** The refinement disappeared (deleted, or not visible to this user). */
  missing: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  actions: RefinementActions;
} {
  const { current } = useWorkspace();
  const [detail, setDetail] = useState<RefinementDetail | null>(null);
  const [methods, setMethods] = useState<RefineMethodRecord[]>([]);
  const [context, setContext] = useState<RefineContextOptions | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    let fetched: RefinementDetail;
    try {
      fetched = await refinementApi.get(id);
      setDetail(fetched);
      setMissing(false);
    } catch (err) {
      // Only a real 404 means gone — a transient failure must not swap the
      // page to the not-found state.
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(String(err));
      return;
    }
    // Secondary panels are best-effort — the page renders without them.
    void refinementApi
      .contextOptions(id)
      .then(setContext)
      .catch(() => undefined);
    // Methods belong to the refinement's workspace, not the switcher's.
    if (fetched.workspaceId) {
      void refinementApi
        .methods(fetched.workspaceId)
        .then((r) => setMethods(r.methods))
        .catch(() => undefined);
    }
  }, [id]);

  useLive(refresh, (msg) => msg.t === 'refinement.changed');

  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
        setError(null);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const actions = useMemo<RefinementActions>(
    () => ({
      update: (fields) => act(() => refinementApi.update(id, fields)),
      decompose: (methodId, specIds, docIds) => act(() => refinementApi.decompose(id, { methodId, specIds, docIds })),
      importItem: (itemId, queue) => act(() => refinementApi.importItem(id, itemId, queue)),
      importAll: (queue) => act(() => refinementApi.importAll(id, queue)),
      dismissItem: (itemId) => act(() => refinementApi.dismissItem(id, itemId)),
      remove: async () => {
        try {
          await refinementApi.remove(id);
          return true;
        } catch (err) {
          setError(String(err));
          return false;
        }
      },
      saveMethod: (fields) => {
        const workspaceId = detail?.workspaceId;
        if (!workspaceId) return Promise.resolve();
        return act(() => refinementApi.saveMethod(workspaceId, fields));
      },
      updateMethod: (methodId, fields) => act(() => refinementApi.updateMethod(methodId, fields)),
      deleteMethod: (methodId) => act(() => refinementApi.deleteMethod(methodId)),
    }),
    [act, id, detail?.workspaceId],
  );

  return { current, detail, methods, context, missing, error, setError, refresh, actions };
}
