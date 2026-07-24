import { randomUUID } from 'node:crypto';
import type { SpaServerMessage } from '@companion/contracts';
import type { AgentStorageCleanupRequest } from '@companion/types';
import type {
  CreateRunnerRequest,
  GitCredentialResolver,
  ModelCatalogModel,
  ModelCatalogProvider,
  RunnerCatalog,
  RunnerHealth,
  RunnerPinnableKind,
  RunnerMoxxyUpdateResult,
  RunnerProbeResult,
  RunnerRecord,
  UpdateRunnerRequest,
} from '../contract/index.js';
import { log } from '@companion/services';
import type { OperateStore } from './operate-store.js';
import { LOCAL_RUNNER_ID, type RunnerRow } from './runners-store.js';
import type { Checkouts } from '../exec/checkouts.js';
import type { MoxxyCli } from '../exec/cli.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';
import { LocalRunnerBackend } from './local-backend.js';
import { RemoteRunnerBackend } from './remote-backend.js';

const HEALTH_POLL_MS = 30_000;
const STORAGE_CLEANUP_MS = 6 * 60 * 60_000;
const UNKNOWN_HEALTH: RunnerHealth = {
  status: 'unknown',
  moxxyVersion: null,
  moxxyCompatible: false,
  liveRuns: 0,
  maxRuns: 0,
  lastSeenAt: null,
  detail: null,
  providers: null,
};

/**
 * Owns one RunnerBackend per registered runner, polls their health, and makes
 * placement decisions. The local runner's backend is the same GatewayPool that
 * used to live in the orchestrator; remote backends are (re)built whenever a
 * runner's endpoint/token changes. All backends feed one shared event sink so
 * the orchestrator can't tell local from remote.
 */
export class Runners {
  private readonly backends = new Map<string, RunnerBackend>();
  private readonly health = new Map<string, RunnerHealth>();
  private readonly local: LocalRunnerBackend;
  private healthTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly cleanupInFlight = new Set<string>();

  constructor(
    private readonly store: OperateStore,
    checkouts: Checkouts,
    moxxyCli: MoxxyCli | null,
    maxLiveRuns: number,
    private readonly sink: RunnerEventSink,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    /** Hub GitHub credential remote agents receive with network git calls. */
    private readonly githubTokenFor: GitCredentialResolver = () => null,
    private readonly storagePolicy: () => Omit<AgentStorageCleanupRequest, 'runs'> = () => ({
      worktreeRetentionMs: 3 * 24 * 60 * 60_000,
      scratchRetentionMs: 24 * 60 * 60_000,
      sessionRetentionMs: 30 * 24 * 60 * 60_000,
    }),
  ) {
    this.local = new LocalRunnerBackend(
      LOCAL_RUNNER_ID,
      checkouts,
      moxxyCli?.path ?? 'moxxy',
      moxxyCli?.version ?? null,
      moxxyCli?.compatible ?? false,
      maxLiveRuns,
      sink,
    );
    this.backends.set(LOCAL_RUNNER_ID, this.local);
    this.rebuildRemotes();
  }

  /** The always-present local backend (used for shutdown-all). */
  get localBackend(): LocalRunnerBackend {
    return this.local;
  }

