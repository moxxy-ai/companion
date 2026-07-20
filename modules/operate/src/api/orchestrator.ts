import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AskRequest, HistorySegment, MoxxyEvent, PromptAttachment } from '@companion/types';
import type { ModuleConfigAccessor } from '@companion/core';
import type { SpaServerMessage } from '@companion/contracts';
import type { NotificationKind } from '@companion/module-workspace/contract';
import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelCatalogProvider,
  RunKind,
  RunQueueSnapshot,
  RunRecord,
} from '../contract/index.js';
import { log, paths, type DaemonConfig } from '@companion/services';
import { rowToRun, type RunRow } from './runs-store.js';
import type { Checkouts } from '../exec/checkouts.js';
import type { MoxxyCli } from '../exec/cli.js';
import { Runners } from './runners-registry.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';
import type { OperateStore } from './operate-store.js';

/** Hard per-run output-token ceiling (goal mode upstream is uncapped). */
const MAX_RUN_OUTPUT_TOKENS = 400_000;

/** A queued unattended job: display metadata plus its start/cancel handles. */
interface QueueItem {
  id: string;
  kind: RunKind;
  title: string;
  repo: string | null;
  issueNumber: number | null;
  priority: number;
  enqueuedAt: number;
  /** How to replay this entry after a restart; absent = not persisted. */
  resume?: { type: string; args: Record<string, unknown> };
  /** Acquire a slot and run the job (resolves/rejects the caller's promise). */
  start: () => void;
  /** Reject the caller's promise; used when cancelled before it starts. */
  cancel: () => void;
}

/**
 * Default scheduling weight per kind — higher jumps ahead in the queue. Code
 * changes a human is waiting on (fix/implement) outrank review/triage, which
 * outrank background reports; interactive chats sit lowest so they never delay
 * automated work. Users can still reorder manually.
 */
const KIND_PRIORITY: Record<RunKind, number> = {
  fix: 70,
  implement: 70,
  triage: 50,
  analysis: 50,
  report: 30,
  interactive: 10,
  assistant: 10,
};

/** Stable identity for a resume descriptor (key order independent). */
function resumeKeyOf(resume: { type: string; args: Record<string, unknown> }): string {
  const parts = Object.keys(resume.args)
    .sort()
    .map((k) => `${k}=${String(resume.args[k])}`);
  return `${resume.type}:${parts.join('&')}`;
}

/**
 * Run lifecycle owner. A "run" is one moxxy session (one MOXXY_SESSION_ID)
 * executing on some runner (machine). Live runs have a serve+gateway pair
 * attached on their runner; reaped runs keep their transcript readable from
 * the session JSONL on that runner's disk. The Orchestrator never talks to a
 * gateway directly — it goes through the run's RunnerBackend, so local and
 * remote execution are indistinguishable to everything above it.
 */
export class Orchestrator implements RunnerEventSink {
  readonly runners: Runners;
  private readonly pendingAsks = new Map<string, Map<string, AskRequest>>();
  /** waitForTurn resolvers, keyed by runId. */
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  // Unattended runs schedule against the runners' combined capacity (shared +
  // dedicated): up to that many run at once, the rest wait in a visible queue
  // the user can reorder and cancel.
  private oneShotActive = 0;
  private readonly oneShotQueue: QueueItem[] = [];
  /** Per-kind replayers used to re-dispatch persisted queue entries on boot. */
  private readonly resumers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  /**
   * On boot, the persisted (priority, enqueuedAt) for each entry being resumed,
   * keyed by resume type+args. The re-dispatched item adopts these so the queue
   * order — including manual reordering — is reproduced exactly after a restart.
   */
  private pendingResume = new Map<string, { priority: number; enqueuedAt: number }>();

  constructor(
    private readonly store: OperateStore,
    private readonly config: DaemonConfig,
    checkouts: Checkouts,
    moxxyCli: MoxxyCli | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    githubTokenFor: (repo: string) => Promise<string | null> | string | null = () => null,
    private readonly moduleConfig: ModuleConfigAccessor = { values: () => ({}), get: () => null },
  ) {
    this.runners = new Runners(store, checkouts, moxxyCli, config.maxLiveRuns, this, broadcast, githubTokenFor);
  }

  /** The backend a run executes on (its runner, or local). */
  private backend(runId: string): RunnerBackend {
    return this.runners.backendForRun(this.store.runs.get(runId)?.runner_id ?? null);
  }

  // ---------- RunnerEventSink (fed by every backend, local or remote) ----------

