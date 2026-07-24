import { randomUUID } from 'node:crypto';
import type { AuthUser, ServiceMap, SpaServerMessage } from '@companion/contracts';
import type { NotificationEmitter } from '@companion/core/server';
import type { RunRecord, RunStatus } from '@companion/module-operate/contract';
import type { PrReviewResult } from '@companion/module-code/contract';
import { log } from '@companion/services';
import type {
  BoardConfig,
  SpecOption,
  TaskAttachment,
  TaskAttachmentInput,
  TaskDependencyView,
  TaskEventRecord,
  TaskPriority,
  TaskPrView,
  TaskRecord,
  TaskStage,
  TaskStatus,
  WorkerRecord,
  WorkerRole,
  WorkerView,
} from '../contract/index.js';
import type { BoardStore, TaskPatch } from './board-store.js';

type CodeService = ServiceMap['code'];
type WorkspaceService = ServiceMap['workspace'];
type OperateService = ServiceMap['operate'];
type PlanService = ServiceMap['plan'];

/** Run statuses that end a run without a reviewable diff. */
const TERMINAL_FAIL = new Set<RunStatus>(['failed', 'stopped', 'abandoned', 'interrupted']);
const SLOT_RELEASED = new Set<RunStatus>(['completed', 'failed', 'stopped', 'abandoned', 'interrupted']);

/** Stages that mean "queued/running work of this kind" (valid in ready/in_progress). */
const WORK_STAGES: ReadonlySet<TaskStage> = new Set(['build', 'address_review', 'fix_ci']);

const MAX_SPEC_CHARS = 12_000;
const MERGE_BACKOFF_MS = 10 * 60_000;
const REVIEW_BACKOFF_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = 60_000;

/**
 * The agentic task board: a kanban of tasks executed by a small pool of named
 * workers. A worker builds at most ONE task at a time; the dispatcher assigns
 * queued tasks by priority, the run lifecycle moves cards across columns
 * (build → PR → review → merge), review feedback binds a task back to the
 * worker that built it, and failures retry up to a configurable ceiling
 * before landing in the Failed column.
 *
 * All GitHub side effects happen HERE (never inside an agent run): companiond
 * pushes the branch, opens the PR, posts the review and merges — the same
 * review-then-apply machinery the fix flow uses, applied automatically.
 */
export class BoardService {
  private ticking = false;
  private tickQueued = false;
  /** Per-workspace reviewer WIP-1 within this daemon life; stale 'reviewing' rows are swept on boot. */
  private readonly reviewing = new Set<string>();
  private readonly mergeBackoff = new Map<string, number>();
  /** Reviewer-infrastructure failures back off without charging the task's attempts. */
  private readonly reviewBackoff = new Map<string, number>();
  /** Failed attempts cool down before redispatch — a fast-dying runner
   *  environment must not burn the whole attempt ceiling in seconds. */
  private readonly retryBackoff = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly store: BoardStore,
    private readonly code: CodeService,
    private readonly operate: OperateService,
    private readonly workspace: WorkspaceService,
    private readonly plan: () => PlanService | undefined,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    private readonly notify: NotificationEmitter,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  private configFor(task: TaskRecord): BoardConfig {
    return this.store.getConfig(task.workspaceId);
  }

  /** Boot adoption: pre-scoping workers/config land in the first workspace. */
  adoptUnscoped(workspaceId: string): void {
    this.store.adoptWorkspace(workspaceId);
  }

  // ---------- reads -------------------------------------------------------------------

  listBoard(user: AuthUser, workspaceId: string): { tasks: TaskRecord[]; workers: WorkerView[]; config: BoardConfig } {
    const tasks = this.store
      .listTasks()
      .filter((task) => task.workspaceId === workspaceId)
      .map((task) => ({ ...task, attachments: task.attachments.map((attachment) => ({ ...attachment, content: null })) }));
    const busy = this.store.busyWorkerMap();
    const workers = this.store.listWorkers(workspaceId).map((w): WorkerView => {
      const b = busy.get(w.id);
      // Busy-ness is visible to everyone (it drives the WIP maths); the task's
      // identity is workspace data and is redacted for non-members.
      const visible = b ? this.workspace.canAccessRepo(user, b.repo) : false;
      return {
        ...w,
        busy: b != null,
        busyTaskId: visible ? b!.taskId : null,
        busyTaskTitle: visible ? b!.title : null,
        busyTaskRepo: visible ? b!.repo : null,
      };
    });
    return { tasks, workers, config: this.store.getConfig(workspaceId) };
  }

  getTask(
    user: AuthUser,
    id: string,
  ): {
    task: TaskRecord;
    events: TaskEventRecord[];
    pr: TaskPrView | null;
    reviews: PrReviewResult[];
    dependencies: TaskDependencyView[];
  } | null {
    const task = this.store.getTask(id);
    if (!task || !this.workspace.canAccessWorkspace(user, task.workspaceId)) return null;
    // Join the PR's cached GitHub state and its full review history from the
    // code module, so the detail view shows verdicts/checks without extra calls.
    const pr = task.prNumber != null ? this.code.prs.get(task.repo, task.prNumber) : undefined;
    const reviews = task.prNumber != null ? this.code.prReviews.listForPr(task.repo, task.prNumber) : [];
    // Prerequisites resolve to title+status; like busyTaskTitle, the title is
    // redacted when the dep lives in a repo the caller can't see. Deleted
    // prerequisites are omitted (they no longer bind dispatch).
    const dependencies = task.dependsOn.flatMap((depId): TaskDependencyView[] => {
      const dep = this.store.getTask(depId);
      if (!dep) return [];
      const visible = this.workspace.canAccessWorkspace(user, dep.workspaceId);
      return [{ id: dep.id, title: visible ? dep.title : null, status: dep.status }];
    });
    return {
      task,
      events: this.store.listEvents(id),
      pr: pr ? { state: pr.state, reviewDecision: pr.reviewDecision, checks: pr.checks } : null,
      reviews,
      dependencies,
    };
  }

  /** Spec picker options for a repo — empty when the plan module is disabled. */
  specOptions(repo: string, workspaceId: string): SpecOption[] {
    const plan = this.plan();
    if (!plan) return [];
    return plan.specs
      .list(workspaceId)
      .filter((s) => s.repo === repo && s.status === 'ready')
      .map((s) => ({ id: s.id, title: s.title }));
  }

  // ---------- task CRUD -----------------------------------------------------------------