  start(): void {
    void this.pollHealth().then(() => this.enforceStorageCleanup());
    this.healthTimer = setInterval(() => void this.pollHealth(), HEALTH_POLL_MS);
    this.healthTimer.unref();
    this.cleanupTimer = setInterval(() => void this.enforceStorageCleanup(), STORAGE_CLEANUP_MS);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const backend of this.backends.values()) {
      if (backend instanceof RemoteRunnerBackend) backend.dispose();
    }
  }

  /** (Re)create remote backends to match the stored runner rows. */
  private rebuildRemotes(): void {
    const rows = this.store.runners.list().filter((r) => r.kind === 'remote');
    const wanted = new Set(rows.map((r) => r.id));
    // Drop backends whose runner vanished.
    for (const [id, backend] of this.backends) {
      if (id !== LOCAL_RUNNER_ID && !wanted.has(id)) {
        (backend as RemoteRunnerBackend).dispose();
        this.backends.delete(id);
        this.health.delete(id);
      }
    }
    for (const row of rows) {
      if (!row.endpoint || !row.token) continue;
      // Rebuild fresh so endpoint/token edits take effect.
      const existing = this.backends.get(row.id);
      if (existing) (existing as RemoteRunnerBackend).dispose();
      this.backends.set(
        row.id,
        new RemoteRunnerBackend(row.id, row.endpoint, row.token, this.sink, this.githubTokenFor, (up) => {
          // Event-stream state is the fastest liveness signal: a drop (or a
          // reconnect) triggers an immediate probe instead of waiting out the
          // poll interval. Once health already says offline, the retry loop's
          // repeated drops stop re-probing.
          if (up || this.health.get(row.id)?.status !== 'offline') void this.probeOne(row.id);
        }),
      );
    }
  }

  /** Backend for a specific runner id (falls back to local for null/unknown). */
  backend(runnerId: string | null): RunnerBackend {
    if (!runnerId) return this.local;
    return this.backends.get(runnerId) ?? this.local;
  }

  /** Backend a run executes on. */
  backendForRun(runnerId: string | null): RunnerBackend {
    return this.backend(runnerId);
  }

  // ---------- placement ----------

  /**
   * Choose a runner for a new run. Preference order: the repo's pinned runner
   * (if eligible + healthy), then the least-loaded online eligible runner,
   * then local as the always-available fallback. Returns the runner id (null
   * means the local runner).
   *
   * Provider capability: runners that advertise ZERO providers can't serve
   * any model and are never chosen (unknown = null stays optimistic). When
   * `wantedProviders` names the providers that can serve the run's model,
   * runners advertising one of them are preferred; if none does, placement
   * falls back to the capability-agnostic choice and the model is reconciled
   * per turn instead (see Orchestrator.sendPrompt).
   *
   * Ownership: `userId` is the triggering user. Their personal runners become
   * eligible AND preferred (their machine, their subscription); other users'
   * runners never are. Automation passes null and rides shared runners only.
   *
   * Task eligibility: a runner never receives a task on its block-list — a
   * hard filter that outranks even the repo pin. When no runner at all
   * accepts `task`, the local runner takes it anyway (the work must land
   * somewhere; same spirit as the everything-offline fallback below). An
   * unlabeled run (`task` null) matches every runner.
   */
  place(
    repo: string | null,
    task: string | null,
    wantedProviders?: readonly string[] | null,
    userId: string | null = null,
    /** Runner row ids to skip — failover after a spawn just failed there. */
    exclude?: ReadonlySet<string>,
  ): string | null {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const eligible = this.store.runners
      .eligibleFor(workspaceId, userId)
      .filter((r) => this.allows(r, task))
      .filter((r) => !exclude?.has(r.id));
    const pinned = repo ? (this.store.repos.get(repo)?.runner_id ?? null) : null;

    const online = (row: RunnerRow): boolean => {
      const h = this.health.get(row.id);
      // Remote runners must complete a successful probe before placement. An
      // unprobed or degraded remote may speak an older agent protocol and
      // silently discard prompt fields it does not understand (such as image
      // attachments). The in-process local runner is safe to use immediately.
      if (!h || h.status === 'unknown') return row.id === LOCAL_RUNNER_ID;
      return h.status === 'online';
    };
    // A runner is usable only if it has a credential-ready provider (its
    // catalog says so). Unknown catalog (never probed) stays optimistic.
    const ready = (row: RunnerRow): boolean => this.hasReadyProvider(row);
    // Load counts runs already assigned to a runner (provisioning included), not
    // just spawned gateways — so a batch placed back-to-back spreads instead of
    // piling onto whichever runner currently shows zero live gateways.
    const active = this.store.runs.activeCountsByRunner();
    const load = (row: RunnerRow): number => {
      return this.activeRuns(row, active) / Math.max(1, row.max_runs);
    };

    if (pinned) {
      // An explicit repo pin wins, but not over a runner that can't run anything.
      const pin = eligible.find((r) => r.id === pinned);
      if (pin && online(pin) && ready(pin) && load(pin) < 1) return this.normalize(pin.id);
    }
    // The user's own machines come first (that's what they connected them
    // for), then shared runners; within each tier least-loaded first. An own
    // runner at capacity drops to the shared tier — preferring it would pick a
    // full machine over an idle shared one and fail the spawn outright.
    const own = (row: RunnerRow): number =>
      userId !== null && row.owner_id === userId && load(row) < 1 ? 0 : 1;
    const usable = eligible
      .filter(online)
      .filter(ready)
      .filter((row) => load(row) < 1)
      .sort((a, b) => own(a) - own(b) || load(a) - load(b));
    const served = (row: RunnerRow): boolean => {
      if (!wantedProviders || wantedProviders.length === 0) return true;
      const cat = row.catalog;
      if (!cat) return true;
      return cat.providers.some((p) => p.ready && wantedProviders.includes(p.name));
    };
    const chosen = usable.find(served) ?? usable[0];
    return this.normalize(chosen?.id ?? LOCAL_RUNNER_ID);
  }

  /**
   * Combined concurrent-run capacity across every enabled, online runner the
   * caller can place on — the ceiling the orchestrator schedules against.
   * Personally-owned runners only count toward their owner's capacity
   * (`userId`); the shared pool (automation, the queue pump) excludes them.
   * The local runner always counts, so this is at least its cap. With `task`,
   * only runners whose block-list accepts it count (chat-slot gating).
   */
  totalCapacity(userId: string | null = null, task: string | null = null): number {
    let sum = 0;
    for (const row of this.store.runners.list()) {
      if (row.owner_id !== null && row.owner_id !== userId) continue;
      if (!this.allows(row, task)) continue;
      if (row.enabled === 1 && this.isOnline(row)) sum += Math.max(0, row.max_runs);
    }
    return sum;
  }

  /** Occupancy of the pool this user can schedule against: shared + their own. */
  capacitySnapshot(userId: string | null = null): { active: number; capacity: number } {
    const counts = this.store.runs.activeCountsByRunner();
    let active = 0;
    let capacity = 0;
    for (const row of this.store.runners.list()) {
      if (row.owner_id !== null && row.owner_id !== userId) continue;
      if (row.enabled !== 1 || !this.isOnline(row)) continue;
      capacity += Math.max(0, row.max_runs);
      active += this.activeRuns(row, counts);
    }
    return { active, capacity: Math.max(1, capacity) };
  }

  /** Whether an eligible, healthy runner can accept this task right now. */
  hasFreeCapacity(repo: string | null, task: string | null, userId: string | null = null): boolean {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const counts = this.store.runs.activeCountsByRunner();
    const eligible = this.store.runners
      .eligibleFor(workspaceId, userId)
      .filter((row) => this.allows(row, task))
      .filter((row) => this.isOnline(row) && this.hasReadyProvider(row));
    // Task filters never make work impossible: the local runner remains the
    // last resort when every machine blocks this task, matching place().
    const candidates =
      eligible.length > 0 ? eligible : this.store.runners.list().filter((row) => row.id === LOCAL_RUNNER_ID);
    return candidates.some(
      (row) => this.activeRuns(row, counts) < Math.max(1, row.max_runs),
    );
  }

  /** Reconcile persisted assignments with backend/reported liveness. */
  private activeRuns(row: RunnerRow, counts: ReadonlyMap<string | null, number>): number {
    const assigned = counts.get(row.id === LOCAL_RUNNER_ID ? null : row.id) ?? 0;
    const tracked = this.backend(row.id).liveIds().length;
    const reported = this.health.get(row.id)?.liveRuns ?? 0;
    return Math.max(assigned, tracked, reported);
  }

  private isOnline(row: RunnerRow): boolean {
    const health = this.health.get(row.id);
    // Remote capacity is counted only after a successful, protocol-compatible
    // probe. The in-process local runner remains available during startup.
    if (!health || health.status === 'unknown') return row.id === LOCAL_RUNNER_ID;
    return health.status === 'online';
  }

  /** True when the task isn't on the runner's block-list (null task = always). */
  private allows(row: RunnerRow, task: string | null): boolean {
    return task === null || !row.blocked_tasks.includes(task);
  }

  /** Advertised providers of a runner (null = unknown); null id = local. */
  providersFor(runnerId: string | null): readonly string[] | null {
    return this.health.get(runnerId ?? LOCAL_RUNNER_ID)?.providers ?? null;
  }

  /** Store null for the local runner so existing rows/queries stay simple. */
  private normalize(id: string): string | null {
    return id === LOCAL_RUNNER_ID ? null : id;
  }

  // ---------- health ----------

  private async pollHealth(): Promise<void> {
    // Parallel: one hanging machine must not delay every other runner's health.
    await Promise.all(
      [...this.backends.keys()].map((id) =>
        this.probeOne(id).catch((err) => log.warn('runner health probe failed', { runner: id, err: String(err) })),
      ),
    );
  }

  healthFor(id: string): RunnerHealth {
    return this.health.get(id) ?? UNKNOWN_HEALTH;
  }

  /** Companion owns retention; runners only execute it inside their managed
   * roots. Every registered compatible machine receives the same policy and
   * the run leases that protect active/review work. */
  private async enforceStorageCleanup(): Promise<void> {
    await Promise.all([...this.backends.keys()].map((id) => this.cleanupOne(id)));
  }

  private async cleanupOne(id: string): Promise<void> {
    if (this.cleanupInFlight.has(id)) return;
    const health = this.health.get(id);
    if (id !== LOCAL_RUNNER_ID && (!health || health.status === 'offline' || health.status === 'unknown' || health.agentOutdated)) {
      return;
    }
    this.cleanupInFlight.add(id);
    try {
      const policy = this.storagePolicy();
      const since = Date.now() - Math.max(policy.worktreeRetentionMs, policy.scratchRetentionMs, policy.sessionRetentionMs);
      const runs = this.store.runs.storageLeasesForRunner(id === LOCAL_RUNNER_ID ? null : id, since);
      const result = await this.backends.get(id)!.cleanupStorage({ ...policy, runs });
      const removed =
        result.removedWorktrees + result.removedScratchDirs + result.removedSessionFiles + result.removedRunConfigs;
      if (removed > 0) {
        log.info('runner storage cleanup completed', {
          runner: id,
          worktrees: result.removedWorktrees,
          scratch: result.removedScratchDirs,
          sessions: result.removedSessionFiles,
          configs: result.removedRunConfigs,
        });
      }
      if (result.errors.length > 0) log.warn('runner storage cleanup had errors', { runner: id, errors: result.errors });
    } catch (err) {
      log.warn('runner storage cleanup failed', { runner: id, err: String(err) });
    } finally {
      this.cleanupInFlight.delete(id);
    }
  }

  // ---------- CRUD (drives store + backend rebuild) ----------

  list(): RunnerRecord[] {
    return this.store.runners.list().map((r) => this.toRecord(r));
  }

  get(id: string): RunnerRecord | undefined {
    const row = this.store.runners.get(id);
    return row ? this.toRecord(row) : undefined;
  }

  async create(req: CreateRunnerRequest, ownerId: string | null): Promise<RunnerRecord> {
    const id = `runner-${randomUUID().slice(0, 12)}`;
    this.store.runners.insert({
      id,
      name: req.name,
      kind: 'remote',
      endpoint: req.endpoint.replace(/\/+$/, ''),
      token: req.token,
      scope: req.scope ?? 'shared',
      ownerId,
      maxRuns: req.maxRuns ?? 3,
      workspaceIds: req.workspaceIds ?? [],
      modelPins: req.modelPins,
      blockedTasks: req.blockedTasks,
    });
    this.rebuildRemotes();
    await this.probeOne(id);
    await this.probeCatalog(id);
    this.broadcast({ t: 'runners.changed' });
    return this.get(id)!;
  }

  async update(id: string, req: UpdateRunnerRequest): Promise<RunnerRecord> {
    const row = this.store.runners.get(id);
    if (!row) throw new Error('runner not found');
    if (row.kind === 'local') {
      // Capacity, scope, and per-action model pins apply to the local runner too.
      this.store.runners.update(id, {
        name: req.name,
        maxRuns: req.maxRuns,
        scope: req.scope,
        workspaceIds: req.workspaceIds,
        enabled: req.enabled,
        modelPins: req.modelPins,
        blockedTasks: req.blockedTasks,
      });
    } else {
      this.store.runners.update(id, {
        name: req.name,
        endpoint: req.endpoint === undefined ? undefined : req.endpoint.replace(/\/+$/, ''),
        token: req.token,
        scope: req.scope,
        workspaceIds: req.workspaceIds,
        maxRuns: req.maxRuns,
        enabled: req.enabled,
        modelPins: req.modelPins,
        blockedTasks: req.blockedTasks,
      });
      this.rebuildRemotes();
      await this.probeOne(id);
    }
    this.broadcast({ t: 'runners.changed' });
    return this.get(id)!;
  }

  delete(id: string): void {
    this.store.runners.delete(id);
    const backend = this.backends.get(id);
    if (backend instanceof RemoteRunnerBackend) backend.dispose();
    this.backends.delete(id);
    this.health.delete(id);
    // Repos pinned to this runner fall back to auto-placement.
    for (const repo of this.store.repos.list()) {
      if (repo.runner_id === id) this.store.repos.setRunner(repo.full_name, null);
    }
    this.broadcast({ t: 'runners.changed' });
  }

  /**
   * Update the moxxy CLI on a REMOTE runner's machine (the local runner goes
   * through OperateService.setMoxxyCli — see the route). A pre-update agent
   * 404s the endpoint; surface that as actionable manual guidance.
   */
  async updateMoxxy(id: string): Promise<RunnerMoxxyUpdateResult> {
    const backend = this.backends.get(id);
    if (!(backend instanceof RemoteRunnerBackend)) throw new Error('runner not found');
    let result;
    try {
      result = await backend.updateMoxxy();
    } catch (err) {
      // A pre-update agent 404s with its own error envelope ("no route: …").
      const msg = String(err instanceof Error ? err.message : err);
      throw /no route|agent 404/.test(msg)
        ? new Error(
            'this runner agent predates remote updates — update it on the machine once (npm i -g @moxxy/companion-runner, then restart it); future updates work from here',
          )
        : err;
    }
    await this.probeOne(id);
    this.broadcast({ t: 'runners.changed' });
    return result;
  }

  /** The "Test connection" action — probe health + fetch the runner's catalog. */
  async probeNow(id: string): Promise<RunnerProbeResult> {
    const health = await this.probeOne(id);
    const ok = health.status === 'online' || health.status === 'degraded';
    // Only bother fetching the (heavier) catalog when the runner is reachable.
    const catalog = ok ? await this.probeCatalog(id) : (this.store.runners.get(id)?.catalog ?? null);
    this.broadcast({ t: 'runners.changed' });
    return { ok, health, catalog };
  }

  /** Resolve the model a run of `kind` should use on `runnerId`: its pin, else its default. */
  modelPinFor(runnerId: string | null, kind: RunnerPinnableKind): string | null {
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    return row?.model_pins[kind] ?? row?.catalog?.defaultModel ?? null;
  }

  /** True when the runner has at least one credential-ready provider. */
  private hasReadyProvider(row: RunnerRow): boolean {
    const cat = row.catalog;
    // Unknown catalog stays optimistic (never probed yet); an empty/all-unready
    // catalog means the runner can't actually serve anything.
    if (!cat) return true;
    return cat.providers.some((p) => p.ready);
  }

  private async probeOne(id: string): Promise<RunnerHealth> {
    const backend = this.backends.get(id);
    if (!backend) return UNKNOWN_HEALTH;
    const prev = this.health.get(id);
    const health = await backend.probe();
    this.health.set(id, health);
    if (JSON.stringify(prev) !== JSON.stringify(health)) this.broadcast({ t: 'runners.changed' });
    // Transition into offline strands the runs placed there — tell the sink so
    // they're marked interrupted (and their owners can redispatch) instead of
    // sitting "live" forever on a machine that's gone.
    if (prev?.status !== 'offline' && health.status === 'offline' && id !== LOCAL_RUNNER_ID) {
      this.sink.onRunnerUnreachable(id, health.detail ?? 'runner unreachable');
    }
    const newlyReachable =
      id !== LOCAL_RUNNER_ID &&
      (prev === undefined || prev.status === 'offline' || prev.status === 'unknown') &&
      health.status !== 'offline' &&
      health.status !== 'unknown' &&
      !health.agentOutdated;
    if (newlyReachable) {
      void this.cleanupOne(id);
    }
    return health;
  }

  /** Nudge health after an external failure signal (e.g. a spawn that died). */
  recheckHealth(id: string | null): void {
    void this.probeOne(id ?? LOCAL_RUNNER_ID).catch(() => undefined);
  }

  private toRecord(row: RunnerRow): RunnerRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      endpoint: row.endpoint,
      hasToken: Boolean(row.token),
      ownerId: row.owner_id,
      scope: row.scope,
      workspaceIds: row.workspace_ids,
      maxRuns: row.max_runs,
      enabled: row.enabled === 1,
      blockedTasks: row.blocked_tasks,
      health: this.healthFor(row.id),
      catalog: row.catalog,
      modelPins: row.model_pins,
      createdAt: row.created_at,
    };
  }

  /**
   * Fetch a runner's own provider/model catalog by spawning a throwaway gateway
   * on that runner and reading moxxy's session info. Heavier than a health
   * probe, so it only runs on explicit "Test connection" / add / edit — not the
   * periodic poll. Cached on the runner row for the pin UI and routing.
   */
  async probeCatalog(id: string): Promise<RunnerCatalog | null> {
    const backend = this.backends.get(id);
    if (!backend) return null;
    const probeId = `catalog-probe-${randomUUID().slice(0, 8)}`;
    try {
      const cwd = await backend.scratchDir(probeId);
      await backend.spawn(probeId, cwd);
      const info = (await backend.sessionInfo(probeId)) as {
        activeProvider?: unknown;
        providers?: unknown;
        readyProviders?: unknown;
      } | null;
      const catalog = parseCatalog(info);
      this.store.runners.setCatalog(id, catalog);
      return catalog;
    } catch (err) {
      log.warn('runner catalog probe failed', { runner: id, err: String(err) });
      return this.store.runners.get(id)?.catalog ?? null;
    } finally {
      await backend.stop(probeId).catch(() => undefined);
    }
  }
}