  onTurnComplete(runId: string, turnId?: string): void {
    this.broadcast({ t: 'turn', runId, phase: 'complete', turnId });
    const waiters = this.turnWaiters.get(runId);
    if (waiters) {
      for (const resolve of [...waiters]) resolve();
      waiters.clear();
    }
    // Autonomous goal runs land in review when their driving turn ends;
    // attended chats (interactive / AI Help) go idle — the gateway stays live
    // but nothing is in flight, so they must not read as "running".
    const row = this.store.runs.get(runId);
    if (row && (row.kind === 'fix' || row.kind === 'implement') && row.status === 'running') {
      this.setStatus(runId, 'review');
      this.emitRunChanged(runId);
    } else if (row && (row.kind === 'interactive' || row.kind === 'assistant') && row.status === 'running') {
      this.setStatus(runId, 'idle');
      this.emitRunChanged(runId);
    }
  }

  onAsk(runId: string, ask: AskRequest): void {
    // Unattended runs must never park on a human. Tools without a declared
    // allow-policy (e.g. Glob on moxxy 0.26.0) reach the ask path; auto-allow
    // them — the real fences are the isolated clone/worktree cwd and the
    // permissions.json deny rules. Attended kinds (interactive chats, the AI
    // Help assistant) keep the human in the loop: their asks park in the UI.
    const row = this.store.runs.get(runId);
    const attended = row?.kind === 'interactive' || row?.kind === 'assistant';
    if (row && !attended && ask.kind === 'permission') {
      log.info('auto-allowing ask for unattended run', { runId, tool: ask.tool?.name });
      void this.respondAsk(runId, ask.requestId, { mode: 'allow' }).catch(() => undefined);
      return;
    }
    this.asksFor(runId).set(ask.requestId, ask);
    this.broadcast({ t: 'ask', runId, ask });
    this.notifyRun(runId, 'action_required', 'Agent needs your input');
  }

  onAskResolved(runId: string, requestId: string): void {
    this.asksFor(runId).delete(requestId);
    this.broadcast({ t: 'askResolved', runId, requestId });
  }

  onGone(runId: string): void {
    this.pendingAsks.delete(runId);
    const waiters = this.turnWaiters.get(runId);
    if (waiters) {
      for (const resolve of [...waiters]) resolve();
      waiters.clear();
    }
    const row = this.store.runs.get(runId);
    if (row && (row.status === 'running' || row.status === 'provisioning' || row.status === 'idle')) {
      this.setStatus(runId, 'stopped');
    }
    this.emitRunChanged(runId);
  }

  /** Boot-time recovery: daemon died with children; rows are the truth. */
  recover(): void {
    const swept = this.store.runs.markInterrupted();
    if (swept > 0) log.info(`marked ${swept} run(s) interrupted from previous daemon life`);
    // Children die with the daemon, so every socket file left behind is stale.
    try {
      for (const name of readdirSync(paths.sockets())) {
        rmSync(join(paths.sockets(), name), { force: true });
      }
    } catch {
      // sweep is best-effort
    }
  }

  start(): void {
    this.runners.start();
  }

  async shutdown(): Promise<void> {
    this.runners.stop();
    await this.runners.localBackend.stopAll();
  }

  // ---------- queries -----------------------------------------------------------

  private isLive(runId: string): boolean {
    return this.backend(runId).isLive(runId);
  }

  listRuns(): RunRecord[] {
    return this.store.runs.list().map((row) => rowToRun(row, this.isLive(row.id)));
  }

  getRun(runId: string): RunRecord | null {
    const row = this.store.runs.get(runId);
    return row ? rowToRun(row, this.isLive(runId)) : null;
  }

  pendingAsksFor(runId: string): AskRequest[] {
    return [...this.asksFor(runId).values()];
  }

  // ---------- lifecycle -----------------------------------------------------------

  /**
   * Provider-aware placement: resolve the model the run will actually ride
   * (explicit > kind pin > daemon default) to the providers that serve it,
   * and prefer a runner advertising one of them. Callers that provision a
   * worktree before createRun (fixes, pipelines) use this so the worktree
   * lands on the runner the run will execute on.
   */
  placeRun(repo: string | null, kind: RunKind, model?: string | null): string | null {
    const effective = model ?? this.pinnedModel(kind) ?? this.config.defaultModel;
    return this.runners.place(repo, this.providersForModel(effective));
  }

