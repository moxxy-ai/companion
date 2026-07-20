import { randomUUID } from 'node:crypto';
import type { AuthUser, ServiceMap, SpaServerMessage } from '@companion/contracts';
import type { NotificationEmitter } from '@companion/core/server';
import type { RunRecord, RunStatus } from '@companion/module-operate/contract';
import { log } from '@companion/services';
import type {
  BoardConfig,
  SpecOption,
  TaskEventRecord,
  TaskPriority,
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

/** Stages that mean "queued/running work of this kind" (valid in ready/in_progress). */
const WORK_STAGES: ReadonlySet<TaskStage> = new Set(['build', 'address_review', 'fix_ci']);

const MAX_SPEC_CHARS = 12_000;
const MERGE_BACKOFF_MS = 10 * 60_000;
const REVIEW_BACKOFF_MS = 5 * 60_000;

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
  /** Reviewer WIP-1 within this daemon life; stale 'reviewing' rows are swept on boot. */
  private reviewInFlight = false;
  private readonly mergeBackoff = new Map<string, number>();
  /** Reviewer-infrastructure failures back off without charging the task's attempts. */
  private readonly reviewBackoff = new Map<string, number>();
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

  // ---------- reads -------------------------------------------------------------------

  listBoard(user: AuthUser): { tasks: TaskRecord[]; workers: WorkerView[]; config: BoardConfig } {
    const tasks = this.store.listTasks().filter((t) => this.workspace.canAccessRepo(user, t.repo));
    const busy = this.store.busyWorkerMap();
    const workers = this.store.listWorkers().map((w): WorkerView => {
      const b = busy.get(w.id);
      // Busy-ness is visible to everyone (it drives the WIP maths); the task's
      // identity is workspace data and is redacted for non-members.
      const visible = b ? this.workspace.canAccessRepo(user, b.repo) : false;
      return {
        ...w,
        busy: b != null,
        busyTaskId: visible ? b!.taskId : null,
        busyTaskTitle: visible ? b!.title : null,
      };
    });
    return { tasks, workers, config: this.store.getConfig() };
  }

  getTask(user: AuthUser, id: string): { task: TaskRecord; events: TaskEventRecord[] } | null {
    const task = this.store.getTask(id);
    if (!task || !this.workspace.canAccessRepo(user, task.repo)) return null;
    return { task, events: this.store.listEvents(id) };
  }

  /** Spec picker options for a repo — empty when the plan module is disabled. */
  specOptions(repo: string): SpecOption[] {
    const plan = this.plan();
    const workspaceId = this.code.repos.get(repo)?.workspace_id;
    if (!plan || !workspaceId) return [];
    return plan.specs
      .list(workspaceId)
      .filter((s) => s.repo === repo && s.status === 'ready')
      .map((s) => ({ id: s.id, title: s.title }));
  }

  // ---------- task CRUD -----------------------------------------------------------------

  createTask(input: {
    repo: string;
    title: string;
    description: string;
    specId: string | null;
    priority: TaskPriority;
    queue: boolean;
  }): TaskRecord {
    if (!this.code.repos.get(input.repo)) throw new Error(`repo ${input.repo} is not connected`);
    const now = Date.now();
    const task: TaskRecord = {
      id: `tsk-${randomUUID().slice(0, 12)}`,
      repo: input.repo,
      title: input.title,
      description: input.description,
      specId: input.specId,
      priority: input.priority,
      status: input.queue ? 'ready' : 'backlog',
      stage: input.queue ? 'build' : null,
      assignedWorkerId: null,
      runId: null,
      branch: null,
      prNumber: null,
      prUrl: null,
      reviewRisk: null,
      reviewRecommendation: null,
      attempts: 0,
      lastError: null,
      humanInstructions: null,
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
    fields: { title?: string; description?: string; specId?: string | null; priority?: TaskPriority },
  ): TaskRecord {
    const task = this.store.getTask(id);
    if (!task) throw new Error('task not found');
    this.store.updateTask(id, fields);
    this.changed();
    return this.store.getTask(id)!;
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
      this.store.updateTask(id, patch);
      this.store.insertEvent(id, 'queued', `moved from ${from}`);
    } else if (to === 'backlog') {
      if (!['ready', 'failed', 'in_review', 'in_progress'].includes(from)) {
        throw new Error(`cannot park a task from "${from}"`);
      }
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
      this.store.updateTask(id, { status: 'done', stage: null, runId: null, finishedAt: Date.now(), lastError: null });
      this.store.insertEvent(id, 'done', 'completed by hand');
    } else {
      throw new Error(`tasks cannot be moved to "${to}" by hand`);
    }

    this.changed();
    this.kick();
    return this.store.getTask(id)!;
  }

  /** Human reviews an exhausted task and explicitly chooses its next step. */
  async resolveFailure(
    id: string,
    decision: 'retry' | 'backlog' | 'done',
    instructions: string,
  ): Promise<TaskRecord> {
    const task = this.store.getTask(id);
    if (!task) throw new Error('task not found');
    if (task.status !== 'failed') throw new Error('only a failed task can be resolved');
    const guidance = instructions.trim();
    if (decision === 'retry' && !guidance) throw new Error('tell the next worker what to do differently');

    if (decision === 'retry') {
      this.store.updateTask(id, {
        status: 'ready',
        stage: task.prNumber == null ? 'build' : 'address_review',
        assignedWorkerId: null,
        attempts: 0,
        lastError: null,
        humanInstructions: guidance,
        finishedAt: null,
      });
      this.store.insertEvent(id, 'human_retry', guidance.slice(0, 2_000));
    } else if (decision === 'backlog') {
      this.store.updateTask(id, {
        status: 'backlog',
        stage: null,
        assignedWorkerId: null,
        lastError: null,
        humanInstructions: guidance || null,
      });
      this.store.insertEvent(id, 'human_parked', guidance.slice(0, 2_000) || 'parked after review');
    } else {
      this.store.updateTask(id, {
        status: 'done',
        stage: null,
        runId: null,
        lastError: null,
        humanInstructions: guidance || null,
        finishedAt: Date.now(),
      });
      this.store.insertEvent(id, 'human_done', guidance.slice(0, 2_000) || 'accepted after review');
    }
    this.changed();
    this.kick();
    return this.store.getTask(id)!;
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.store.getTask(id);
    if (!task) return;
    // Delete first: discard() re-emits run.changed synchronously and nothing
    // may react to it; the row being gone makes every late event a no-op.
    this.store.deleteTask(id);
    this.mergeBackoff.delete(id);
    this.reviewBackoff.delete(id);
    if (task.runId) {
      await this.code.fixes.discard(task.runId).catch((err) => log.warn('board: discard on delete failed', { err: String(err) }));
    }
    this.changed();
    this.kick();
  }

  // ---------- worker CRUD -----------------------------------------------------------------

  createWorker(name: string, role: WorkerRole): WorkerRecord {
    const worker: WorkerRecord = {
      id: `wkr-${randomUUID().slice(0, 12)}`,
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
    const busy = this.store.busyWorkerMap();
    if (busy.has(id)) throw new Error('worker is building a task — wait for it to finish or cancel the task first');
    this.store.deleteWorker(id);
    const config = this.store.getConfig();
    if (config.reviewerWorkerId === id) this.store.setConfig({ ...config, reviewerWorkerId: null });
    this.changed();
  }

  // ---------- config -----------------------------------------------------------------------

  getConfig(): BoardConfig {
    return this.store.getConfig();
  }

  setConfig(patch: Partial<BoardConfig>): BoardConfig {
    const next = { ...this.store.getConfig(), ...patch };
    if (next.reviewerWorkerId) {
      const reviewer = this.store.getWorker(next.reviewerWorkerId);
      if (!reviewer) throw new Error('reviewer worker not found');
      if (reviewer.role !== 'reviewer') throw new Error(`${reviewer.name} is not a reviewer`);
    }
    this.store.setConfig(next);
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
    if (!this.reviewInFlight) {
      for (const task of this.store.listTasksByStatus('in_review')) {
        if (task.stage === 'reviewing') {
          this.store.updateTask(task.id, { stage: 'awaiting_review' });
          this.changed();
        }
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
    const free = new Map(
      this.store
        .listWorkers()
        .filter((w) => w.enabled && w.role === 'developer' && !busy.has(w.id))
        .map((w) => [w.id, w]),
    );
    for (const task of this.store.listTasksByStatus('ready')) {
      if (free.size === 0) break;
      let worker: WorkerRecord | undefined;
      if (task.assignedWorkerId) {
        const sticky = this.store.getWorker(task.assignedWorkerId);
        if (!sticky || !sticky.enabled || sticky.role !== 'developer') {
          // Failover: the bound worker is gone — release the binding.
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
      if (!worker) break;
      free.delete(worker.id);
      // Re-read: earlier iterations awaited run creation, and a human may have
      // parked or deleted this task in the meantime.
      const fresh = this.store.getTask(task.id);
      if (!fresh || fresh.status !== 'ready') continue;
      await this.startWork(fresh, worker);
    }
  }

  /** Claim the worker, then start the stage-appropriate agent run. */
  private async startWork(task: TaskRecord, worker: WorkerRecord): Promise<void> {
    const stage: TaskStage = task.stage && WORK_STAGES.has(task.stage) ? task.stage : 'build';
    this.store.updateTask(task.id, {
      status: 'in_progress',
      stage,
      assignedWorkerId: worker.id,
      lastError: null,
      startedAt: task.startedAt ?? Date.now(),
    });
    this.store.insertEvent(task.id, 'assigned', `${worker.name} picked this up (${stageLabel(stage)})`);
    this.changed();

    try {
      let run: RunRecord;
      if (stage === 'address_review') {
        run = await this.code.fixes.startReviewFix(task.repo, task.prNumber!);
      } else if (stage === 'fix_ci') {
        run = await this.code.fixes.startCheckFix(task.repo, task.prNumber!);
      } else {
        const repoRow = this.code.repos.get(task.repo);
        if (!repoRow) throw new Error(`repo ${task.repo} is not connected`);
        run = await this.code.fixes.createGoalRun({
          kind: 'implement',
          title: `Task: ${task.title.slice(0, 60)}`,
          repo: task.repo,
          branchPrefix: `companion/task-${task.id.replace(/^tsk-/, '')}`,
          baseBranch: repoRow.default_branch,
          objective: this.buildObjective(task, repoRow.default_branch),
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
      this.attemptFail(task.id, `could not start work: ${String(err)}`);
    }
  }

  /** The fresh-build objective: the task card, plus the attached spec as context. */
  private buildObjective(task: TaskRecord, baseBranch: string): string {
    let specSection = '';
    if (task.specId) {
      const plan = this.plan();
      const workspaceId = this.code.repos.get(task.repo)?.workspace_id;
      const spec = plan && workspaceId ? plan.specs.list(workspaceId).find((s) => s.id === task.specId) : undefined;
      if (spec) {
        const content = spec.content.length > MAX_SPEC_CHARS ? `${spec.content.slice(0, MAX_SPEC_CHARS)}\n… (spec truncated)` : spec.content;
        specSection = `\n## Specification: ${spec.title}\n${content}\n`;
      }
    }
    return `You are an autonomous software engineer working in a dedicated git worktree (branch off origin/${baseBranch}). Implement the following task from the development board.

## Task: ${task.title}

${task.description || '(no further description)'}
${specSection}${task.humanInstructions ? `
## Human review and next-step guidance
${task.humanInstructions}

This guidance comes from the maintainer after earlier attempts failed. Treat it as authoritative and explicitly address it in your final summary.
` : ''}
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

    const { diff } = await this.code.fixes.diff(runId).catch(() => ({ diff: '' }));
    if (!diff.trim()) {
      // Charge the attempt (which detaches the run) BEFORE discarding — the
      // discard re-emits run.changed synchronously and must find nothing.
      this.attemptFail(taskId, 'agent finished without producing any changes');
      await this.code.fixes.discard(runId).catch(() => undefined);
      return;
    }

    // The diff fetch awaited; a human park/delete in that window wins.
    const beforePush = this.store.getTask(taskId);
    if (!beforePush || beforePush.runId !== runId || beforePush.status !== 'in_progress') return;

    const hadPr = task.prNumber != null;
    const { prUrl } = await this.code.fixes.approve(runId, {
      title: task.title,
      body: `${task.description ? `${task.description}\n\n` : ''}_Task \`${task.id}\` on the Companion board._`,
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
    this.notifyUser(task.repo, 'finished', hadPr ? `Board task updated its PR` : `Board task opened a PR`, `${task.title} — ${prUrl}`, `#/board`);
    this.changed();
    // Warm the PR cache so the review cycle sees the new head promptly.
    void this.code.sync.syncRepo(task.repo).catch(() => undefined);
    this.kick();
  }

  /**
   * Advance every PR-carrying card: detect external merges/closes, run the
   * reviewer worker (WIP 1), send failing CI or requested changes back to the
   * bound worker, and merge once the verdict is positive and checks are green.
   */
  private async reviewCycle(): Promise<void> {
    const config = this.store.getConfig();
    for (const task of this.store.listTasksByStatus('in_review')) {
      if (task.runId || !task.prNumber) continue;
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

      if (task.stage === 'awaiting_review' && config.autoReview) {
        const reviewer = config.reviewerWorkerId ? this.store.getWorker(config.reviewerWorkerId) : undefined;
        // Review paused until a reviewer worker is configured and enabled.
        if (!reviewer?.enabled || reviewer.role !== 'reviewer') continue;
        if (Date.now() < (this.reviewBackoff.get(task.id) ?? 0)) continue;
        if (!this.reviewInFlight) void this.runReview(task.id, reviewer.name);
        continue;
      }

      // Merge gate — reached with a positive verdict (awaiting_merge), or in
      // human-review mode (autoReview off) where GitHub's decision governs.
      const approved = config.autoReview
        ? task.reviewRecommendation === 'approve'
        : pr.reviewDecision === 'approved';
      // Nothing actionable would come out of a checks fetch — skip the API call.
      if ((!approved || !config.autoMerge) && !config.autoFixCi) continue;
      const summary = await this.code.prChecks.trySummary(task.repo, task.prNumber);
      if (!summary) continue;
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

  /** One reviewer, one PR at a time: analyze, post the verdict, route the card. */
  private async runReview(taskId: string, reviewerName: string): Promise<void> {
    this.reviewInFlight = true;
    try {
      const task = this.store.getTask(taskId);
      if (!task || task.status !== 'in_review' || !task.prNumber) return;
      this.store.updateTask(taskId, { stage: 'reviewing' });
      this.store.insertEvent(taskId, 'review_started', `${reviewerName} is reviewing PR #${task.prNumber}`);
      this.changed();

      const result = await this.code.prReviews.analyzePr(task.repo, task.prNumber);
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
        await this.code.prReviews.apply(result.id);
      } catch (err) {
        this.store.insertEvent(taskId, 'review_post_failed', String(err).slice(0, 300));
      }

      if (recommendation === 'request_changes') {
        this.bindBack(taskId, 'address_review', `reviewer requested changes on PR #${task.prNumber}`, this.store.getConfig());
      } else {
        this.store.updateTask(taskId, { stage: 'awaiting_merge' });
        if (recommendation === 'comment') {
          // Non-blocking review: auto-merge only acts on 'approve', so this
          // card waits for a human call — say so instead of parking silently.
          this.notifyUser(
            task.repo,
            'action_required',
            `Board task needs a decision: ${task.title.slice(0, 60)}`,
            `The review left comments on PR #${task.prNumber} without approving. Merge it, mark the task done, or queue it back to its worker.`,
            '#/board',
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
      this.reviewInFlight = false;
    }
  }

  /** Merge, comment, complete — with a backoff so a refusing branch doesn't get hammered. */
  private async mergeTask(task: TaskRecord, config: BoardConfig): Promise<void> {
    const client = this.code.githubAccounts.clientFor('pipelines', { repo: task.repo });
    if (!client) {
      this.store.updateTask(task.id, { lastError: 'merge blocked: GitHub is not configured for this repo' });
      this.mergeBackoff.set(task.id, Date.now() + MERGE_BACKOFF_MS);
      this.changed();
      return;
    }
    try {
      await client.mergePr(task.repo, task.prNumber!, config.mergeMethod);
      await client
        .comment(task.repo, task.prNumber!, 'Merged by the Companion board — review approved and checks green.')
        .catch(() => undefined);
      this.mergeBackoff.delete(task.id);
      this.complete(task.id, `merged PR #${task.prNumber} (${config.mergeMethod})`);
      void this.code.sync.syncRepo(task.repo).catch(() => undefined);
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
    const config = this.store.getConfig();
    const attempts = task.attempts + 1;
    this.store.insertEvent(taskId, 'attempt_failed', reason.slice(0, 500));
    if (attempts >= config.maxAttempts) {
      this.store.updateTask(taskId, { attempts, runId: null, status: 'failed', lastError: reason.slice(0, 500) });
      this.store.insertEvent(taskId, 'human_review_requested', 'automatic attempts exhausted — waiting for a maintainer decision');
      this.notifyUser(
        task.repo,
        'action_required',
        `Board task needs your decision: ${task.title.slice(0, 60)}`,
        `${reason.slice(0, 160)} Review the task and choose whether to retry with guidance, park it, or accept it as done.`,
        '#/board',
      );
    } else {
      const backTo: TaskPatch =
        task.stage && WORK_STAGES.has(task.stage)
          ? { status: 'ready', stage: task.stage }
          : task.prNumber != null
            ? { status: 'in_review', stage: 'awaiting_review' }
            : { status: 'ready', stage: 'build' };
      this.store.updateTask(taskId, { ...backTo, attempts, runId: null, assignedWorkerId: null, lastError: reason.slice(0, 500) });
    }
    this.changed();
    this.kick();
  }

  private complete(taskId: string, how: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    this.mergeBackoff.delete(taskId);
    this.reviewBackoff.delete(taskId);
    this.store.updateTask(taskId, { status: 'done', stage: null, runId: null, finishedAt: Date.now(), lastError: null });
    this.store.insertEvent(taskId, 'done', how);
    this.notifyUser(task.repo, 'finished', `Board task done: ${task.title.slice(0, 60)}`, how, '#/board');
    this.changed();
  }

  private fail(taskId: string, reason: string, extra?: TaskPatch): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    this.mergeBackoff.delete(taskId);
    this.reviewBackoff.delete(taskId);
    this.store.updateTask(taskId, { ...extra, status: 'failed', stage: null, runId: null, lastError: reason.slice(0, 500) });
    this.store.insertEvent(taskId, 'failed', reason.slice(0, 500));
    this.store.insertEvent(taskId, 'human_review_requested', 'automation cannot continue — waiting for a maintainer decision');
    this.notifyUser(
      task.repo,
      'action_required',
      `Board task needs your decision: ${task.title.slice(0, 60)}`,
      `${reason.slice(0, 160)} Review the task and choose what should happen next.`,
      '#/board',
    );
    this.changed();
  }

  // ---------- plumbing --------------------------------------------------------------------

  private changed(): void {
    this.broadcast({ t: 'board.changed' });
  }

  private notifyUser(repo: string, kind: 'finished' | 'error' | 'info' | 'action_required', title: string, body: string, href: string): void {
    this.notify.emit({
      kind,
      workspaceId: this.code.repos.get(repo)?.workspace_id ?? null,
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
