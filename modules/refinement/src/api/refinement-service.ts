import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServiceMap, SpaServerMessage } from '@companion/contracts';
import { log, extractModelJson } from '@companion/services';
import type { TaskPriority } from '@companion/module-board/contract';
import type {
  RefineContextOptions,
  RefineItemRecord,
  RefineMethodRecord,
  RefinementListEntry,
  RefinementRecord,
} from '../contract/index.js';
import type { RefinementStore } from './refinement-store.js';
import { BUILTIN_METHODS } from './builtin-methods.js';

type CodeService = ServiceMap['code'];
type PlanService = ServiceMap['plan'];
type BoardService = ServiceMap['board'];
type Orchestrator = ServiceMap['operate']['orchestrator'];
type Checkouts = ServiceMap['operate']['checkouts'];

/** Attached specs/docs are clipped so a fat document can't blow the prompt budget. */
const MAX_CONTEXT_CHARS = 6_000;
const MAX_CONTEXT_ENTRIES = 5;
const DECOMPOSE_TIMEOUT_MS = 12 * 60_000;

const decompositionSchema = z.object({
  summary: z.string().min(1),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string(),
        acceptance: z.string(),
        priority: z.number().int().min(0).max(3),
      }),
    )
    .min(1)
    .max(20),
});

type Decomposition = z.infer<typeof decompositionSchema>;

/**
 * Product refinement: the user writes an epic, picks a decomposition method
 * (built-in or user-defined) and optionally attaches plan specs/docs; a
 * READ-ONLY agent in a worktree at the chosen branch enriches the epic and
 * splits it into concrete task proposals. Review-then-apply: the agent only
 * proposes — the human imports items into the board (backlog or queued).
 */