  async createRun(opts: {
    kind?: RunKind;
    title?: string;
    /** Prepared working dir (a worktree on the run's runner). When set,
     *  `runnerId` MUST identify the runner that owns it. */
    cwd?: string;
    /** Runner the run executes on; undefined = place by repo. */
    runnerId?: string | null;
    repo?: string | null;
    issueNumber?: number | null;
    proposalId?: string | null;
    branch?: string | null;
    model?: string | null;
    /** Owner of an attended run (interactive / AI Help); null for automated. */
    userId?: string | null;
  }): Promise<RunRecord> {
    const id = `run-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const kind: RunKind = opts.kind ?? 'interactive';
    // Reserve slots for automated work: attended chats (interactive / AI Help)
    // may not consume the last `reservedRunnerSlots` of the combined capacity,
    // so triage/review/fix always have room. Always leaves at least one chat
    // slot even on a single-runner install.
    if (kind === 'interactive' || kind === 'assistant') {
      const capacity = Math.max(1, this.runners.totalCapacity());
      const reserved = Math.min(capacity - 1, Math.max(0, this.reservedRunnerSlots()));
      if (this.store.runs.activeInteractiveCount() >= capacity - reserved) {
        throw new Error(
          `All runner slots are busy and ${reserved} ${reserved === 1 ? 'is' : 'are'} reserved for automated work — close a chat or try again shortly.`,
        );
      }
    }
    // Placement: an explicit runnerId wins; a caller-prepared cwd (a local
    // worktree/clone from a one-shot) pins to the local runner; otherwise pick
    // a ready runner for the repo and let its backend allocate a scratch dir.
    const runnerId =
      opts.runnerId !== undefined
        ? opts.runnerId
        : opts.cwd !== undefined
          ? null
          : this.placeRun(opts.repo ?? null, kind, opts.model ?? this.pinnedModel(kind));
    // Model: explicit override → the CHOSEN runner's pin for this action →
    // legacy global pin. null lets that runner's own moxxy default apply.
    const model =
      opts.model ?? this.runners.modelPinFor(runnerId, kind) ?? this.pinnedModel(kind);
    const backend = this.runners.backend(runnerId);
    // Reserve the slot atomically: persist the provisioning row (carrying
    // runner_id) BEFORE the first await, so a concurrent createRun's placement
    // counts this run and spreads instead of overshooting one runner's cap.
    // The scratch dir is allocated after; setPlacement backfills the real cwd.
    this.store.runs.insert({
      id,
      kind,
      status: 'provisioning',
      title: opts.title ?? 'New run',
      cwd: opts.cwd ?? '',
      repo: opts.repo ?? null,
      issueNumber: opts.issueNumber ?? null,
      proposalId: opts.proposalId ?? null,
      branch: opts.branch ?? null,
      prUrl: null,
      model,
      runnerId,
      userId: opts.userId ?? null,
      createdAt: now,
      updatedAt: now,
      inputTokens: 0,
      outputTokens: 0,
      outcome: null,
    });
    this.broadcast({ t: 'runs.changed' });

    let cwd = opts.cwd;
    if (cwd === undefined) {
      cwd = await backend.scratchDir(id);
      this.store.runs.setPlacement(id, runnerId, cwd);
    }

    try {
      await backend.spawn(id, cwd);
      this.setStatus(id, 'running');
    } catch (err) {
      this.setStatus(id, 'failed', String(err));
      this.emitRunChanged(id);
      throw err;
    }
    this.emitRunChanged(id);
    return this.getRun(id)!;
  }

  /** Drop a file into a run's working dir on whatever runner it executes on. */
  async writeRunFile(runId: string, relPath: string, content: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    await this.runners.backendForRun(run.runner_id ?? null).writeFile(run.cwd, relPath, content);
  }

  /** Re-attach a gateway to an existing (reaped/interrupted) run's session. */
  async resumeRun(runId: string): Promise<RunRecord> {
    const row = this.store.runs.get(runId);
    if (!row) throw new Error(`unknown run: ${runId}`);
    if (!this.isLive(runId)) {
      try {
        await this.backend(runId).spawn(runId, row.cwd);
      } catch (err) {
        log.warn('resume failed', { runId, err: String(err) });
        throw new Error(`could not resume: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A fix/implement run awaiting human review keeps its review status —
    // resuming just re-attaches the transcript/chat, it doesn't "un-review".
    if (row.status !== 'review') this.setStatus(runId, 'running');
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
  }

  async stopRun(runId: string): Promise<void> {
    await this.backend(runId).stop(runId);
    const row = this.store.runs.get(runId);
    if (row && (row.status === 'running' || row.status === 'idle')) this.setStatus(runId, 'stopped');
    this.emitRunChanged(runId);
  }

  /**
   * Single choke point for status changes: persists the transition and drops
   * an inbox notification for the ones a human acts on.
   */
  private setStatus(runId: string, status: RunRecord['status'], outcome?: string | null): void {
    const prev = this.store.runs.get(runId)?.status;
    this.store.runs.updateStatus(runId, status, outcome);
    if (prev === status) return;
    // AI Help conversations are per-user chat, not reviewable work — they churn
    // through completed/failed on every idle-reap and reset. Notifying would
    // drop an instance-wide inbox entry (no repo → no workspace) that every
    // user sees, so skip them entirely.
    if (this.store.runs.get(runId)?.kind === 'assistant') return;
    if (status === 'review') this.notifyRun(runId, 'action_required', 'Run ready for review');
    else if (status === 'completed') this.notifyRun(runId, 'finished', 'Run completed');
    else if (status === 'failed') this.notifyRun(runId, 'error', 'Run failed', outcome ?? undefined);
  }

