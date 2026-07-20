import type { Database } from 'better-sqlite3';
import type {
  BoardConfig,
  TaskEventRecord,
  TaskPriority,
  TaskRecord,
  TaskStage,
  TaskStatus,
  WorkerRecord,
  WorkerRole,
} from '../contract/index.js';

interface WorkerRow {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  enabled: number;
  created_at: number;
}

interface TaskRow {
  id: string;
  repo: string;
  title: string;
  description: string;
  acceptance: string;
  spec_id: string | null;
  priority: number;
  status: string;
  stage: string | null;
  created_by: string | null;
  first_worker: string | null;
  assigned_worker_id: string | null;
  run_id: string | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  review_risk: string | null;
  review_recommendation: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface EventRow {
  id: number;
  task_id: string;
  at: number;
  kind: string;
  detail: string;
}

function rowToWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role as WorkerRole,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    repo: row.repo,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    specId: row.spec_id,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    stage: row.stage as TaskStage | null,
    createdBy: row.created_by,
    firstWorker: row.first_worker,
    assignedWorkerId: row.assigned_worker_id,
    runId: row.run_id,
    branch: row.branch,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    reviewRisk: row.review_risk as TaskRecord['reviewRisk'],
    reviewRecommendation: row.review_recommendation as TaskRecord['reviewRecommendation'],
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToEvent(row: EventRow): TaskEventRecord {
  return { id: row.id, taskId: row.task_id, at: row.at, kind: row.kind, detail: row.detail };
}

/** Fields the engine may patch on a task; undefined = leave unchanged. */
export interface TaskPatch {
  title?: string;
  description?: string;
  acceptance?: string;
  specId?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  stage?: TaskStage | null;
  firstWorker?: string | null;
  assignedWorkerId?: string | null;
  runId?: string | null;
  branch?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  reviewRisk?: TaskRecord['reviewRisk'];
  reviewRecommendation?: TaskRecord['reviewRecommendation'];
  attempts?: number;
  lastError?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

const TASK_PATCH_COLUMNS: ReadonlyArray<[keyof TaskPatch, string]> = [
  ['title', 'title'],
  ['description', 'description'],
  ['acceptance', 'acceptance'],
  ['specId', 'spec_id'],
  ['priority', 'priority'],
  ['status', 'status'],
  ['stage', 'stage'],
  ['firstWorker', 'first_worker'],
  ['assignedWorkerId', 'assigned_worker_id'],
  ['runId', 'run_id'],
  ['branch', 'branch'],
  ['prNumber', 'pr_number'],
  ['prUrl', 'pr_url'],
  ['reviewRisk', 'review_risk'],
  ['reviewRecommendation', 'review_recommendation'],
  ['attempts', 'attempts'],
  ['lastError', 'last_error'],
  ['startedAt', 'started_at'],
  ['finishedAt', 'finished_at'],
];

/** Owner of the board_* tables. All writes go through here. */
export class BoardStore {
  constructor(private readonly db: Database) {}

  // ---------- workers ---------------------------------------------------------------

  insertWorker(w: WorkerRecord): void {
    this.db
      .prepare(
        `INSERT INTO board_workers (id, workspace_id, name, role, enabled, created_at)
         VALUES (@id, @workspaceId, @name, @role, @enabled, @createdAt)`,
      )
      .run({ ...w, enabled: w.enabled ? 1 : 0 });
  }

  updateWorker(id: string, fields: { name?: string; role?: WorkerRole; enabled?: boolean }): void {
    const existing = this.getWorker(id);
    if (!existing) return;
    this.db
      .prepare(`UPDATE board_workers SET name = ?, role = ?, enabled = ? WHERE id = ?`)
      .run(fields.name ?? existing.name, fields.role ?? existing.role, (fields.enabled ?? existing.enabled) ? 1 : 0, id);
  }

  deleteWorker(id: string): void {
    this.db.prepare(`DELETE FROM board_workers WHERE id = ?`).run(id);
  }

  getWorker(id: string): WorkerRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM board_workers WHERE id = ?`).get(id) as WorkerRow | undefined;
    return row ? rowToWorker(row) : undefined;
  }

  /** All workers, or one workspace's pool. */
  listWorkers(workspaceId?: string): WorkerRecord[] {
    const rows = (
      workspaceId === undefined
        ? this.db.prepare(`SELECT * FROM board_workers ORDER BY created_at`).all()
        : this.db.prepare(`SELECT * FROM board_workers WHERE workspace_id = ? ORDER BY created_at`).all(workspaceId)
    ) as WorkerRow[];
    return rows.map(rowToWorker);
  }

  /**
   * Boot adoption: rows created before workspace scoping (workspace_id = '')
   * land in the given workspace. Idempotent — matches nothing afterwards.
   */
  adoptWorkspace(workspaceId: string): void {
    this.db.prepare(`UPDATE board_workers SET workspace_id = ? WHERE workspace_id = ''`).run(workspaceId);
    const claimed = this.db.prepare(`SELECT 1 FROM board_config WHERE workspace_id = ?`).get(workspaceId);
    if (claimed) {
      this.db.prepare(`DELETE FROM board_config WHERE workspace_id = ''`).run();
    } else {
      this.db.prepare(`UPDATE board_config SET workspace_id = ? WHERE workspace_id = ''`).run(workspaceId);
    }
  }

  // ---------- tasks -----------------------------------------------------------------

  insertTask(t: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO board_tasks (
           id, repo, title, description, acceptance, spec_id, priority, status, stage,
           created_by, first_worker, assigned_worker_id, run_id, branch, pr_number, pr_url,
           review_risk, review_recommendation, attempts, last_error,
           created_at, updated_at, started_at, finished_at
         ) VALUES (
           @id, @repo, @title, @description, @acceptance, @specId, @priority, @status, @stage,
           @createdBy, @firstWorker, @assignedWorkerId, @runId, @branch, @prNumber, @prUrl,
           @reviewRisk, @reviewRecommendation, @attempts, @lastError,
           @createdAt, @updatedAt, @startedAt, @finishedAt
         )`,
      )
      .run(t);
  }