export class RefinementService {
  constructor(
    private readonly store: RefinementStore,
    private readonly plan: PlanService,
    private readonly board: BoardService,
    private readonly code: CodeService,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** The workspace a refinement belongs to — via its repo (repos carry the scoping key). */
  private workspaceOf(repo: string): string | null {
    return this.code.repos.get(repo)?.workspace_id ?? null;
  }

  // ---------- CRUD ---------------------------------------------------------------------

  create(input: { repo: string; branch?: string; title: string; story: string }): RefinementRecord {
    const repoRow = this.code.repos.get(input.repo);
    if (!repoRow) throw new Error(`repo ${input.repo} is not connected`);
    const now = Date.now();
    const refinement: RefinementRecord = {
      id: `ref-${randomUUID().slice(0, 12)}`,
      repo: input.repo,
      branch: input.branch?.trim() || repoRow.default_branch,
      title: input.title,
      story: input.story,
      status: 'draft',
      error: null,
      methodId: null,
      specIds: [],
      docIds: [],
      summary: null,
      runId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(refinement);
    this.changed();
    return refinement;
  }

  update(id: string, fields: { title?: string; story?: string; branch?: string }): RefinementRecord {
    const refinement = this.store.get(id);
    if (!refinement) throw new Error('refinement not found');
    if (refinement.status === 'decomposing') {
      throw new Error('cannot edit while the decomposition agent is running');
    }
    this.store.update(id, fields);
    this.changed();
    return this.store.get(id)!;
  }

  remove(id: string): void {
    if (!this.store.get(id)) return;
    this.store.delete(id);
    this.changed();
  }

  listByWorkspace(workspaceId: string): RefinementListEntry[] {
    return this.store.listByWorkspace(workspaceId);
  }

  get(
    id: string,
  ): { refinement: RefinementRecord; items: RefineItemRecord[]; workspaceId: string | null } | undefined {
    const refinement = this.store.get(id);
    if (!refinement) return undefined;
    // workspaceId rides along so the client resolves methods against the
    // refinement's workspace, not whichever one the switcher happens to show.
    return { refinement, items: this.store.listItems(id), workspaceId: this.workspaceOf(refinement.repo) };
  }

  /** Spec/doc picker options for the refinement's repo/workspace — id + title only. */
  contextOptions(id: string): RefineContextOptions {
    const refinement = this.store.get(id);
    if (!refinement) throw new Error('refinement not found');
    const workspaceId = this.workspaceOf(refinement.repo);
    if (!workspaceId) return { specs: [], docs: [] };
    const specs = this.plan.specs
      .list(workspaceId)
      .filter((s) => s.repo === refinement.repo && s.status === 'ready')
      .map((s) => ({ id: s.id, title: s.title }));
    const docs = this.plan.docs
      .list(workspaceId)
      .filter((d) => d.repo === refinement.repo || d.repo === null)
      .map((d) => ({ id: d.id, title: d.title }));
    return { specs, docs };
  }

  // ---------- methods ------------------------------------------------------------------

  methods(workspaceId: string): RefineMethodRecord[] {
    return [...BUILTIN_METHODS, ...this.store.listMethods(workspaceId)];
  }

  saveMethod(
    workspaceId: string,
    fields: { name: string; description: string; instructions: string },
  ): RefineMethodRecord {
    const now = Date.now();
    const method: RefineMethodRecord & { workspaceId: string } = {
      id: `rm-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name: fields.name,
      description: fields.description,
      instructions: fields.instructions,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertMethod(method);
    this.changed();
    return method;
  }

  updateMethod(
    id: string,
    fields: { name?: string; description?: string; instructions?: string },
  ): RefineMethodRecord {
    if (id.startsWith('builtin-')) throw new Error('built-in methods cannot be edited');
    if (!this.store.getMethod(id)) throw new Error('method not found');
    this.store.updateMethod(id, fields);
    this.changed();
    return this.store.getMethod(id)!;
  }

  deleteMethod(id: string): void {
    if (id.startsWith('builtin-')) throw new Error('built-in methods cannot be deleted');
    if (this.store.deleteMethod(id)) this.changed();
  }

  /** A user-defined method row (built-ins have no row) — for route access gating. */
  customMethod(id: string): RefineMethodRecord | undefined {
    return this.store.getMethod(id);
  }

  // ---------- decomposition ------------------------------------------------------------

  /**
   * Validate and flip to 'decomposing' — synchronous, so an unknown/foreign
   * method or an already-running decomposition surfaces as a request error
   * instead of vanishing into a fire-and-forget. Returns the resolved method
   * for the async agent phase ({@link runDecompose}).
   */
  startDecompose(id: string, opts: { methodId: string; specIds: string[]; docIds: string[] }): RefineMethodRecord {
    const refinement = this.store.get(id);
    if (!refinement) throw new Error('refinement not found');
    if (refinement.status === 'decomposing') throw new Error('a decomposition is already running');
    const method = this.resolveMethod(refinement.repo, opts.methodId);
    // Persist only context ids that resolve for this repo/workspace — a stale
    // or foreign id would silently thin the prompt on every future run.
    const options = this.contextOptions(id);
    const specIds = opts.specIds.filter((specId) => options.specs.some((s) => s.id === specId));
    const docIds = opts.docIds.filter((docId) => options.docs.some((d) => d.id === docId));
    this.store.update(id, { methodId: opts.methodId, specIds, docIds, status: 'decomposing', error: null });
    this.changed();
    return method;
  }

  /**
   * The agent phase (async — resolves when the result is stored). Success
   * replaces the un-acted-on proposals; failure lands as status 'failed' +
   * error (imported items are never touched) — never a thrown rejection. The
   * worktree is removed in every outcome.
   */
  async runDecompose(id: string, method: RefineMethodRecord): Promise<void> {
    const refinement = this.store.get(id);
    if (!refinement) return;

    let worktree: string | null = null;
    let runId: string | null = null;
    try {
      // Idempotent and lock-serialized; without it a repo whose background
      // clone failed reads as a bogus "branch does not exist" error.
      await this.checkouts.clone(refinement.repo);
      try {
        worktree = await this.checkouts.addWorktreeAtBranch(
          refinement.repo,
          `refine-${id}-${Date.now().toString(36)}`,
          refinement.branch,
        );
      } catch (err) {
        throw new Error(
          `could not check out branch "${refinement.branch}" of ${refinement.repo} — does it exist on origin? (${String(err)})`,
        );
      }
      const oneShot = await this.orchestrator.runOneShot({
        kind: 'analysis',
        title: `Refine: ${refinement.title.slice(0, 60)}`,
        cwd: worktree,
        repo: refinement.repo,
        prompt: decomposePrompt(
          refinement,
          method,
          this.specContext(refinement.repo, refinement.specIds),
          this.docContext(refinement.repo, refinement.docIds),
        ),
        timeoutMs: DECOMPOSE_TIMEOUT_MS,
      });
      runId = oneShot.runId;
      const result = parseDecomposition(oneShot.finalMessage ?? '');
      // The refinement may have been deleted mid-run — nothing left to write.
      if (!this.store.get(id)) return;
      this.store.replaceProposed(id, this.toItems(id, result));
      this.store.update(id, { summary: result.summary, runId, status: 'ready', error: null });
      this.changed();
    } catch (err) {
      log.warn('refinement decompose failed', { id, err: String(err) });
      if (this.store.get(id)) {
        this.store.update(id, {
          status: 'failed',
          error: String(err instanceof Error ? err.message : err).slice(0, 500),
          // Keep the failed run reachable for its transcript (null = failed
          // before the run spawned; leave the previous run linked then).
          ...(runId ? { runId } : {}),
        });
        this.changed();
      }
    } finally {
      if (worktree) {
        await this.checkouts.removeWorktree(refinement.repo, worktree).catch(() => undefined);
      }
    }
  }

  private toItems(refinementId: string, result: Decomposition): RefineItemRecord[] {
    const now = Date.now();
    return result.tasks.map((task, index) => ({
      id: `ri-${randomUUID().slice(0, 12)}`,
      refinementId,
      ord: index,
      title: task.title,
      description: task.description,
      acceptance: task.acceptance,
      priority: task.priority as TaskPriority,
      status: 'proposed' as const,
      taskId: null,
      createdAt: now,
    }));
  }

  /** Builtin id or a custom row of the refinement's workspace — anything else is unknown. */
  private resolveMethod(repo: string, methodId: string): RefineMethodRecord {
    const builtin = BUILTIN_METHODS.find((m) => m.id === methodId);
    if (builtin) return builtin;
    const custom = this.store.getMethod(methodId);
    if (custom && custom.workspaceId === this.workspaceOf(repo)) return custom;
    throw new Error(`unknown decomposition method "${methodId}"`);
  }

  /** The attached ready specs of the refinement's repo, capped and clipped. */
  private specContext(repo: string, specIds: readonly string[]): Array<{ title: string; content: string }> {
    const workspaceId = this.workspaceOf(repo);
    if (!workspaceId || specIds.length === 0) return [];
    const wanted = new Set(specIds.slice(0, MAX_CONTEXT_ENTRIES));
    return this.plan.specs
      .list(workspaceId)
      .filter((s) => wanted.has(s.id) && s.repo === repo && s.status === 'ready')
      .slice(0, MAX_CONTEXT_ENTRIES)
      .map((s) => ({ title: s.title, content: s.content }));
  }

  /** The attached workspace docs, capped and clipped. */
  private docContext(repo: string, docIds: readonly string[]): Array<{ title: string; content: string }> {
    const workspaceId = this.workspaceOf(repo);
    if (!workspaceId || docIds.length === 0) return [];
    const docs: Array<{ title: string; content: string }> = [];
    for (const docId of docIds.slice(0, MAX_CONTEXT_ENTRIES)) {
      const doc = this.plan.docs.get(docId);
      if (doc && doc.workspaceId === workspaceId) docs.push({ title: doc.title, content: doc.content });
    }
    return docs;
  }

  // ---------- imports ------------------------------------------------------------------

  /** Import one proposed item into the board (review-then-apply's "apply"). */
  importItem(id: string, itemId: string, user: string | null, queue: boolean): RefineItemRecord {
    const item = this.importOne(id, itemId, user, queue);
    this.changed();
    return item;
  }

  /** Import every proposed item in build order; returns how many were imported. */
  importAll(id: string, user: string | null, queue: boolean): number {
    const proposed = this.store.listItems(id).filter((item) => item.status === 'proposed');
    for (const item of proposed) this.importOne(id, item.id, user, queue);
    if (proposed.length > 0) this.changed();
    return proposed.length;
  }

  private importOne(id: string, itemId: string, user: string | null, queue: boolean): RefineItemRecord {
    const refinement = this.store.get(id);
    if (!refinement) throw new Error('refinement not found');
    const item = this.store.getItem(itemId);
    if (!item || item.refinementId !== id) throw new Error('item not found');
    if (item.status !== 'proposed') throw new Error(`item is ${item.status}, not proposed`);
    const task = this.board.createTask({
      repo: refinement.repo,
      title: item.title,
      description: item.description,
      acceptance: item.acceptance,
      // Board tasks carry ONE spec as agent context — only an unambiguous
      // attachment travels; with several specs the task goes without.
      specId: refinement.specIds.length === 1 ? (refinement.specIds[0] ?? null) : null,
      attachments: [],
      priority: item.priority,
      queue,
      createdBy: user,
    });
    this.store.setItemStatus(itemId, 'imported', task.id);
    return this.store.getItem(itemId)!;
  }

  dismissItem(id: string, itemId: string): RefineItemRecord {
    const item = this.store.getItem(itemId);
    if (!item || item.refinementId !== id) throw new Error('item not found');
    if (item.status !== 'proposed') throw new Error(`item is ${item.status}, not proposed`);
    this.store.setItemStatus(itemId, 'dismissed', null);
    this.changed();
    return this.store.getItem(itemId)!;
  }

  // ---------- boot recovery ------------------------------------------------------------

  /** Boot sweep: 'decomposing' rows whose one-shot driver died with the daemon. */
  resetDangling(): number {
    const reset = this.store.resetDangling();
    if (reset > 0) this.changed();
    return reset;
  }

  // ---------- plumbing -----------------------------------------------------------------

  private changed(): void {
    this.broadcast({ t: 'refinement.changed' });
  }
}

function clip(text: string): string {
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated)` : text;
}

function contextSection(heading: string, entries: ReadonlyArray<{ title: string; content: string }>): string {
  if (entries.length === 0) return '';
  const blocks = entries.map((e) => `### ${e.title}\n${clip(e.content)}`).join('\n\n');
  return `\n## ${heading}\n\n${blocks}\n`;
}

function decomposePrompt(
  refinement: RefinementRecord,
  method: RefineMethodRecord,
  specs: ReadonlyArray<{ title: string; content: string }>,
  docs: ReadonlyArray<{ title: string; content: string }>,
): string {
  return `You are a senior product engineer decomposing an epic into development tasks for the repository checked out in the current directory (branch ${refinement.branch}).

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify/create/delete any file and must NOT run any write command (no git commit/push, no installs). Your ONLY output is the final JSON.

## Decomposition method: ${method.name}
${method.instructions}

## Epic: ${refinement.title}

${refinement.story}
${contextSection('Specifications (ground truth for behavior)', specs)}${contextSection('Documentation', docs)}
## Your task
Investigate the codebase to ground every task in reality — name the real files, modules and areas each task touches. Enrich the epic: fill in the unstated-but-necessary work (migrations, error handling, tests per the house norms you observe). Then decompose it per the method above into 3-15 tasks, each at most ~1 day of focused work, with verifiable acceptance criteria (a markdown bullet list), ordered by build sequence.

Reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "summary": "<enriched overview: approach, key decisions, explicit non-goals>",
  "tasks": [
    {
      "title": "<imperative, ≤ 80 chars>",
      "description": "<what and how, incl. files/areas>",
      "acceptance": "<markdown bullets, each verifiable>",
      "priority": 0 | 1 | 2 | 3
    }
  ]
}`;
}

/** Tolerant extraction, strict validation — a miss is failure, never a guess. */
export function parseDecomposition(text: string): Decomposition {
  return decompositionSchema.parse(extractModelJson(text));
}
