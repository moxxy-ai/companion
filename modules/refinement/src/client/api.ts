import { del, post, put, request } from '@companion/core/client';
import type {
  RefineContextOptions,
  RefineItemRecord,
  RefineMethodRecord,
  RefinementListEntry,
  RefinementRecord,
} from '../contract/index.js';

export interface RefinementDetail {
  readonly refinement: RefinementRecord;
  readonly items: RefineItemRecord[];
  /** The refinement's own workspace (via its repo) — methods resolve against THIS, not the switcher's. */
  readonly workspaceId: string | null;
}

export const refinementApi = {
  list: (workspaceId: string) =>
    request<{ refinements: RefinementListEntry[] }>(`/api/workspaces/${workspaceId}/refinements`),
  create: (input: { repo: string; branch?: string; title: string; story: string }) =>
    post<{ refinement: RefinementRecord }>('/api/refinements', input),
  get: (id: string) => request<RefinementDetail>(`/api/refinements/${id}`),
  update: (id: string, fields: { title?: string; story?: string; branch?: string }) =>
    put<{ refinement: RefinementRecord }>(`/api/refinements/${id}`, fields),
  remove: (id: string) => del<{ ok: true }>(`/api/refinements/${id}`),
  decompose: (id: string, body: { methodId: string; specIds: string[]; docIds: string[] }) =>
    post<{ queued: true }>(`/api/refinements/${id}/decompose`, body),
  contextOptions: (id: string) => request<RefineContextOptions>(`/api/refinements/${id}/context-options`),
  importItem: (id: string, itemId: string, queue: boolean) =>
    post<{ item: RefineItemRecord }>(`/api/refinements/${id}/items/${itemId}/import`, { queue }),
  dismissItem: (id: string, itemId: string) =>
    post<{ item: RefineItemRecord }>(`/api/refinements/${id}/items/${itemId}/dismiss`),
  importAll: (id: string, queue: boolean) =>
    post<{ imported: number }>(`/api/refinements/${id}/import-all`, { queue }),
  methods: (workspaceId: string) =>
    request<{ methods: RefineMethodRecord[] }>(`/api/workspaces/${workspaceId}/refine-methods`),
  saveMethod: (workspaceId: string, fields: { name: string; description: string; instructions: string }) =>
    post<{ method: RefineMethodRecord }>(`/api/workspaces/${workspaceId}/refine-methods`, fields),
  updateMethod: (id: string, fields: { name?: string; description?: string; instructions?: string }) =>
    put<{ method: RefineMethodRecord }>(`/api/refine-methods/${id}`, fields),
  deleteMethod: (id: string) => del<{ ok: true }>(`/api/refine-methods/${id}`),
};