  private notifyRun(runId: string, kind: NotificationKind, title: string, body?: string): void {
    const run = this.store.runs.get(runId);
    if (!run) return;
    const workspaceId = run.repo ? (this.store.repos.get(run.repo)?.workspace_id ?? null) : null;
    this.store.notifications.insert({
      id: `ntf-${randomUUID().slice(0, 12)}`,
      workspaceId,
      kind,
      title,
      body: body ?? run.title,
      href: this.runHref(run),
      createdAt: Date.now(),
    });
  }

  /**
   * The section a run's notification opens. The raw transcript (#/runs/:id) is
   * audit-only, so we route to the work itself: triage to its issue, reports to
   * the digest, CI analysis to its PR, and PR-building runs to the outcome
   * preview (which shows building / ready / shipped / failed).
   */
  private runHref(run: RunRow): string {
    const repo = run.repo;
    if (run.kind === 'triage' && repo && run.issue_number != null) {
      return `#/repos/${repo}/issues/${run.issue_number}`;
    }
    if (run.kind === 'report') return '#/digest';
    if (run.kind === 'analysis' && repo && run.issue_number != null) {
      return `#/repos/${repo}/prs/${run.issue_number}`;
    }
    return `#/runs/${run.id}/preview`;
  }

  markRun(runId: string, status: RunRecord['status'], outcome?: string): void {
    this.setStatus(runId, status, outcome ?? null);
    this.emitRunChanged(runId);
  }

  // ---------- interaction -----------------------------------------------------------

  async sendPrompt(runId: string, prompt: string, model?: string, attachments?: readonly PromptAttachment[]): Promise<{ turnId: string }> {
    const backend = this.requireLive(runId);
    // A new turn on an idle attended chat: it's working again.
    if (this.store.runs.get(runId)?.status === 'idle') {
      this.setStatus(runId, 'running');
      this.emitRunChanged(runId);
    }
    // Per-turn pin > the run's persisted override > the daemon default.
    let chosen = model ?? this.store.runs.get(runId)?.model ?? this.config.defaultModel;
    // Disabled selections quietly ride the daemon default instead of erroring.
    if (chosen !== this.config.defaultModel && this.disabledModels().has(chosen)) {
      chosen = this.config.defaultModel;
    }
    // A model whose provider provably isn't configured on the run's runner
    // would fail the turn — omit the override and let that runner's own moxxy
    // default model apply instead.
    if (!this.runnerServes(runId, chosen)) {
      log.info('model not served by the run\'s runner — riding the runner\'s default model', {
        runId,
        model: chosen,
      });
      const result = await backend.runTurn(runId, { prompt, attachments });
      this.broadcast({ t: 'turn', runId, phase: 'started', turnId: result.turnId });
      return result;
    }
    const result = await backend.runTurn(runId, { prompt, model: chosen, attachments });
    // The gateway never broadcasts turn.started — synthesize it.
    this.broadcast({ t: 'turn', runId, phase: 'started', turnId: result.turnId });
    return result;
  }

  /**
   * Can the run's runner serve this model? True unless BOTH sides are known
   * (the model resolves to providers via the catalog AND the runner reports
   * its provider list) and they don't intersect — unknowns stay permissive so
   * behavior only changes on a provable mismatch.
   */
  private runnerServes(runId: string, model: string): boolean {
    const wanted = this.providersForModel(model);
    if (!wanted) return true;
    const advertised = this.runners.providersFor(this.store.runs.get(runId)?.runner_id ?? null);
    if (advertised === null) return true;
    return wanted.some((w) => advertised.includes(w));
  }

  async setGoalMode(runId: string): Promise<void> {
    await this.requireLive(runId).setMode(runId, 'goal');
  }

  // ---------- model switching -----------------------------------------------------

  /**
   * Admin-pinned model for an action kind (settings `modelPin:<kind>`); new
   * runs of that kind ride the pin unless the caller overrides explicitly.
   * A pin pointing at a disabled model falls back to the daemon default.
   */
  private pinnedModel(kind: RunKind): string | null {
    const pinned = this.store.settings.get(`modelPin:${kind}`);
    if (!pinned || pinned.trim() === '') return null;
    return this.disabledModels().has(pinned) ? null : pinned;
  }

