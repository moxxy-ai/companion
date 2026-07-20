// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages) are visible in this compilation.
import '@companion/module-workspace/contract';
import '@companion/module-code/contract';
import '@companion/module-operate/contract';
import '@companion/module-plan/contract';
import type { BoardService } from '../api/board-service.js';

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'board:read': true;
    'board:manage': true;
  }
  interface ServerMessageRegistry {
    'board.changed': Record<never, never>;
  }
  interface ServiceMap {
    board: BoardService;
  }
}

/** Kanban column. Machine-driven except backlog/ready/done↔human moves. */
export type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'failed';

/**
 * Sub-state within a column. In `ready`/`in_progress` it names the kind of
 * work queued/running (fresh build, addressing review feedback, repairing CI);
 * in `in_review` it names the position in the review cycle.
 */
export type TaskStage =
  | 'build'
  | 'address_review'
  | 'fix_ci'
  | 'awaiting_review'
  | 'reviewing'
  | 'awaiting_merge';

/** P0 (urgent) … P3 (someday). Dispatch order is priority, then age. */
export type TaskPriority = 0 | 1 | 2 | 3;

export type WorkerRole = 'developer' | 'reviewer';

export interface WorkerRecord {
  readonly id: string;
  readonly name: string;
  readonly role: WorkerRole;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** Worker + its live occupancy (a worker builds at most one task at a time). */
export interface WorkerView extends WorkerRecord {
  readonly busy: boolean;
  /** Task identity is redacted (null) when it lives in a workspace the caller cannot access. */
  readonly busyTaskId: string | null;
  readonly busyTaskTitle: string | null;
}

export interface TaskRecord {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly description: string;
  /** Optional plan-module spec attached as agent context. */
  readonly specId: string | null;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly stage: TaskStage | null;
  /** Sticky assignment: kept across the review cycle so feedback binds back. */
  readonly assignedWorkerId: string | null;
  /** The currently-active agent run, if any. */
  readonly runId: string | null;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  /** Latest AI review verdict on the task's PR (null until reviewed). */
  readonly reviewRisk: 'low' | 'medium' | 'high' | null;
  readonly reviewRecommendation: 'approve' | 'request_changes' | 'comment' | null;
  /** Remediation cycles consumed (build failures, CI fixes, review rounds). */
  readonly attempts: number;
  readonly lastError: string | null;
  /** Human guidance supplied after automation exhausted its attempt budget. */
  readonly humanInstructions: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/** Timeline entry on a task — who did what, when. */
export interface TaskEventRecord {
  readonly id: number;
  readonly taskId: string;
  readonly at: number;
  readonly kind: string;
  readonly detail: string;
}

export interface BoardConfig {
  /** Reviewer worker reviews every PR that lands in the review column. */
  readonly autoReview: boolean;
  readonly reviewerWorkerId: string | null;
  /** Merge automatically once review approves and checks are green. */
  readonly autoMerge: boolean;
  readonly mergeMethod: 'merge' | 'squash' | 'rebase';
  /** Failing checks on a task's PR send it back to its worker. */
  readonly autoFixCi: boolean;
  /** Remediation ceiling before the task drops into the Failed column. */
  readonly maxAttempts: number;
}

/** Spec picker option (soft plan dependency — empty when plan is disabled). */
export interface SpecOption {
  readonly id: string;
  readonly title: string;
}