/** Parse moxxy session info into a per-runner catalog (providers + real readiness). */
function parseCatalog(
  info: { activeProvider?: unknown; providers?: unknown; readyProviders?: unknown } | null,
): RunnerCatalog {
  const ready = new Set(
    Array.isArray(info?.readyProviders) ? info!.readyProviders.filter((p): p is string => typeof p === 'string') : [],
  );
  const providers: ModelCatalogProvider[] = (Array.isArray(info?.providers) ? info!.providers : [])
    .map((raw): ModelCatalogProvider | null => {
      const p = raw as { name?: unknown; models?: unknown; enabled?: unknown };
      if (typeof p.name !== 'string') return null;
      const models: ModelCatalogModel[] = (Array.isArray(p.models) ? p.models : [])
        .map((m): ModelCatalogModel | null => {
          if (typeof m === 'string') return { id: m, contextWindow: null };
          const o = m as { id?: unknown; contextWindow?: unknown };
          return typeof o.id === 'string'
            ? { id: o.id, contextWindow: typeof o.contextWindow === 'number' ? o.contextWindow : null }
            : null;
        })
        .filter((m): m is ModelCatalogModel => m !== null);
      return { name: p.name, enabled: p.enabled !== false, ready: ready.has(p.name), models };
    })
    .filter((p): p is ModelCatalogProvider => p !== null);
  const active = typeof info?.activeProvider === 'string' ? info.activeProvider : null;
  const defaultModel = providers.find((p) => p.name === active)?.models[0]?.id ?? null;
  return { providers, defaultModel, fetchedAt: Date.now() };
}
