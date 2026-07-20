import { randomUUID } from 'node:crypto';
import type { SpaServerMessage } from '@companion/contracts';
import type {
  CreateRunnerRequest,
  ModelCatalogModel,
  ModelCatalogProvider,
  RunnerCatalog,
  RunnerHealth,
  RunnerPinnableKind,
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

  constructor(
    private readonly store: OperateStore,
    checkouts: Checkouts,
    moxxyCli: MoxxyCli | null,
    maxLiveRuns: number,
    private readonly sink: RunnerEventSink,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    /** Hub GitHub credential remote agents receive with network git calls. */
    private readonly githubTokenFor: (repo: string) => Promise<string | null> | string | null = () => null,
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
    void this.pollHealth();
    this.healthTimer = setInterval(() => void this.pollHealth(), HEALTH_POLL_MS);
    this.healthTimer.unref();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
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
        new RemoteRunnerBackend(row.id, row.endpoint, row.token, this.sink, this.githubTokenFor),
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
   */
  place(repo: string | null, wantedProviders?: readonly string[] | null): string | null {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const eligible = this.store.runners.eligibleFor(workspaceId);
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
      const assigned = active.get(row.id === LOCAL_RUNNER_ID ? null : row.id) ?? 0;
      const live = this.backend(row.id).liveIds().length;
      return Math.max(assigned, live) / Math.max(1, row.max_runs);
    };

    if (pinned) {
      // An explicit repo pin wins, but not over a runner that can't run anything.
      const pin = eligible.find((r) => r.id === pinned);
      if (pin && online(pin) && ready(pin)) return this.normalize(pin.id);
    }
    // Prefer runners whose model pins cover this action's model preference when
    // given; otherwise any ready runner, least-loaded first.
    const usable = eligible.filter(online).filter(ready).sort((a, b) => load(a) - load(b));
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
   * Combined concurrent-run capacity across every enabled, online runner
   * (shared + dedicated) — the ceiling the orchestrator schedules unattended
   * runs against. The local runner always counts, so this is at least its cap.
   */
  totalCapacity(): number {
    const online = (row: RunnerRow): boolean => {
      const h = this.health.get(row.id);
      // Remote capacity is counted only after a successful, protocol-compatible
      // probe. The in-process local runner remains available during startup.
      if (!h || h.status === 'unknown') return row.id === LOCAL_RUNNER_ID;
      return h.status === 'online';
    };
    let sum = 0;
    for (const row of this.store.runners.list()) {
      if (row.enabled === 1 && online(row)) sum += Math.max(0, row.max_runs);
    }
    return sum;
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
    let changed = false;
    for (const [id, backend] of this.backends) {
      try {
        const h = await backend.probe();
        if (JSON.stringify(this.health.get(id)) !== JSON.stringify(h)) changed = true;
        this.health.set(id, h);
      } catch (err) {
        log.warn('runner health probe failed', { runner: id, err: String(err) });
      }
    }
    if (changed) this.broadcast({ t: 'runners.changed' });
  }

  healthFor(id: string): RunnerHealth {
    return this.health.get(id) ?? UNKNOWN_HEALTH;
  }

  // ---------- CRUD (drives store + backend rebuild) ----------

  list(): RunnerRecord[] {
    return this.store.runners.list().map((r) => this.toRecord(r));
  }

  get(id: string): RunnerRecord | undefined {
    const row = this.store.runners.get(id);
    return row ? this.toRecord(row) : undefined;
  }

  async create(req: CreateRunnerRequest): Promise<RunnerRecord> {
    const id = `runner-${randomUUID().slice(0, 12)}`;
    this.store.runners.insert({
      id,
      name: req.name,
      kind: 'remote',
      endpoint: req.endpoint.replace(/\/+$/, ''),
      token: req.token,
      scope: req.scope ?? 'shared',
      maxRuns: req.maxRuns ?? 3,
      workspaceIds: req.workspaceIds ?? [],
      modelPins: req.modelPins,
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
    const health = await backend.probe();
    this.health.set(id, health);
    return health;
  }

  private toRecord(row: RunnerRow): RunnerRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      endpoint: row.endpoint,
      hasToken: Boolean(row.token),
      scope: row.scope,
      workspaceIds: row.workspace_ids,
      maxRuns: row.max_runs,
      enabled: row.enabled === 1,
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
