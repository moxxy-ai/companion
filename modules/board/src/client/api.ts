import { del, patch, post, put, request } from '@companion/core/client';
import type { PrReviewResult } from '@companion/module-code/contract';
import type {
  BoardConfig,
  SpecOption,
  TaskAttachmentInput,
  TaskEventRecord,
  TaskPriority,
  TaskPrView,
  TaskRecord,
  TaskStatus,
  WorkerRole,
  WorkerRecord,
  WorkerView,
} from '../contract/index.js';

export interface BoardSnapshot {
  readonly tasks: TaskRecord[];
  readonly workers: WorkerView[];
  readonly config: BoardConfig;
}

export interface TaskDetail {
  readonly task: TaskRecord;
  readonly events: TaskEventRecord[];
  readonly pr: TaskPrView | null;
  readonly reviews: PrReviewResult[];
}

export const boardApi = {
  get: (workspaceId: string) => request<BoardSnapshot>(`/api/board?workspace=${encodeURIComponent(workspaceId)}`),
  task: (id: string) => request<TaskDetail>(`/api/board/tasks/${id}`),
  createTask: (input: {
    repo: string;
    title: string;
    description: string;
    acceptance: string;
    specId: string | null;
    attachments: readonly TaskAttachmentInput[];
    priority: TaskPriority;
    queue: boolean;
  }) => post<{ task: TaskRecord }>('/api/board/tasks', input),
  updateTask: (
    id: string,
    fields: {
      title?: string;
      description?: string;
      acceptance?: string;
      specId?: string | null;
      attachments?: readonly TaskAttachmentInput[];
      priority?: TaskPriority;
    },
  ) => patch<{ task: TaskRecord }>(`/api/board/tasks/${id}`, fields),
  moveTask: (id: string, to: TaskStatus) => post<{ task: TaskRecord }>(`/api/board/tasks/${id}/move`, { to }),
  mergeTask: (id: string) => post<{ task: TaskRecord }>(`/api/board/tasks/${id}/merge`, {}),
  deleteTask: (id: string) => del<{ ok: true }>(`/api/board/tasks/${id}`),
  specs: (repo: string) => request<{ specs: SpecOption[] }>(`/api/board/specs/${repo}`),
  createWorker: (workspaceId: string, name: string, role: WorkerRole) =>
    post<{ worker: WorkerRecord }>('/api/board/workers', { workspaceId, name, role }),
  updateWorker: (id: string, fields: { name?: string; role?: WorkerRole; enabled?: boolean }) =>
    patch<{ worker: WorkerRecord }>(`/api/board/workers/${id}`, fields),
  deleteWorker: (id: string) => del<{ ok: true }>(`/api/board/workers/${id}`),
  saveConfig: (workspaceId: string, fields: Partial<BoardConfig>) =>
    put<{ config: BoardConfig }>('/api/board/config', { ...fields, workspaceId }),
};