  /** Admin-disabled model ids (settings `disabledModels`, JSON array). */
  private disabledModels(): Set<string> {
    try {
      const raw = this.store.settings.get('disabledModels');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /** Admin-disabled provider names (settings `disabledProviders`, JSON array). */
  private disabledProviders(): Set<string> {
    try {
      const raw = this.store.settings.get('disabledProviders');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /**
   * Enabled providers that serve `model`, from the cached catalog. null =
   * no constraint derivable (no model, empty/stale catalog, or unknown model
   * id) — placement and the per-turn check then behave as before.
   */
  private providersForModel(model: string | null): string[] | null {
    if (!model) return null;
    const catalog = this.readCatalogCache();
    if (!catalog || catalog.length === 0) return null;
    const disabled = this.disabledProviders();
    const names = catalog
      .filter((p) => p.models.some((m) => m.id === model || `${p.name}/${m.id}` === model))
      .map((p) => p.name)
      .filter((name) => !disabled.has(name));
    return names.length > 0 ? names : null;
  }

  /** Connected providers + models, read live from the run's gateway. */
  async modelCatalog(runId: string): Promise<ModelCatalog> {
    const disabledProviders = this.disabledProviders();
    const disabledModels = this.disabledModels();
    const info = (await this.requireLive(runId).sessionInfo(runId)) as {
      activeProvider?: unknown;
      providers?: unknown;
      readyProviders?: unknown;
    } | null;
    const ready = new Set(
      Array.isArray(info?.readyProviders) ? info.readyProviders.filter((p) => typeof p === 'string') : [],
    );
    const providers: ModelCatalogProvider[] = (Array.isArray(info?.providers) ? info.providers : [])
      .map((raw): ModelCatalogProvider | null => {
        const p = raw as { name?: unknown; models?: unknown; enabled?: unknown };
        if (typeof p.name !== 'string') return null;
        const models: ModelCatalogModel[] = (Array.isArray(p.models) ? p.models : [])
          .map((m): ModelCatalogModel | null => {
            // Providers advertise models as ids or objects; tolerate both.
            if (typeof m === 'string') return { id: m, contextWindow: null };
            const obj = m as { id?: unknown; contextWindow?: unknown };
            if (typeof obj.id !== 'string') return null;
            return {
              id: obj.id,
              contextWindow: typeof obj.contextWindow === 'number' ? obj.contextWindow : null,
            };
          })
          .filter((m): m is ModelCatalogModel => m !== null);
        return {
          name: p.name,
          enabled: p.enabled !== false && !disabledProviders.has(p.name),
          ready: ready.has(p.name),
          models: models.filter((m) => !disabledModels.has(m.id) && !disabledModels.has(`${p.name}/${m.id}`)),
        };
      })
      .filter((p): p is ModelCatalogProvider => p !== null);
    // Cache the provider/model catalog so settings pages can offer dropdowns
    // even when no gateway is live anymore.
    try {
      this.store.settings.set('modelCatalogCache', JSON.stringify({ providers }));
    } catch {
      // cache is best-effort
    }
    return {
      activeProvider: typeof info?.activeProvider === 'string' ? info.activeProvider : null,
      providers,
      current: this.store.runs.get(runId)?.model ?? this.config.defaultModel,
      defaultModel: this.config.defaultModel,
    };
  }

  /**
   * Daemon-wide catalog for settings pages: read fresh from any live gateway,
   * else the cached copy from the last live one — and when neither exists,
   * probe: spawn a temporary gateway just to ask moxxy for the catalog, cache
   * it, and reap the process. Users never need to know model ids by heart.
   */
  async sharedModelCatalog(): Promise<{
    providers: ModelCatalogProvider[];
    defaultModel: string;
    fresh: boolean;
  }> {
    const liveId = this.runners.localBackend.liveIds()[0];
    if (liveId) {
      try {
        const catalog = await this.modelCatalog(liveId);
        return { providers: [...catalog.providers], defaultModel: this.config.defaultModel, fresh: true };
      } catch {
        // fall through to the cache
      }
    }
    let cached = this.readCatalogCache();
    if (!cached) {
      await this.probeCatalog();
      cached = this.readCatalogCache();
    }
    return { providers: cached ?? [], defaultModel: this.config.defaultModel, fresh: false };
  }

  private readCatalogCache(): ModelCatalogProvider[] | null {
    try {
      const raw = this.store.settings.get('modelCatalogCache');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { providers?: ModelCatalogProvider[] };
      return parsed.providers ?? null;
    } catch {
      return null;
    }
  }

  /** Single-flight, cooldown-guarded temporary-gateway catalog probe. */
  private catalogProbe: Promise<void> | null = null;
  private lastCatalogProbeAt = 0;

  private probeCatalog(): Promise<void> {
    if (this.catalogProbe) return this.catalogProbe;
    if (Date.now() - this.lastCatalogProbeAt < 60_000) return Promise.resolve();
    this.lastCatalogProbeAt = Date.now();
    const job = (async () => {
      const probeId = `catalog-probe-${randomUUID().slice(0, 8)}`;
      // The catalog probe is a local convenience — spawn on the local backend.
      const local = this.runners.localBackend;
      try {
        const cwd = await local.scratchDir(probeId);
        await local.spawn(probeId, cwd);
        await this.modelCatalog(probeId); // success path writes the cache
        log.info('model catalog probed via temporary gateway');
      } catch (err) {
        log.warn('model catalog probe failed', { err: String(err) });
      } finally {
        await local.stop(probeId).catch(() => undefined);
      }
    })();
    this.catalogProbe = job.finally(() => {
      this.catalogProbe = null;
    });
    return this.catalogProbe;
  }

  /**
   * On-the-fly model switch. The persisted override is authoritative (it rides
   * every runTurn); syncing the live session is best-effort because the
   * headless serve runner doesn't handle session.setModel/setProvider — there
   * the slash-command path (/provider, /model) is the supported fallback.
   */
  async setRunModel(runId: string, model: string | null, provider?: string): Promise<RunRecord> {
    if (!this.store.runs.get(runId)) throw new Error(`unknown run: ${runId}`);
    if (this.isLive(runId)) {
      const backend = this.backend(runId);
      if (provider) {
        await backend
          .setProvider(runId, provider)
          .catch(() => backend.runCommand(runId, 'provider', provider))
          .catch((err) => log.warn('provider switch failed', { runId, provider, err: String(err) }));
      }
      await backend
        .setModel(runId, model)
        .catch(() => (model ? backend.runCommand(runId, 'model', model) : undefined))
        .catch((err) => log.warn('session model sync failed', { runId, err: String(err) }));
    }
    this.store.runs.setModel(runId, model);
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
  }

  async abortTurn(runId: string, turnId?: string): Promise<void> {
    await this.requireLive(runId).abortTurn(runId, turnId);
  }

  async respondAsk(
    runId: string,
    requestId: string,
    response: { mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny'; optionId?: string; text?: string },
  ): Promise<void> {
    await this.requireLive(runId).respondAsk(runId, requestId, response);
    this.asksFor(runId).delete(requestId);
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    return this.backend(runId).loadHistory(runId, before, limit);
  }

  // ---------- autonomous runs ---------------------------------------------------------

  /** Resolves when the run's current turn completes (or its gateway dies). */
  waitForTurn(runId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let waiters = this.turnWaiters.get(runId);
      if (!waiters) {
        waiters = new Set();
        this.turnWaiters.set(runId, waiters);
      }
      const done = (): void => {
        clearTimeout(timer);
        waiters!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  /**
   * One bounded unattended turn: create run → prompt → await completion →
   * return the final assistant message → reap. Queued so batch jobs respect
   * the pool cap instead of exploding it.
   */
  runOneShot(opts: {
    kind: RunKind;
    title: string;
    cwd: string;
    repo?: string | null;
    issueNumber?: number | null;
    prompt: string;
    timeoutMs?: number;
    /**
     * Makes the queued entry survive a restart: on boot the named resumer is
     * re-invoked with these args (it rebuilds the prompt and re-enqueues). Omit
     * for work that can't be replayed from args alone (e.g. pipeline steps).
     */
    resume?: { type: string; args: Record<string, unknown> };
  }): Promise<{ runId: string; finalMessage: string | null }> {
    const job = async (): Promise<{ runId: string; finalMessage: string | null }> => {
      const run = await this.createRun(opts);
      try {
        const wait = this.waitForTurn(run.id, opts.timeoutMs ?? 10 * 60_000);
        await this.sendPrompt(run.id, opts.prompt);
        await wait;
        // turn.complete can race the session log's async flush — retry briefly
        // until the final assistant message is readable.
        let finalMessage: string | null = null;
        for (let attempt = 0; attempt < 8 && finalMessage === null; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
          finalMessage = await this.finalAssistantMessage(run.id);
        }
        if (finalMessage === null) {
          // Aborted stream, dead gateway, or timeout — never report success.
          const status = this.store.runs.get(run.id)?.status;
          this.setStatus(
            run.id,
            'failed',
            status === 'stopped' || status === 'interrupted'
              ? 'gateway died before the turn finished (daemon restart?)'
              : 'turn ended without a final assistant message',
          );
        } else {
          this.setStatus(run.id, 'completed');
        }
        return { runId: run.id, finalMessage };
      } catch (err) {
        this.setStatus(run.id, 'failed', String(err));
        throw err;
      } finally {
        await this.stopRun(run.id).catch(() => undefined);
      }
    };
    return this.scheduleOneShot(
      {
        kind: opts.kind,
        title: opts.title,
        repo: opts.repo ?? null,
        issueNumber: opts.issueNumber ?? null,
        resume: opts.resume,
      },
      job,
    );
  }

  // ---------- run queue -------------------------------------------------------

  /**
   * Enqueue an unattended job. It starts immediately if the combined runner
   * capacity has a free slot; otherwise it waits in a visible queue (reorderable
   * and cancellable) and starts when a slot frees. Replaces the old serial
   * queue — batches now fan out across the whole pool.
   */
  private scheduleOneShot<T>(
    meta: {
      kind: RunKind;
      title: string;
      repo: string | null;
      issueNumber: number | null;
      resume?: { type: string; args: Record<string, unknown> };
    },
    job: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A resumed entry adopts its persisted weight + enqueue time so the queue
      // order (priority + any manual reordering) is reproduced across restarts,
      // regardless of the order resumers happen to re-enqueue in.
      const resumeKey = meta.resume ? resumeKeyOf(meta.resume) : null;
      const restored = resumeKey ? this.pendingResume.get(resumeKey) : undefined;
      if (resumeKey && restored) this.pendingResume.delete(resumeKey);
      const priority = restored?.priority ?? KIND_PRIORITY[meta.kind] ?? 40;
      const item: QueueItem = {
        id: `q-${randomUUID().slice(0, 12)}`,
        kind: meta.kind,
        title: meta.title,
        repo: meta.repo,
        issueNumber: meta.issueNumber,
        priority,
        enqueuedAt: restored?.enqueuedAt ?? Date.now(),
        resume: meta.resume,
        start: () => {
          this.oneShotActive++;
          void job()
            .then(resolve, reject)
            .finally(() => {
              this.oneShotActive--;
              this.pumpQueue();
            });
        },
        cancel: () => reject(new Error('run cancelled before it started')),
      };
      this.oneShotQueue.push(item);
      this.sortQueue();
      this.pumpQueue();
      this.broadcastQueue();
    });
  }

  /** Order the waiting queue: higher weight first, then earliest enqueued. */
  private sortQueue(): void {
    this.oneShotQueue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
  }

  /**
   * Start as many queued jobs as free capacity allows. Occupancy is this
   * scheduler's in-flight jobs PLUS runs that bypass the queue (attended chats,
   * fix/implement started directly) — otherwise the queue would overcommit the
   * pool whenever chats are already holding slots.
   */
  private pumpQueue(): void {
    let started = false;
    const capacity = Math.max(1, this.runners.totalCapacity());
    const nonQueue = this.store.runs.activeNonQueueCount();
    while (this.oneShotQueue.length > 0 && this.oneShotActive + nonQueue < capacity) {
      this.oneShotQueue.shift()!.start();
      started = true;
    }
    if (started) this.broadcastQueue();
  }

  private broadcastQueue(): void {
    this.persistQueue();
    this.broadcast({ t: 'queue.changed' });
  }

  /** Mirror the waiting queue (replayable entries only) to the DB for restart. */
  private persistQueue(): void {
    try {
      this.store.runQueue.replaceAll(
        this.oneShotQueue
          .filter((q) => q.resume)
          .map((q) => ({
            id: q.id,
            kind: q.kind,
            title: q.title,
            repo: q.repo,
            issueNumber: q.issueNumber,
            priority: q.priority,
            resumeType: q.resume!.type,
            resumeArgs: q.resume!.args,
            enqueuedAt: q.enqueuedAt,
          })),
      );
    } catch (err) {
      log.warn('failed to persist run queue', { err: String(err) });
    }
  }

  /**
   * Register how a persisted queue entry of `type` is re-dispatched. Registering
   * also replays any matching work still waiting in the durable queue, so a
   * module enabled AFTER operate (e.g. module-code re-enabled at runtime) picks
   * up its own persisted entries instead of leaving them stranded.
   */
  registerResumer(type: string, fn: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.resumers.set(type, fn);
    this.replayResumable();
  }

  /**
   * Re-dispatch work that was still waiting when the daemon last stopped. Reads
   * the persisted queue and re-invokes each entry's resumer (which rebuilds the
   * prompt and re-enqueues fresh). Entries whose resumer isn't registered YET are
   * KEPT in the durable queue — their owning module isn't enabled — and replay
   * when it registers (never silently dropped). Call after services are wired.
   */
  resumePersistedQueue(): void {
    const total = this.store.runQueue.list().length;
    if (total === 0) return;
    log.info(`resuming persisted run queue (${total} entr${total === 1 ? 'y' : 'ies'})`);
    this.replayResumable();
    const remaining = this.store.runQueue.list().length;
    if (remaining > 0) log.info(`${remaining} queued run(s) await a not-yet-enabled module's resumer`);
  }

  /** Re-dispatch every queued entry whose resumer is registered; keep the rest persisted. */
  private replayResumable(): void {
    const entries = this.store.runQueue.list();
    const resumable = entries.filter((e) => this.resumers.has(e.resumeType));
    if (resumable.length === 0) return;
    // Keep unresumable entries in their persisted order; only the resumable ones
    // leave the durable queue as they re-dispatch.
    this.store.runQueue.replaceAll(entries.filter((e) => !this.resumers.has(e.resumeType)));
    for (const e of resumable) {
      // Remember each entry's persisted order so the re-dispatched item reclaims
      // its exact place, no matter what order the async resumers re-enqueue in.
      this.pendingResume.set(resumeKeyOf({ type: e.resumeType, args: e.resumeArgs }), {
        priority: e.priority,
        enqueuedAt: e.enqueuedAt,
      });
      void this.resumers.get(e.resumeType)!(e.resumeArgs).catch((err) =>
        log.warn(`failed to resume queued ${e.resumeType}`, { title: e.title, err: String(err) }),
      );
    }
  }

  /** Slots kept free from attended chats for automated work (module config, live). */
  private reservedRunnerSlots(): number {
    const v = this.moduleConfig.get('reservedRunnerSlots');
    return typeof v === 'number' ? v : 1;
  }

  /** The scheduler's live state for the UI: running count, capacity, and the line. */
  queueSnapshot(): RunQueueSnapshot {
    return {
      active: this.oneShotActive,
      capacity: Math.max(1, this.runners.totalCapacity()),
      entries: this.oneShotQueue.map((q, i) => ({
        id: q.id,
        position: i,
        kind: q.kind,
        title: q.title,
        repo: q.repo,
        issueNumber: q.issueNumber,
        priority: q.priority,
        enqueuedAt: q.enqueuedAt,
      })),
    };
  }

  /**
   * Move a waiting entry one step up or down. Swaps the two items' sort keys
   * (priority + enqueuedAt) rather than just their array slots, so the manual
   * order is encoded in persisted fields and survives a restart.
   */
  moveQueued(id: string, direction: 'up' | 'down'): boolean {
    const i = this.oneShotQueue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= this.oneShotQueue.length) return false;
    const a = this.oneShotQueue[i]!;
    const b = this.oneShotQueue[j]!;
    [a.priority, b.priority] = [b.priority, a.priority];
    [a.enqueuedAt, b.enqueuedAt] = [b.enqueuedAt, a.enqueuedAt];
    this.sortQueue();
    this.broadcastQueue();
    return true;
  }

  /** Drop a waiting entry before it starts; its caller sees a cancellation. */
  cancelQueued(id: string): boolean {
    const i = this.oneShotQueue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    const [item] = this.oneShotQueue.splice(i, 1);
    item!.cancel();
    this.broadcastQueue();
    return true;
  }

  async finalAssistantMessage(runId: string): Promise<string | null> {
    const segment = await this.loadHistory(runId, null, 300);
    for (let i = segment.events.length - 1; i >= 0; i--) {
      const event = segment.events[i];
      if (event?.type === 'assistant_message') {
        const content = (event as { content?: string }).content;
        if (typeof content === 'string' && content.trim()) return content;
      }
    }
    return null;
  }

  // ---------- internals -----------------------------------------------------------

  onEvent(runId: string, event: MoxxyEvent): void {
    if (event.type === 'provider_response') {
      const input = numberField(event, 'inputTokens');
      const output = numberField(event, 'outputTokens');
      if (input || output) this.store.runs.addUsage(runId, input, output);
      // moxxy's goal mode is uncapped (its built-in budgets were removed in
      // #439) — companiond's ceiling is the PRIMARY runaway-cost guard.
      const row = this.store.runs.get(runId);
      if (row && row.output_tokens > MAX_RUN_OUTPUT_TOKENS && row.status === 'running') {
        log.warn('run exceeded token ceiling — aborting', { runId, outputTokens: row.output_tokens });
        this.setStatus(runId, row.status, 'aborted: output token ceiling exceeded');
        void this.abortTurn(runId).catch(() => undefined);
      }
    }
    if (event.type === 'plugin_event') {
      const subtype = (event as { subtype?: string }).subtype ?? '';
      if (subtype === 'goal_completed' || subtype === 'goal_abandoned' || subtype === 'goal_stalled') {
        const payload = (event as { payload?: unknown }).payload;
        const info =
          typeof payload === 'object' && payload !== null ? (payload as { summary?: string; reason?: string }) : {};
        // Store just the human summary. The run STATUS already conveys
        // completed vs abandoned, so the "goal_completed:" prefix is noise —
        // and it was leaking into PR bodies/commit summaries.
        const summary = (info.summary ?? info.reason ?? '').trim();
        this.setStatus(runId, this.store.runs.get(runId)?.status ?? 'running', summary || null);
      }
    }
    this.broadcast({ t: 'event', runId, event });
  }

  /** The run's backend, asserting a live gateway is attached. */
  private requireLive(runId: string): RunnerBackend {
    const backend = this.backend(runId);
    if (!backend.isLive(runId)) {
      throw new Error(`run ${runId} has no live gateway (resume it first)`);
    }
    return backend;
  }

  private asksFor(runId: string): Map<string, AskRequest> {
    let map = this.pendingAsks.get(runId);
    if (!map) {
      map = new Map();
      this.pendingAsks.set(runId, map);
    }
    return map;
  }

  private emitRunChanged(runId: string): void {
    const run = this.getRun(runId);
    if (run) this.broadcast({ t: 'run.changed', run });
  }
}

function numberField(event: MoxxyEvent, key: string): number {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
