import { del, patch, post, put, request } from '@companion/core/client';
import type {
  BoardConfig,
  SpecOption,
  TaskEventRecord,
  TaskPriority,
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

export const boardApi = {
  get: () => request<BoardSnapshot>('/api/board'),
  task: (id: string) => request<{ task: TaskRecord; events: TaskEventRecord[] }>(`/api/board/tasks/${id}`),
  createTask: (input: {
    repo: string;
    title: string;
    description: string;
    specId: string | null;
    priority: TaskPriority;
    queue: boolean;
  }) => post<{ task: TaskRecord }>('/api/board/tasks', input),
  updateTask: (
    id: string,
    fields: { title?: string; description?: string; specId?: string | null; priority?: TaskPriority },
  ) => patch<{ task: TaskRecord }>(`/api/board/tasks/${id}`, fields),
  moveTask: (id: string, to: TaskStatus) => post<{ task: TaskRecord }>(`/api/board/tasks/${id}/move`, { to }),
  resolveFailure: (id: string, decision: 'retry' | 'backlog' | 'done', instructions: string) =>
    post<{ task: TaskRecord }>(`/api/board/tasks/${id}/resolve-failure`, { decision, instructions }),
  deleteTask: (id: string) => del<{ ok: true }>(`/api/board/tasks/${id}`),
  specs: (repo: string) => request<{ specs: SpecOption[] }>(`/api/board/specs/${repo}`),
  createWorker: (name: string, role: WorkerRole) => post<{ worker: WorkerRecord }>('/api/board/workers', { name, role }),
  updateWorker: (id: string, fields: { name?: string; role?: WorkerRole; enabled?: boolean }) =>
    patch<{ worker: WorkerRecord }>(`/api/board/workers/${id}`, fields),
  deleteWorker: (id: string) => del<{ ok: true }>(`/api/board/workers/${id}`),
  saveConfig: (fields: Partial<BoardConfig>) => put<{ config: BoardConfig }>('/api/board/config', fields),
};