  updateTask(id: string, patch: TaskPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: Date.now() };
    for (const [key, column] of TASK_PATCH_COLUMNS) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = @${key}`);
        params[key] = patch[key];
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE board_tasks SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`).run(params);
  }

  deleteTask(id: string): void {
    this.db.prepare(`DELETE FROM board_events WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM board_tasks WHERE id = ?`).run(id);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM board_tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  taskByRunId(runId: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM board_tasks WHERE run_id = ?`).get(runId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM board_tasks ORDER BY priority, created_at`)
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  listTasksByStatus(status: TaskStatus): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM board_tasks WHERE status = ? ORDER BY priority, created_at`)
      .all(status) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Task ids of workers currently building (the one-item-per-worker rule). */
  busyWorkerMap(): Map<string, { taskId: string; title: string; repo: string }> {
    const rows = this.db
      .prepare(
        `SELECT assigned_worker_id, id, title, repo FROM board_tasks
         WHERE status = 'in_progress' AND assigned_worker_id IS NOT NULL`,
      )
      .all() as Array<{ assigned_worker_id: string; id: string; title: string; repo: string }>;
    return new Map(rows.map((r) => [r.assigned_worker_id, { taskId: r.id, title: r.title, repo: r.repo }]));
  }

  // ---------- events ------------------------------------------------------------------

  insertEvent(taskId: string, kind: string, detail: string): void {
    this.db
      .prepare(`INSERT INTO board_events (task_id, at, kind, detail) VALUES (?, ?, ?, ?)`)
      .run(taskId, Date.now(), kind, detail);
  }

  listEvents(taskId: string, limit = 100): TaskEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM board_events WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
      .all(taskId, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Whether a heartbeat blocker is still active. The latest matching event is
   * the durable latch, so daemon restarts cannot repeat an inbox notification.
   */
  hasActiveBlocker(taskId: string, blocker: string): boolean {
    const row = this.db
      .prepare(
        `SELECT kind FROM board_events
         WHERE task_id = ? AND detail = ? AND kind IN ('blocker_notified', 'blocker_cleared')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId, blocker) as { kind: string } | undefined;
    return row?.kind === 'blocker_notified';
  }

  // ---------- config ------------------------------------------------------------------

  getConfig(workspaceId: string): BoardConfig {
    const row = this.db.prepare(`SELECT * FROM board_config WHERE workspace_id = ?`).get(workspaceId) as
      | {
          auto_review: number;
          reviewer_worker_id: string | null;
          auto_merge: number;
          merge_method: string;
          merge_account_id: string | null;
          auto_fix_ci: number;
          max_attempts: number;
        }
      | undefined;
    if (!row) {
      return {
        autoReview: true,
        reviewerWorkerId: null,
        autoMerge: true,
        mergeMethod: 'squash',
        mergeAccountId: null,
        autoFixCi: true,
        maxAttempts: 3,
      };
    }
    return {
      autoReview: row.auto_review === 1,
      reviewerWorkerId: row.reviewer_worker_id,
      autoMerge: row.auto_merge === 1,
      mergeMethod: row.merge_method as BoardConfig['mergeMethod'],
      mergeAccountId: row.merge_account_id,
      autoFixCi: row.auto_fix_ci === 1,
      maxAttempts: row.max_attempts,
    };
  }

  setConfig(workspaceId: string, config: BoardConfig): void {
    this.db
      .prepare(
        `INSERT INTO board_config (workspace_id, auto_review, reviewer_worker_id, auto_merge, merge_method, merge_account_id, auto_fix_ci, max_attempts)
         VALUES (@workspaceId, @autoReview, @reviewerWorkerId, @autoMerge, @mergeMethod, @mergeAccountId, @autoFixCi, @maxAttempts)
         ON CONFLICT (workspace_id) DO UPDATE SET
           auto_review = excluded.auto_review,
           reviewer_worker_id = excluded.reviewer_worker_id,
           auto_merge = excluded.auto_merge,
           merge_method = excluded.merge_method,
           merge_account_id = excluded.merge_account_id,
           auto_fix_ci = excluded.auto_fix_ci,
           max_attempts = excluded.max_attempts`,
      )
      .run({
        workspaceId,
        autoReview: config.autoReview ? 1 : 0,
        reviewerWorkerId: config.reviewerWorkerId,
        autoMerge: config.autoMerge ? 1 : 0,
        mergeMethod: config.mergeMethod,
        mergeAccountId: config.mergeAccountId,
        autoFixCi: config.autoFixCi ? 1 : 0,
        maxAttempts: config.maxAttempts,
      });
  }
}