  createTask(input: {
    workspaceId: string;
    repo: string;
    targetBranch: string;
    title: string;
    description: string;
    acceptance: string;
    specId: string | null;
    attachments: readonly TaskAttachmentInput[];
    dependsOn?: readonly string[];
    priority: TaskPriority;
    queue: boolean;
    createdBy: string | null;
  }): TaskRecord {
    if (!this.code.repos.inWorkspace(input.repo, input.workspaceId)) {
      throw new Error(`repo ${input.repo} is not connected to this workspace`);
    }
    const now = Date.now();
    const task: TaskRecord = {
      id: `tsk-${randomUUID().slice(0, 12)}`,
      workspaceId: input.workspaceId,
      repo: input.repo,
      targetBranch: input.targetBranch,
      title: input.title,
      description: input.description,
      acceptance: input.acceptance,
      specId: input.specId,
      attachments: makeAttachments(input.attachments),
      dependsOn: this.sanitizeDependsOn(input.workspaceId, null, input.dependsOn ?? []),
      priority: input.priority,
      status: input.queue ? 'ready' : 'backlog',
      stage: input.queue ? 'build' : null,
      createdBy: input.createdBy,
      firstWorker: null,
      assignedWorkerId: null,
      runId: null,
      branch: null,
      prNumber: null,
      prUrl: null,
      reviewRisk: null,
      reviewRecommendation: null,
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.store.insertTask(task);
    this.store.insertEvent(task.id, 'created', input.queue ? 'created and queued' : 'created in backlog');
    this.changed();
    if (input.queue) this.kick();
    return task;
  }

  updateTask(
    id: string,
    fields: {
      title?: string;
      description?: string;
      acceptance?: string;
      specId?: string | null;
      attachments?: readonly TaskAttachmentInput[];
      dependsOn?: readonly string[];
      priority?: TaskPriority;
    },
  ): TaskRecord {
    const task = this.store.getTask(id);
    if (!task) throw new Error('task not found');
    const { attachments, dependsOn, ...patch } = fields;
    let sanitizedDeps: string[] | undefined;
    if (dependsOn !== undefined) {
      sanitizedDeps = this.sanitizeDependsOn(task.workspaceId, id, dependsOn);
      if (this.wouldCycle(id, sanitizedDeps)) throw new Error('those dependencies would form a cycle');
    }
    this.store.updateTask(id, {
      ...patch,
      ...(attachments ? { attachments: makeAttachments(attachments) } : {}),
      ...(sanitizedDeps ? { dependsOn: sanitizedDeps } : {}),
    });
    this.changed();
    // A removed prerequisite may make a ready task dispatchable right now.
    if (sanitizedDeps) this.kick();
    return this.store.getTask(id)!;
  }

  /**
   * Merge extra prerequisites into a task — the refinement import's late
   * linking (an item imported before its prerequisite gets the edge once the
   * prerequisite imports). Invalid and cycle-forming ids are dropped, never
   * thrown: this runs unattended.
   */
  addTaskDependencies(id: string, depIds: readonly string[]): void {
    const task = this.store.getTask(id);
    if (!task) return;
    const merged = [...task.dependsOn];
    for (const depId of this.sanitizeDependsOn(task.workspaceId, id, depIds)) {
      // One at a time: the existing set is acyclic, so checking each candidate
      // against the current graph keeps it acyclic.
      if (!merged.includes(depId) && !this.wouldCycle(id, [depId])) merged.push(depId);
    }
    if (merged.length === task.dependsOn.length) return;
    this.store.updateTask(id, { dependsOn: merged });
    this.store.insertEvent(id, 'dependency_added', `now waits for ${merged.length} task(s)`);
    this.changed();
  }

  /** Same-workspace existing tasks only; self-references and duplicates dropped. */
  private sanitizeDependsOn(workspaceId: string, selfId: string | null, depIds: readonly string[]): string[] {
    const kept = new Set<string>();
    for (const depId of depIds) {
      if (depId === selfId || kept.has(depId)) continue;
      const dep = this.store.getTask(depId);
      if (dep?.workspaceId === workspaceId) kept.add(depId);
    }
    return [...kept];
  }

  /** Would `id` depending on depIds close a loop? Walks the dep chains back to id. */
  private wouldCycle(id: string, depIds: readonly string[]): boolean {
    const stack = [...depIds];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === id) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.store.getTask(current);
      if (task) stack.push(...task.dependsOn);
    }
    return false;
  }

  /**
   * Human moves between columns. Machine columns are protected: you can queue
   * (→ ready), park (→ backlog, cancelling any active run), force-complete a
   * PR you merged yourself (in_review → done) or retry a failure (→ ready).
   * Queueing normalizes the stage: a task with no PR builds fresh; a task with
   * a PR re-enters the review cycle unless it carries bound remediation work.
   */
  async moveTask(id: string, to: TaskStatus): Promise<TaskRecord> {
    const task = this.store.getTask(id);
    if (!task) throw new Error('task not found');
    const from = task.status;
    if (to === from) return task;

    if (to === 'ready') {
      if (!['backlog', 'failed', 'in_review'].includes(from)) {
        throw new Error(`cannot queue a task from "${from}"`);
      }
      // Normalize the queue target: no PR → fresh build; bound remediation
      // work resumes; a PR with requested changes (either reviewer) is the
      // human's escape hatch to send it back to its worker; otherwise the
      // review cycle drives the card.
      const pr = task.prNumber != null ? this.code.prs.get(task.repo, task.prNumber) : undefined;
      const changesRequested =
        task.reviewRecommendation === 'request_changes' || pr?.reviewDecision === 'changes_requested';
      const patch: TaskPatch =
        task.prNumber == null
          ? { status: 'ready', stage: 'build' }
          : task.stage && WORK_STAGES.has(task.stage)
            ? { status: 'ready', stage: task.stage }
            : changesRequested
              ? { status: 'ready', stage: 'address_review' }
              : { status: 'in_review', stage: 'awaiting_review' };
      if (from === 'failed') {
        patch.attempts = 0;
        patch.lastError = null;
      }
      this.retryBackoff.delete(id);
      // A newly queued cycle may encounter the same infrastructure blocker and
      // must be allowed to alert again.
      this.clearBlockers(id);
      this.store.updateTask(id, patch);
      this.store.insertEvent(id, 'queued', `moved from ${from}`);
    } else if (to === 'backlog') {
      if (!['ready', 'failed', 'in_review', 'in_progress'].includes(from)) {
        throw new Error(`cannot park a task from "${from}"`);
      }
      this.clearBlockers(id);
      // Detach BEFORE discarding: markRun('abandoned') re-emits run.changed
      // synchronously, and onRunChanged must find nothing to react to. A
      // parked remediation keeps its work stage so re-queueing resumes it.
      const runId = task.runId;
      this.store.updateTask(id, {
        status: 'backlog',
        stage: task.stage && WORK_STAGES.has(task.stage) ? task.stage : null,
        runId: null,
      });
      this.store.insertEvent(id, from === 'in_progress' ? 'cancelled' : 'parked', `moved from ${from}`);
      if (runId) {
        await this.code.fixes.discard(runId).catch((err) => log.warn('board: discard on park failed', { err: String(err) }));
      }
    } else if (to === 'done') {
      if (from !== 'in_review') throw new Error('only a task in review can be completed by hand');
      this.clearBlockers(id);
      this.store.updateTask(id, { status: 'done', stage: null, runId: null, finishedAt: Date.now(), lastError: null });
      this.store.insertEvent(id, 'done', 'completed by hand');
    } else {
      throw new Error(`tasks cannot be moved to "${to}" by hand`);
    }

    this.changed();
    this.kick();
    return this.store.getTask(id)!;
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.store.getTask(id);
    if (!task) return;
    // Clear before deleting because task deletion also removes its event log.
    this.clearBlockers(id);
    // Delete first: discard() re-emits run.changed synchronously and nothing
    // may react to it; the row being gone makes every late event a no-op.
    this.store.deleteTask(id);
    this.mergeBackoff.delete(id);
    this.reviewBackoff.delete(id);
    this.retryBackoff.delete(id);
    if (task.runId) {
      await this.code.fixes.discard(task.runId).catch((err) => log.warn('board: discard on delete failed', { err: String(err) }));
    }
    this.changed();
    this.kick();
  }

  // ---------- worker CRUD -----------------------------------------------------------------

  createWorker(workspaceId: string, name: string, role: WorkerRole): WorkerRecord {
    const worker: WorkerRecord = {
      id: `wkr-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name,
      role,
      enabled: true,
      createdAt: Date.now(),
    };
    this.store.insertWorker(worker);
    this.changed();
    this.kick();
    return worker;
  }

  updateWorker(id: string, fields: { name?: string; role?: WorkerRole; enabled?: boolean }): WorkerRecord {
    if (!this.store.getWorker(id)) throw new Error('worker not found');
    this.store.updateWorker(id, fields);
    this.changed();
    this.kick();
    return this.store.getWorker(id)!;
  }

  deleteWorker(id: string): void {
    const worker = this.store.getWorker(id);
    if (!worker) return;
    const busy = this.store.busyWorkerMap();
    if (busy.has(id)) throw new Error('worker is building a task — wait for it to finish or cancel the task first');
    this.store.deleteWorker(id);
    const config = this.store.getConfig(worker.workspaceId);
    if (config.reviewerWorkerId === id) this.store.setConfig(worker.workspaceId, { ...config, reviewerWorkerId: null });
    this.changed();
  }

  // ---------- config -----------------------------------------------------------------------

  getConfig(workspaceId: string): BoardConfig {
    return this.store.getConfig(workspaceId);
  }

  setConfig(workspaceId: string, patch: Partial<BoardConfig>): BoardConfig {
    // A workspace-wide credential pin would let background work borrow the
    // profile that configured the board. Legacy pins are discarded; merge
    // resolution is always bound to the task owner instead.
    const next = { ...this.store.getConfig(workspaceId), ...patch, mergeAccountId: null };
    if (next.reviewerWorkerId) {
      const reviewer = this.store.getWorker(next.reviewerWorkerId);
      if (!reviewer) throw new Error('reviewer worker not found');
      if (reviewer.role !== 'reviewer') throw new Error(`${reviewer.name} is not a reviewer`);
      if (reviewer.workspaceId !== workspaceId) throw new Error(`${reviewer.name} belongs to another workspace`);
    }
    this.store.setConfig(workspaceId, next);
    this.changed();
    this.kick();
    return next;
  }

  // ---------- the engine ---------------------------------------------------------------------

  /** Nudge the reconcile loop (fire-and-forget; single-flight). */
  kick(): void {
    void this.tick().catch((err) => log.warn('board tick crashed', { err: String(err) }));
  }

  /**
   * The reconcile pass: recover anything the previous daemon life left
   * dangling, hand queued tasks to free workers, and advance the review cycle
   * of every PR on the board. Single-flight; a kick during a pass queues
   * exactly one follow-up pass.
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.ticking) {
      this.tickQueued = true;
      return;
    }
    this.ticking = true;
    try {
      await this.recoverDangling();
      await this.dispatch();
      await this.reviewCycle();
    } finally {
      this.ticking = false;
      if (this.tickQueued && !this.disposed) {
        this.tickQueued = false;
        this.kick();
      }
    }
  }

  /** React to operate's run lifecycle (wired to the server bus in jobs.ts). */
  onRunChanged(run: RunRecord): void {
    if (this.disposed) return;
    // Any terminal run may free the first slot a Ready card is waiting for,
    // including runs owned by another module. Wake dispatch immediately rather
    // than waiting for the 45-second safety-net tick.
    if (SLOT_RELEASED.has(run.status)) this.kick();
    const task = this.store.taskByRunId(run.id);
    if (!task || task.runId !== run.id) return;
    if (run.status === 'review') {
      void this.approveFlow(task.id, run.id).catch((err) => {
        log.warn('board: approve flow crashed', { taskId: task.id, err: String(err) });
        this.attemptFail(task.id, `opening the PR failed: ${String(err)}`);
      });
    } else if (TERMINAL_FAIL.has(run.status)) {
      this.attemptFail(task.id, run.outcome?.slice(0, 300) ?? `agent run ${run.status}`);
    }
  }

  /**
   * Boot/periodic sweep: tasks pointing at runs that died (or finished) while
   * the board wasn't looking, and 'reviewing' rows orphaned by a restart.
   */
  private async recoverDangling(): Promise<void> {
    for (const task of this.store.listTasksByStatus('in_progress')) {
      if (!task.runId) {
        this.attemptFail(task.id, 'lost its run — requeued');
        continue;
      }
      const run = this.operate.runsStore.get(task.runId);
      if (!run) {
        this.attemptFail(task.id, 'run record disappeared — requeued');
      } else if (run.status === 'review') {
        await this.approveFlow(task.id, task.runId).catch((err) =>
          this.attemptFail(task.id, `opening the PR failed: ${String(err)}`),
        );
      } else if (run.status === 'completed' && run.pr_url) {
        // The daemon died between approve() and our bookkeeping — adopt the PR.
        this.store.updateTask(task.id, {
          status: 'in_review',
          stage: 'awaiting_review',
          runId: null,
          prNumber: task.prNumber ?? parsePrNumber(run.pr_url),
          prUrl: run.pr_url,
          branch: run.branch ?? task.branch,
        });
        this.store.insertEvent(task.id, 'pr_opened', `${run.pr_url} (recovered)`);
        this.changed();
      } else if (TERMINAL_FAIL.has(run.status)) {
        this.attemptFail(task.id, run.outcome?.slice(0, 300) ?? `agent run ${run.status}`);
      }
    }
    for (const task of this.store.listTasksByStatus('in_review')) {
      if (task.stage === 'reviewing' && !this.reviewing.has(task.workspaceId)) {
        this.store.updateTask(task.id, { stage: 'awaiting_review' });
        this.changed();
      }
    }
  }

  /**
   * Priority dispatch under the one-item-per-worker rule. A task with a sticky
   * worker (review feedback bound back to whoever built it) waits for exactly
   * that worker; everything else takes the first free developer.
   */
  private async dispatch(): Promise<void> {
    const busy = this.store.busyWorkerMap();
    // One free-developer pool per workspace — each board dispatches independently.
    const freeByWs = new Map<string, Map<string, WorkerRecord>>();
    for (const w of this.store.listWorkers()) {
      if (!w.enabled || w.role !== 'developer' || busy.has(w.id)) continue;
      const pool = freeByWs.get(w.workspaceId) ?? new Map<string, WorkerRecord>();
      pool.set(w.id, w);
      freeByWs.set(w.workspaceId, pool);
    }
    for (const task of this.store.listTasksByStatus('ready')) {
      if (Date.now() < (this.retryBackoff.get(task.id) ?? 0)) continue;
      // Hold until every prerequisite is done. A deleted prerequisite no
      // longer binds; a failed one holds the task until a human resolves it.
      if (this.unmetDependencies(task)) continue;
      // Runner saturation is queueing, not a failed attempt. Keep the card in
      // Ready and the worker unclaimed; a terminal run event (or heartbeat)
      // retries dispatch until capacity appears.
      if (!this.operate.runners.hasFreeCapacity(task.repo, 'board.worker', task.createdBy)) continue;
      // The board pushes and opens the PR on the agent's behalf, so push rights
      // are settled BEFORE dispatch: a build nobody can push is a wasted run
      // that only fails at the very end. Held in Ready — not a failed attempt.
      if (!(await this.canPush(task))) continue;
      const ws = task.workspaceId;
      const free = freeByWs.get(ws);
      if (!free || free.size === 0) {
        const hasDeveloper = this.store.listWorkers(ws).some((worker) => worker.enabled && worker.role === 'developer');
        if (!hasDeveloper) {
          this.notifyBlocker(
            task,
            'developer',
            'Board task is waiting for a developer',
            `No enabled developer is available for ${task.title}. Add or enable a developer worker to start it.`,
          );
        } else {
          // The infrastructure blocker is resolved even when all developers are
          // merely busy; a later genuine absence is a new actionable lifecycle.
          this.clearBlocker(task.id, 'developer');
        }
        continue;
      }
      let worker: WorkerRecord | undefined;
      if (task.assignedWorkerId) {
        const sticky = this.store.getWorker(task.assignedWorkerId);
        if (!sticky || !sticky.enabled || sticky.role !== 'developer' || sticky.workspaceId !== ws) {
          // Failover: the bound worker is gone (or left the workspace) — release the binding.
          this.store.updateTask(task.id, { assignedWorkerId: null });
          worker = free.values().next().value;
        } else if (free.has(sticky.id)) {
          worker = sticky;
        } else {
          continue; // bound worker is busy — the task waits for it
        }
      } else {
        worker = free.values().next().value;
      }
      this.clearBlocker(task.id, 'developer');
      if (!worker) continue;
      free.delete(worker.id);
      // Re-read: earlier iterations awaited run creation, and a human may have
      // parked or deleted this task in the meantime.
      const fresh = this.store.getTask(task.id);
      if (!fresh || fresh.status !== 'ready') continue;
      await this.startWork(fresh, worker);
    }
  }

  /**
   * Can this task's owner push to its repo? The board is the pusher-of-record,
   * so an owner whose accounts can only READ the repo produces a build that
   * dies at `git push`. Blocking here holds the card untouched (no attempt
   * consumed) until access is granted — the next tick then starts it.
   */
  private async canPush(task: TaskRecord): Promise<boolean> {
    if (!task.createdBy) {
      this.notifyBlocker(
        task,
        'github',
        'Board task has no GitHub owner',
        `${task.title} has no owning profile, so no personal GitHub credential can be resolved for ${task.repo}.`,
      );
      return false;
    }
    const { client, tried } = await this.code.githubAccounts
      .verifiedClientFor('runs', task.repo, { username: task.createdBy, need: 'push' })
      .catch(() => ({ client: null, tried: [] as string[] }));
    if (!client) {
      this.notifyBlocker(
        task,
        'github',
        'Board task cannot push to GitHub',
        `No connected GitHub account can push to ${task.repo}${tried.length ? ` (tried ${tried.join(', ')})` : ''}. ` +
          `Grant that account write access — the task starts on its own once it lands.`,
      );
      return false;
    }
    this.clearBlocker(task.id, 'github');
    return true;
  }

  /** True when a prerequisite still exists and isn't done yet. */
  private unmetDependencies(task: TaskRecord): boolean {
    return task.dependsOn.some((depId) => {
      const dep = this.store.getTask(depId);
      return dep !== undefined && dep.status !== 'done';
    });
  }

  /** Claim the worker, then start the stage-appropriate agent run. */
  private async startWork(task: TaskRecord, worker: WorkerRecord): Promise<void> {
    const stage: TaskStage = task.stage && WORK_STAGES.has(task.stage) ? task.stage : 'build';
    this.store.updateTask(task.id, {
      status: 'in_progress',
      stage,
      firstWorker: task.firstWorker ?? worker.name,
      assignedWorkerId: worker.id,
      lastError: null,
      startedAt: task.startedAt ?? Date.now(),
    });
    this.store.insertEvent(task.id, 'assigned', `${worker.name} picked this up (${stageLabel(stage)})`);
    this.changed();

    try {
      let run: RunRecord;
      // All board-dispatched agent work carries 'board.worker' so runners can
      // opt out of it wholesale — it is the heaviest automation in the system.
      if (stage === 'address_review') {
        run = await this.code.fixes.startReviewFix(task.repo, task.prNumber!, task.createdBy, 'board.worker');
      } else if (stage === 'fix_ci') {
        run = await this.code.fixes.startCheckFix(task.repo, task.prNumber!, task.createdBy, 'board.worker');
      } else {
        const repoRow = this.code.repos.get(task.repo);
        if (!repoRow) throw new Error(`repo ${task.repo} is not connected`);
        run = await this.code.fixes.createGoalRun({
          kind: 'implement',
          task: 'board.worker',
          title: `Task: ${task.title.slice(0, 60)}`,
          repo: task.repo,
          branchPrefix: `companion/task-${task.id.replace(/^tsk-/, '')}`,
          baseBranch: task.targetBranch,
          objective: this.buildObjective(task, task.targetBranch),
          userId: task.createdBy,
          attachments: task.attachments.flatMap(({ name, mediaType, content }) =>
            content ? [{ kind: 'image' as const, name, mediaType, content }] : [],
          ),
        });
      }
      // The human may have parked/deleted the task while the run was being
      // provisioned — their move wins; the fresh run is discarded, not attached.
      const current = this.store.getTask(task.id);
      if (!current || current.status !== 'in_progress' || current.assignedWorkerId !== worker.id) {
        await this.code.fixes.discard(run.id).catch(() => undefined);
        return;
      }
      this.store.updateTask(task.id, { runId: run.id, branch: run.branch ?? task.branch });
      this.store.insertEvent(task.id, 'run_started', `run ${run.id}`);
      this.changed();
    } catch (err) {
      // A slot can disappear between the preflight above and provisioning. If
      // that race happened, return to Ready without consuming the remediation
      // ceiling; the next released slot wakes dispatch again.
      if (!this.operate.runners.hasFreeCapacity(task.repo, 'board.worker', task.createdBy)) {
        this.store.updateTask(task.id, {
          status: 'ready',
          stage,
          runId: null,
          assignedWorkerId: null,
          lastError: null,
        });
        this.store.insertEvent(task.id, 'waiting_for_runner', 'all eligible runner slots are busy');
        this.changed();
        return;
      }
      this.attemptFail(task.id, `could not start work: ${String(err)}`);
    }
  }

  /** The fresh-build objective: the task card, plus the attached spec as context. */
  private buildObjective(task: TaskRecord, baseBranch: string): string {
    let specSection = '';
    if (task.specId) {
      const plan = this.plan();
      const spec = plan ? plan.specs.list(task.workspaceId).find((s) => s.id === task.specId) : undefined;
      if (spec) {
        const content = spec.content.length > MAX_SPEC_CHARS ? `${spec.content.slice(0, MAX_SPEC_CHARS)}\n… (spec truncated)` : spec.content;
        specSection = `\n## Specification: ${spec.title}\n${content}\n`;
      }
    }
    const acceptance = task.acceptance.trim()
      ? `\n## Acceptance criteria (definition of done)\n${task.acceptance.trim()}\n`
      : '';
    return `You are an autonomous software engineer working in a dedicated git worktree (branch off origin/${baseBranch}). Implement the following task from the development board.

## Task: ${task.title}

${task.description || '(no further description)'}
${acceptance}${specSection}
## Rules
- Work ONLY inside this worktree.
- Investigate the codebase, implement the task completely, and verify it (run existing tests, a build or a typecheck where possible).
- Follow the specification where one is given; where it is silent, match the conventions of the surrounding code.
- Commit your work with clear messages (git add + git commit). Do NOT push — the board reviews and pushes on your behalf.
- When the work is complete and verified, finish with a short summary of what you changed and how you verified it.`;
  }

  /**
   * The run finished its turn with a diff awaiting approval. The board IS the
   * reviewer-of-record here: verify there's an actual diff, push, and open (or
   * update) the PR — then hand the card to the review column.
   */
  private async approveFlow(taskId: string, runId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.runId !== runId || task.status !== 'in_progress') return;

    const { diff } = await this.code.fixes.diff(runId, task.targetBranch).catch(() => ({ diff: '' }));
    if (!diff.trim()) {
      // Detach/charge BEFORE discarding — the discard re-emits run.changed
      // synchronously and must find nothing to react to.
      const outcome = this.operate.runsStore.get(runId)?.outcome;
      if (outcome?.startsWith('fatal: ')) {
        // The run died (provider auth, gateway crash) — it never worked, so
        // neither "no changes needed" nor the plain no-diff message applies.
        this.attemptFail(taskId, `agent run died — ${outcome.slice('fatal: '.length, 300)}`);
      } else if ((task.stage === 'address_review' || task.stage === 'fix_ci') && task.prNumber != null) {
        // A remediation run with no diff means "nothing left to change" (the
        // feedback was already addressed) — re-running the builder would just
        // bounce spawn → no-op → spawn. Hand the card back to the review
        // cycle to re-verdict instead; attempts still bound the loop.
        this.store.updateTask(taskId, {
          status: 'in_review',
          stage: 'awaiting_review',
          runId: null,
          attempts: task.attempts + 1,
        });
        this.store.insertEvent(
          taskId,
          'no_changes',
          `${task.stage === 'fix_ci' ? 'CI repair' : 'review fix'} run changed nothing — back to review`,
        );
        this.changed();
      } else {
        this.attemptFail(taskId, 'agent finished without producing any changes');
      }
      await this.code.fixes.discard(runId).catch(() => undefined);
      this.kick();
      return;
    }

    // The diff fetch awaited; a human park/delete in that window wins.
    const beforePush = this.store.getTask(taskId);
    if (!beforePush || beforePush.runId !== runId || beforePush.status !== 'in_progress') return;

    const hadPr = task.prNumber != null;
    const { prUrl } = await this.code.fixes.approve(runId, {
      title: task.title,
      baseBranch: task.targetBranch,
      body: `${task.description ? `${task.description}\n\n` : ''}${
        task.acceptance.trim() ? `### Acceptance criteria\n${task.acceptance.trim()}\n\n` : ''
      }_Task \`${task.id}\` on the Companion board._`,
    });
    const run = this.operate.runsStore.get(runId);
    const after = this.store.getTask(taskId);
    if (!after) {
      log.warn('board: task deleted while its PR was being opened', { taskId, prUrl });
      return;
    }
    const prPatch: TaskPatch = {
      runId: after.runId === runId ? null : after.runId,
      prNumber: task.prNumber ?? parsePrNumber(prUrl),
      prUrl,
      branch: run?.branch ?? task.branch,
    };
    // Only advance the card if the human didn't move it mid-push; the PR
    // details are recorded either way (the PR now exists on GitHub).
    if (after.status === 'in_progress' && after.runId === runId) {
      Object.assign(prPatch, {
        status: 'in_review',
        stage: 'awaiting_review',
        reviewRisk: null,
        reviewRecommendation: null,
        lastError: null,
      } satisfies TaskPatch);
    }
    this.store.updateTask(taskId, prPatch);
    this.store.insertEvent(taskId, hadPr ? 'pr_updated' : 'pr_opened', prUrl);
    this.notifyUser(task, 'finished', hadPr ? `Board task updated its PR` : `Board task opened a PR`, `${task.title} — ${prUrl}`, `#/board?task=${taskId}`);
    this.changed();
    // Warm the PR cache so the review cycle sees the new head promptly.
    if (task.createdBy) {
      void this.code.sync.syncRepo(task.repo, task.workspaceId, task.createdBy).catch(() => undefined);
    }
    this.kick();
  }

  /**
   * Advance every PR-carrying card: detect external merges/closes, run the
   * reviewer worker (WIP 1), send failing CI or requested changes back to the
   * bound worker, and merge once the verdict is positive and checks are green.
   */
  private async reviewCycle(): Promise<void> {
    for (const task of this.store.listTasksByStatus('in_review')) {
      if (task.runId || !task.prNumber) continue;
      const config = this.configFor(task);
      const pr = this.code.prs.get(task.repo, task.prNumber);
      if (!pr) continue; // cache hasn't seen the PR yet — next pass
      if (pr.state === 'merged') {
        this.complete(task.id, `PR #${task.prNumber} merged`);
        continue;
      }
      if (pr.state === 'closed') {
        // Clear the PR binding so a human Retry rebuilds fresh instead of
        // instantly re-detecting the same closed PR.
        this.fail(task.id, `PR #${task.prNumber} was closed on GitHub without merging`, {
          prNumber: null,
          prUrl: null,
          branch: null,
          reviewRisk: null,
          reviewRecommendation: null,
        });
        continue;
      }
      if (task.stage === 'reviewing') continue; // verdict in flight

      if (task.stage !== 'awaiting_review' || !config.autoReview) {
        this.clearBlocker(task.id, 'reviewer');
      }
      if (task.stage === 'awaiting_review' && config.autoReview) {
        const reviewer = this.resolveReviewer(config, task.workspaceId);
        // Review paused until the workspace has an enabled reviewer worker.
        if (!reviewer) {
          this.notifyBlocker(
            task,
            'reviewer',
            'Board task is waiting for a reviewer',
            `PR #${task.prNumber} for ${task.title} needs review, but no enabled reviewer is configured.`,
          );
          continue;
        }
        this.clearBlocker(task.id, 'reviewer');
        if (Date.now() < (this.reviewBackoff.get(task.id) ?? 0)) continue;
        if (!this.reviewing.has(task.workspaceId)) void this.runReview(task.id, reviewer.name);
        continue;
      }

      // Merge gate — reached with a positive verdict (awaiting_merge), or in
      // human-review mode (autoReview off) where GitHub's decision governs.
      const approved = config.autoReview
        ? task.reviewRecommendation === 'approve'
        : pr.reviewDecision === 'approved';
      // Nothing actionable would come out of a checks fetch — skip the API call.
      if ((!approved || !config.autoMerge) && !config.autoFixCi) continue;
      // Legacy tasks may predate ownership. They stay visible but must never
      // inherit whichever profile happens to have an active request now.
      if (!task.createdBy) continue;
      const summary = await this.code.prChecks.trySummary(task.repo, task.prNumber, task.createdBy);
      if (!summary) continue;
      // Unknown = the fetch failed (token/permissions) — neither green enough
      // to merge nor evidence of failure worth a fix_ci cycle.
      if (summary.state === 'unknown') continue;
      if (summary.state === 'failing') {
        if (config.autoFixCi) this.bindBack(task.id, 'fix_ci', `CI failing on PR #${task.prNumber}`, config);
        continue;
      }
      if (summary.state === 'pending') continue;
      if (!approved || !config.autoMerge) continue;
      const notBefore = this.mergeBackoff.get(task.id) ?? 0;
      if (Date.now() < notBefore) continue;
      await this.mergeTask(task, config);
    }
  }

  /**
   * The reviewer worker for a task: the configured pin when valid, otherwise —
   * pin unset (null = automatic resolution) — the
   * workspace's first enabled reviewer. A fresh workspace with reviewer
   * workers must review out of the box, not sit silently paused.
   */
  private resolveReviewer(config: BoardConfig, workspaceId: string): WorkerRecord | undefined {
    if (config.reviewerWorkerId) {
      const pinned = this.store.getWorker(config.reviewerWorkerId);
      return pinned?.enabled && pinned.role === 'reviewer' ? pinned : undefined;
    }
    return this.store.listWorkers(workspaceId).find((w) => w.enabled && w.role === 'reviewer');
  }

  /** One reviewer, one PR at a time: analyze, post the verdict, route the card. */
  private async runReview(taskId: string, reviewerName: string): Promise<void> {
    const guard = this.store.getTask(taskId);
    if (!guard) return;
    const ws = guard.workspaceId;
    if (this.reviewing.has(ws)) return;
    this.reviewing.add(ws);
    try {
      const task = this.store.getTask(taskId);
      if (!task || task.status !== 'in_review' || !task.prNumber) return;
      const config = this.configFor(task);
      this.store.updateTask(taskId, { stage: 'reviewing' });
      this.store.insertEvent(taskId, 'review_started', `${reviewerName} is reviewing PR #${task.prNumber}`);
      this.changed();

      if (!task.createdBy) throw new Error('task has no GitHub account owner');
      const result = await this.code.prReviews.analyzePr(task.repo, task.prNumber, task.createdBy, {
        context: this.reviewBriefing(task, config),
      });
      const fresh = this.store.getTask(taskId);
      if (!fresh || fresh.status !== 'in_review' || fresh.stage !== 'reviewing' || fresh.prNumber !== task.prNumber) return;

      if (!result.verdict) {
        // Reviewer-infrastructure failure — not the task's fault. Back off and
        // retry later without charging the task's attempt budget.
        this.reviewBackoff.set(taskId, Date.now() + REVIEW_BACKOFF_MS);
        this.store.updateTask(taskId, { stage: 'awaiting_review' });
        this.store.insertEvent(taskId, 'review_failed', (result.error ?? 'no verdict').slice(0, 300));
        this.changed();
        return;
      }
      this.reviewBackoff.delete(taskId);
      const { risk, recommendation, summary } = result.verdict;
      this.store.updateTask(taskId, { reviewRisk: risk, reviewRecommendation: recommendation });
      this.store.insertEvent(taskId, 'review_verdict', `${recommendation.replace('_', ' ')} · risk ${risk} — ${summary.slice(0, 300)}`);
      // Publish the verdict on the PR: the audit trail, and what a
      // review-fix run reads its feedback from.
      try {
        await this.code.prReviews.apply(result.id, undefined, task.createdBy);
      } catch (err) {
        this.store.insertEvent(taskId, 'review_post_failed', String(err).slice(0, 300));
      }

      if (recommendation === 'request_changes') {
        this.bindBack(taskId, 'address_review', `reviewer requested changes on PR #${task.prNumber}`, config);
      } else {
        this.store.updateTask(taskId, { stage: 'awaiting_merge' });
        if (recommendation === 'comment') {
          // Non-blocking review: auto-merge only acts on 'approve', so this
          // card waits for a human call — say so instead of parking silently.
          this.notifyUser(
            task,
            'action_required',
            `Board task needs a decision: ${task.title.slice(0, 60)}`,
            `The review left comments on PR #${task.prNumber} without approving. Merge it from the task, queue it back to its worker, or mark it done.`,
            `#/board?task=${taskId}`,
          );
        } else if (!config.autoMerge) {
          // Approved with auto-merge off: the human owns the merge — hand them
          // the task (its Merge button) rather than leaving the card to sit.
          this.notifyUser(
            task,
            'action_required',
            `Board task ready to merge: ${task.title.slice(0, 60)}`,
            `The review approved PR #${task.prNumber}. Auto-merge is off — merge it from the task or on GitHub.`,
            `#/board?task=${taskId}`,
          );
        }
      }
      this.changed();
      this.kick();
    } catch (err) {
      log.warn('board: review crashed', { taskId, err: String(err) });
      this.reviewBackoff.set(taskId, Date.now() + REVIEW_BACKOFF_MS);
      const current = this.store.getTask(taskId);
      if (current?.status === 'in_review' && current.stage === 'reviewing') {
        this.store.updateTask(taskId, { stage: 'awaiting_review' });
        this.store.insertEvent(taskId, 'review_failed', String(err).slice(0, 300));
        this.changed();
      }
    } finally {
      this.reviewing.delete(ws);
    }
  }

  /**
   * The reviewer's briefing for this loop: verdicts route the card, so be
   * decisive; findings are fixed in ONE remediation pass, so be exhaustive; and
   * re-reviews must converge instead of surfacing fresh nitpicks every round.
   */
  private reviewBriefing(task: TaskRecord, config: BoardConfig): string {
    const prior = this.store
      .listEvents(task.id)
      .filter((e) => e.kind === 'review_verdict')
      .reverse(); // the store returns newest-first; the briefing reads in order
    const lines = [
      `This review is part of an autonomous build/review loop on a task board (round ${prior.length + 1}; remediation budget ${task.attempts}/${config.maxAttempts} used). Your verdict routes the card automatically:`,
      `- "request_changes" — the PR returns to the agent that built it, which addresses ALL your findings in one pass.`,
      `- "approve" — the PR ${config.autoMerge ? 'is merged automatically once checks are green' : 'is handed to a human to merge'}.`,
      `- "comment" — the loop STOPS and waits for a human decision. Reserve it for questions that genuinely need human judgment; minor polish is not such a question.`,
      '',
      `Report EVERY issue that must be fixed in THIS verdict — nothing may be held back for a later round.`,
    ];
    if (task.acceptance.trim()) {
      lines.push('', 'Acceptance criteria for the task — verify the PR satisfies them:', task.acceptance.trim().slice(0, 2000));
    }
    if (prior.length > 0) {
      lines.push(
        '',
        'Your earlier verdicts on this PR:',
        ...prior.map((e, i) => `${i + 1}. ${e.detail.slice(0, 400)}`),
        '',
        'Re-review policy: verify the previously requested changes were addressed, and inspect what changed since for defects the changes INTRODUCED. Do not raise new concerns about code you already accepted in an earlier round — put minor or stylistic observations in the review body as non-blocking notes. If the earlier findings are resolved and nothing serious is new, approve.',
      );
    }
    return lines.join('\n');
  }

  /** Human "merge now" from the task view — the same path auto-merge takes. */
  async mergeNow(id: string): Promise<TaskRecord> {
    const task = this.store.getTask(id);
    if (!task) throw new Error('task not found');
    if (task.status !== 'in_review' || task.prNumber == null) {
      throw new Error('only a task in review with an open PR can be merged');
    }
    this.mergeBackoff.delete(id);
    await this.mergeTask(task, this.configFor(task));
    const fresh = this.store.getTask(id)!;
    if (fresh.status !== 'done') throw new Error(fresh.lastError ?? 'merge failed');
    return fresh;
  }

  /** Merge, comment, complete — with a backoff so a refusing branch doesn't get hammered. */
  private async mergeTask(task: TaskRecord, config: BoardConfig): Promise<void> {
    try {
      const { result, client, tried } = await this.code.githubAccounts.performForRepo(
        'pipelines',
        task.repo,
        (candidate) => candidate.mergePr(task.repo, task.prNumber!, config.mergeMethod),
        {
          username: task.createdBy,
          workspaceId: task.workspaceId,
          // Merging writes to the repo; a read-only account can only 403 here.
          need: 'push',
        },
      );
      if (!client || !result) {
        this.store.updateTask(task.id, {
          lastError:
            tried.length > 0
              ? `merge blocked: none of the connected GitHub accounts (${tried.join(', ')}) can merge pull requests in this repo`
              : `merge blocked: ${task.createdBy || 'the task owner'} has no personal GitHub account with merge access to this repo`,
        });
        this.mergeBackoff.set(task.id, Date.now() + MERGE_BACKOFF_MS);
        this.changed();
        return;
      }
      if (!result.merged) throw new Error(result.message || 'merge refused by GitHub');
      await client
        .comment(task.repo, task.prNumber!, 'Merged by the Companion board — review approved and checks green.')
        .catch(() => undefined);
      // Best-effort branch hygiene — a protected or fork branch never fails the merge.
      await client
        .deleteMergedPrBranch(task.repo, task.prNumber!)
        .catch((err) => log.warn('board: branch delete after merge failed', { taskId: task.id, err: String(err) }));
      this.mergeBackoff.delete(task.id);
      this.complete(task.id, `merged PR #${task.prNumber} (${config.mergeMethod})`);
      if (task.createdBy) {
        void this.code.sync.syncRepo(task.repo, task.workspaceId, task.createdBy).catch(() => undefined);
      }
    } catch (err) {
      this.mergeBackoff.set(task.id, Date.now() + MERGE_BACKOFF_MS);
      this.store.updateTask(task.id, { lastError: `merge failed: ${String(err).slice(0, 300)}` });
      this.store.insertEvent(task.id, 'merge_failed', String(err).slice(0, 300));
      this.changed();
    }
  }

  // ---------- transitions ---------------------------------------------------------------

  /**
   * Send the card back to the worker that built it (review feedback / CI
   * repair). Consumes an attempt so a PR can't ping-pong forever.
   */
  private bindBack(taskId: string, stage: 'address_review' | 'fix_ci', reason: string, config: BoardConfig): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    // Same ceiling as attemptFail: the Nth cycle is allowed, the (N+1)th fails.
    if (task.attempts + 1 > config.maxAttempts) {
      this.fail(taskId, `${reason} — attempt ceiling reached (${config.maxAttempts})`);
      return;
    }
    this.store.updateTask(taskId, {
      status: 'ready',
      stage,
      runId: null,
      attempts: task.attempts + 1,
      lastError: null,
    });
    this.store.insertEvent(taskId, stage === 'fix_ci' ? 'checks_failed' : 'changes_requested', `${reason} — bound back to its worker`);
    this.changed();
    this.kick();
  }

  /**
   * An attempt (build, remediation or review) failed: requeue with the sticky
   * binding released — failover to any free worker — or drop the card into
   * Failed once the ceiling is reached.
   */
  private attemptFail(taskId: string, reason: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const config = this.configFor(task);
    const attempts = task.attempts + 1;
    this.store.insertEvent(taskId, 'attempt_failed', reason.slice(0, 500));
    if (attempts >= config.maxAttempts) {
      this.store.updateTask(taskId, { attempts, runId: null, status: 'failed', lastError: reason.slice(0, 500) });
      this.notifyUser(task, 'error', `Board task failed: ${task.title.slice(0, 60)}`, reason.slice(0, 200), `#/board?task=${taskId}`);
    } else {
      const backTo: TaskPatch =
        task.stage && WORK_STAGES.has(task.stage)
          ? { status: 'ready', stage: task.stage }
          : task.prNumber != null
            ? { status: 'in_review', stage: 'awaiting_review' }
            : { status: 'ready', stage: 'build' };
      this.store.updateTask(taskId, { ...backTo, attempts, runId: null, assignedWorkerId: null, lastError: reason.slice(0, 500) });
      this.retryBackoff.set(taskId, Date.now() + RETRY_BACKOFF_MS);
    }
    this.changed();
    this.kick();
  }

  private complete(taskId: string, how: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    this.clearBlockers(taskId);
    this.mergeBackoff.delete(taskId);
    this.reviewBackoff.delete(taskId);
    this.retryBackoff.delete(taskId);
    this.store.updateTask(taskId, { status: 'done', stage: null, runId: null, finishedAt: Date.now(), lastError: null });
    this.store.insertEvent(taskId, 'done', how);
    this.notifyUser(task, 'finished', `Board task done: ${task.title.slice(0, 60)}`, how, `#/board?task=${taskId}`);
    this.changed();
    // Tasks waiting on this one may be dispatchable now.
    this.kick();
  }

  private fail(taskId: string, reason: string, extra?: TaskPatch): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    this.clearBlockers(taskId);
    this.mergeBackoff.delete(taskId);
    this.reviewBackoff.delete(taskId);
    this.retryBackoff.delete(taskId);
    this.store.updateTask(taskId, { ...extra, status: 'failed', stage: null, runId: null, lastError: reason.slice(0, 500) });
    this.store.insertEvent(taskId, 'failed', reason.slice(0, 500));
    this.notifyUser(task, 'error', `Board task failed: ${task.title.slice(0, 60)}`, reason.slice(0, 200), `#/board?task=${taskId}`);
    this.changed();
  }

  // ---------- plumbing --------------------------------------------------------------------

  private changed(): void {
    this.broadcast({ t: 'board.changed' });
  }

  /**
   * Periodic blockers remain actionable but produce only one inbox entry per
   * active lifecycle. Events provide the durable latch across daemon restarts.
   */
  private notifyBlocker(task: TaskRecord, blocker: string, title: string, body: string): void {
    if (this.store.hasActiveBlocker(task.id, blocker)) return;
    this.store.insertEvent(task.id, 'blocker_notified', blocker);
    this.notifyUser(task, 'action_required', title, body, `#/board?task=${task.id}`);
  }

  private clearBlocker(taskId: string, blocker: string): void {
    if (this.store.hasActiveBlocker(taskId, blocker)) {
      this.store.insertEvent(taskId, 'blocker_cleared', blocker);
    }
  }

  private clearBlockers(taskId: string): void {
    this.clearBlocker(taskId, 'developer');
    this.clearBlocker(taskId, 'reviewer');
    this.clearBlocker(taskId, 'github');
  }

  private notifyUser(task: TaskRecord, kind: 'finished' | 'error' | 'info' | 'action_required', title: string, body: string, href: string): void {
    this.notify.emit({
      kind,
      workspaceId: task.workspaceId,
      repo: task.repo,
      title,
      body,
      href,
    });
  }
}

function parsePrNumber(prUrl: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl);
  return match ? Number(match[1]) : null;
}

function stageLabel(stage: TaskStage): string {
  switch (stage) {
    case 'build':
      return 'building it';
    case 'address_review':
      return 'addressing review feedback';
    case 'fix_ci':
      return 'repairing CI';
    default:
      return stage;
  }
}

function makeAttachments(inputs: readonly TaskAttachmentInput[]): TaskAttachment[] {
  return inputs.map((input) => ({ ...input, id: `att-${randomUUID().slice(0, 12)}` }));
}
