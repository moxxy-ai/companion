import type { Authenticator, SpaServerMessage } from '@moxxy/companion-contracts';
import {
  Entitlements,
  describeLicense,
  type DaemonConfig,
  type Database,
  type Logger,
  type Statement,
} from '@moxxy/companion-services';
import type { ModuleId, ModuleManifest } from '../manifest.js';
import type { ModuleConfigState } from '../module-config.js';
import { DynamicRouter } from './router.js';
import { RawRouter } from './raw-router.js';
import { MetricsRegistry } from './metrics.js';
import { ServiceRegistry } from './service-registry.js';
import { ServerBus } from './bus.js';
import { MigrationRunner } from './migration-runner.js';
import { ModuleConfigStore, validatePatch } from './module-config-store.js';
import { RbacGrid, type AclSource } from './rbac-grid.js';
import type { AuditEvent, AuditSink, NotificationEmitter, SettingsRegistry } from './capabilities.js';
import type { ModuleContext, ModuleListing, ServerModule } from './context.js';
import type { WsScopeRegistry } from './ws-hub.js';
import { HttpError } from './router.js';

/** A compiled-in module: its cheap static manifest + a lazy loader for the heavy /api barrel. */
export interface InstalledModule {
  /** Set by external discovery: the directory this module was loaded from.
   *  Absent = compiled into the build, so its files are not the daemon's to delete. */
  readonly dir?: string;
  /** Set by external discovery: the module ships a prebuilt browser chunk. */
  readonly externalClient?: boolean;
  readonly manifest: ModuleManifest;
  load(): Promise<ServerModule>;
}

export interface KernelOptions {
  /** Product version from the published Companion package manifest. */
  readonly appVersion: string;
  readonly db: Database;
  readonly log: Logger;
  readonly config: DaemonConfig;
  /** 32-byte key loaded outside SQLite; never exposed through ModuleContext. */
  readonly secretEncryptionKey: Buffer;
  readonly modules: readonly InstalledModule[];
  /** Browser push, backed by the app's WebSocket hub. */
  readonly broadcast: (msg: SpaServerMessage) => void;
  readonly pushToUser: (username: string, msg: SpaServerMessage) => void;
  /** The hub's scope-resolver registry (per-message visibility). */
  readonly ws: WsScopeRegistry;
}

interface ModuleRow {
  id: string;
  installed: number;
  enabled: number;
  version: number;
  required: number;
}

/**
 * The runtime host. Replaces the hand-wired `main()` composition root: reconcile
 * the installed set into the `modules` table, topo-sort by `dependsOn`, then for
 * each enabled module load → migrate → register services → mount routes →
 * onEnable, and finally a single post-activation pass (resumers). Toggling is a
 * live operation (routes mount/unmount, the RBAC grid recomputes).
 */
/**
 * Key prefix reserving a `module_config` row as a run-time secret. Anything
 * under it redacts like a declared `kind: 'secret'` field, which is what lets a
 * module store a value whose key no manifest could have listed.
 */
export const RUNTIME_SECRET_PREFIX = 'secret:';

export class ModuleKernel {
  private readonly db: Database;
  private readonly log: Logger;
  private readonly installed = new Map<ModuleId, InstalledModule>();
  private readonly loaded = new Map<ModuleId, ServerModule>();
  private readonly jobTimers = new Map<ModuleId, NodeJS.Timeout[]>();
  /** Modules with an enable/disable/uninstall transition in flight (reentrancy guard). */
  private readonly inFlight = new Set<ModuleId>();

  readonly services = new ServiceRegistry();
  readonly bus = new ServerBus();
  /** Prometheus registry served at /metrics when the operator enables it. */
  readonly metrics = new MetricsRegistry();
  readonly migrations: MigrationRunner;
  readonly rbac = new RbacGrid();
  /** Offline licence state, re-read at most once a day; never on a request path. */
  readonly entitlements = new Entitlements();
  readonly router: DynamicRouter;
  /** Byte-body, self-authenticating routes (webhooks) — the app shell dispatches these. */
  readonly rawRouter: RawRouter;

  private authenticator: Authenticator | null = null;
  /** Set by whichever enabled module provides it; absent = auditing is a no-op. */
  private auditSink: AuditSink | null = null;
  /** True once boot() finished; /readyz gates on it. */
  private booted = false;
  /** DB-enabled modules whose activation threw; boot keeps serving without them. */
  private readonly activationFailed = new Set<ModuleId>();
  /** The shared base — `moduleConfig` is the one per-module member, added by moduleCtx(). */
  /** Both omitted fields are per-module, so they are added in `moduleCtx`. */
  private readonly ctx: Omit<ModuleContext, 'moduleConfig' | 'secrets'>;
  /** Kernel-owned config storage — direct on the DB (never via the service registry). */
  private readonly moduleConfig: ModuleConfigStore;
  /** `kind: 'secret'` keys per module, from the manifests: known before any load. */
  private readonly secretFields: Map<string, Set<string>>;
  /** Set once a module takes over secret storage; its own secrets stay behind. */
  private secretProvider: ModuleId | null = null;
  private readonly perModuleCtx = new Map<ModuleId, ModuleContext>();

  constructor(private readonly opts: KernelOptions) {
    this.db = opts.db;
    this.log = opts.log;
    for (const m of opts.modules) this.installed.set(m.manifest.id, m);
    this.migrations = new MigrationRunner(this.db, this.log);
    const secretFields = new Map<string, Set<string>>();
    for (const m of opts.modules) {
      const keys = (m.manifest.config ?? []).filter((f) => f.kind === 'secret').map((f) => f.key);
      if (keys.length) secretFields.set(m.manifest.id, new Set(keys));
    }
    this.secretFields = secretFields;
    this.moduleConfig = new ModuleConfigStore(
      this.db,
      opts.secretEncryptionKey,
      (id, key) => this.isSecretField(id, key),
    );
    this.moduleConfig.migrateSecrets([...this.installed.keys()]);

    // `settings` is provided by module-core, `notifications` by module-workspace —
    // both required, so these resolve for the whole normal lifetime. If a target
    // is somehow absent (a boot-order bug), fail LOUDLY rather than silently drop.
    const notify: NotificationEmitter = {
      emit: (n) => {
        const svc = this.services.raw('notifications') as NotificationEmitter | undefined;
        if (!svc) return void this.log.error('ctx.notify.emit before the notifications service registered', { n });
        svc.emit(n);
      },
    };
    const settingsSvc = (): SettingsRegistry | undefined => {
      const svc = this.services.raw('settings') as SettingsRegistry | undefined;
      if (!svc) this.log.error('ctx.settings used before the settings service registered');
      return svc;
    };
    const settings: SettingsRegistry = {
      get: (k) => settingsSvc()?.get(k) ?? null,
      set: (k, v) => settingsSvc()?.set(k, v),
      delete: (k) => settingsSvc()?.delete(k),
    };
    this.ctx = {
      appVersion: opts.appVersion,
      db: this.db,
      log: this.log,
      config: opts.config,
      fts: this.migrations.fts,
      services: this.services,
      bus: this.bus,
      metrics: this.metrics,
      broadcast: opts.broadcast,
      pushToUser: opts.pushToUser,
      notify,
      audit: { record: (e) => this.recordAudit(e) },
      settings,
      rbac: this.rbac,
      setRoles: (o) => this.rbac.setOverrides(o),
      ws: opts.ws,
      modules: {
        list: () => this.moduleList(),
        install: (id, config) => this.install(id, config),
        enable: (id) => this.enable(id),
        disable: (id) => this.disable(id),
        uninstall: (id) => this.uninstall(id),
        forget: (id) => this.forget(id),
        getConfig: (id) => this.getConfig(id),
        setConfig: (id, patch) => this.setConfig(id, patch),
      },
      isEnabled: (id) => this.isEnabled(id),
    };
    this.rawRouter = new RawRouter(this.log, (e) => this.recordAudit(e), {
      trustedProxies: opts.config.trustedProxies,
    });
    const httpRequests = this.metrics.counter(
      'companion_http_requests_total',
      'HTTP requests answered by the API router, by route pattern and status class',
    );
    // The router needs an authenticator, wired once module-core provides it (boot()).
    this.router = new DynamicRouter(
      {
        verify: (token) => this.requireAuth().verify(token),
        require: (user, permission) => this.requireAuth().require(user, permission),
      },
      this.log,
      (e) => this.recordAudit(e),
      {
        trustedProxies: opts.config.trustedProxies,
        ...(opts.config.rateLimitPerMinute === undefined
          ? {}
          : { rateLimitPerMinute: opts.config.rateLimitPerMinute }),
        observe: (routePattern, method, status) =>
          httpRequests.inc({ route: `${method} ${routePattern}`, status: `${Math.floor(status / 100)}xx` }),
      },
    );
  }

  /**
   * A `kind: 'secret'` field routes to the SecretStore instead of the config
   * table. A provider's own credentials remain in the encrypted local store
   * through RetainedSecretStore, because it cannot keep the key needed to reach
   * itself inside that backend.
   */
  private isSecretField(id: string, key: string): boolean {
    // Run-time keys a module invented (ctx.secrets) rather than declared. The
    // prefix is what makes them redact like a declared secret without any
    // manifest ever having mentioned them.
    if (key.startsWith(RUNTIME_SECRET_PREFIX)) return true;
    return this.secretFields.get(id)?.has(key) === true;
  }

  /** Hand secret storage to `id` if it provides one, carrying stored values across. */
  private adoptSecretStore(id: ModuleId, mod: ServerModule): void {
    if (!mod.provideSecrets) return;
    if (this.secretProvider && this.secretProvider !== id) {
      throw new Error(`secret storage is already provided by '${this.secretProvider}'`);
    }
    const next = mod.provideSecrets(this.moduleCtx(id));
    // Set first: the move below must leave the provider's own credentials behind.
    this.secretProvider = id;
    this.moduleConfig.useSecretStore(next, [...this.installed.keys()], id, (n) =>
      this.log.warn(`moved ${n} secret(s) into the store provided by '${id}'`),
    );
    this.log.info(`secret storage provided by '${id}'`);
  }

  /**
   * Never let a failing audit sink break the request it is recording. An audit
   * gap is a problem; a 500 on every write because the trail is unavailable is a
   * bigger one, so this logs loudly and continues.
   */
  private recordAudit(event: AuditEvent): void {
    if (!this.auditSink) return;
    try {
      this.auditSink.record(event);
    } catch (err) {
      this.log.error('audit sink failed', err);
    }
  }

  private requireAuth(): Authenticator {
    if (!this.authenticator) throw new HttpError(503, 'kernel not ready');
    return this.authenticator;
  }

  /** Token → user for the WS hub's upgrade path; null before boot completes. */
  verifyToken(token: string | null): ReturnType<Authenticator['verify']> {
    return this.authenticator?.verify(token) ?? null;
  }

  isEnabled(id: ModuleId): boolean {
    const row = this.row(id);
    return !!row && row.enabled === 1;
  }

  private rowStmt?: Statement;
  private row(id: ModuleId): ModuleRow | undefined {
    this.rowStmt ??= this.db.prepare(`SELECT * FROM modules WHERE id = ?`);
    return this.rowStmt.get(id) as ModuleRow | undefined;
  }

  /**
   * The full ModuleContext one module's factories/lifecycle receive: the shared
   * base plus that module's own config accessor. Memoized — every spread field is
   * a stable reference, and the accessor reads the DB live on each call.
   */
  private moduleCtx(id: ModuleId): ModuleContext {
    let c = this.perModuleCtx.get(id);
    if (!c) {
      c = {
        ...this.ctx,
        moduleConfig: this.moduleConfig.accessorFor(id, this.configFields(id)),
        secrets: this.moduleConfig.secretsFor(id),
      };
      this.perModuleCtx.set(id, c);
    }
    return c;
  }

  private configFields(id: ModuleId) {
    return this.installed.get(id)?.manifest.config ?? [];
  }

  /** Every required config field has a stored value or a declared default. */
  private isConfigured(id: ModuleId, storedKeys?: ReadonlySet<string>): boolean {
    const keys = storedKeys ?? new Set(Object.keys(this.moduleConfig.valuesFor(id)));
    return this.configFields(id).every((f) => !f.required || f.default !== undefined || keys.has(f.key));
  }

  moduleList(): ModuleListing[] {
    // One scan into a map, not a prepared-per-row N+1 (this endpoint is hit at
    // bootstrap and again on every modules.changed by every client).
    const rows = new Map(
      (this.db.prepare(`SELECT * FROM modules`).all() as ModuleRow[]).map((r) => [r.id, r]),
    );
    const cfgKeys = this.moduleConfig.keysByModule([...this.installed.keys()]);
    return [...this.installed.values()].map((m) => {
      const id = m.manifest.id;
      const row = rows.get(id);
      return {
        id,
        title: m.manifest.title,
        version: m.manifest.version,
        dependsOn: m.manifest.dependsOn ?? [],
        required: !!m.manifest.required,
        installed: row ? row.installed === 1 : false,
        enabled: row ? row.enabled === 1 : false,
        configured: this.isConfigured(id, cfgKeys.get(id) ?? new Set()),
        permissions: m.manifest.permissions ?? [],
        config: m.manifest.config ?? [],
        external: m.dir !== undefined,
        externalClient: m.externalClient === true,
        entitlement: m.manifest.entitlement ?? null,
        entitled: !m.manifest.entitlement || this.entitlements.has(m.manifest.entitlement),
      };
    });
  }

  /** Reconcile the installed set into the `modules` table, then activate the enabled set. */
  async boot(): Promise<void> {
    const now = Date.now();
    for (const m of this.installed.values()) {
      // A newly compiled-in module auto-installs + enables by default; it lands as
      // "Available" (installed=0) instead when its manifest opts out or it has
      // required config with no default (it can't run unconfigured). Required
      // modules always install — an Available required module would brick topoSort.
      // ON CONFLICT preserves an existing row's installed/enabled (only `required`
      // may change across builds), so a disabled or uninstalled module never
      // resurrects and the policy only ever applies to genuinely new module ids.
      const blocking = (m.manifest.config ?? []).some((f) => f.required && f.default === undefined);
      const auto = m.manifest.required ? 1 : m.manifest.autoInstall === false || blocking ? 0 : 1;
      if (m.manifest.required && (m.manifest.autoInstall === false || blocking)) {
        this.log.warn(`required module '${m.manifest.id}' declares autoInstall:false or blocking config — ignored`);
      }
      this.db
        .prepare(
          `INSERT INTO modules (id, installed, enabled, version, required, installed_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET required = excluded.required, updated_at = excluded.updated_at`,
        )
        .run(m.manifest.id, auto, auto, m.manifest.required ? 1 : 0, now, now);
    }

    // Consistency pass: the enabled set must be dependsOn-closed or topoSort
    // would crash boot. The auto-install policy can break closure — e.g. a new
    // module lands "Available" (autoInstall:false / blocking config) while a
    // dependent auto-installed, or an existing enabled module gained a dep on
    // it across a build. Two ordered passes keep the result deterministic:
    // FORCE first (a required module's whole dependsOn closure comes on — it
    // can never be pruned), then PRUNE the rest to disabled, durably and
    // loudly; a pruned module can be re-enabled once its dependency installs.
    const enabledSet = new Set(this.enabledIds());
    const visited = new Set<ModuleId>();
    const forceClosure = (id: ModuleId): void => {
      if (visited.has(id)) return; // also guards a manifest cycle (topoSort reports it)
      visited.add(id);
      for (const dep of this.installed.get(id)?.manifest.dependsOn ?? []) {
        if (!this.installed.has(dep)) {
          throw new Error(`required module '${id}' depends on '${dep}', which is not in the registry`);
        }
        if (!enabledSet.has(dep)) {
          this.log.warn(`required module '${id}' forces dependency '${dep}' to install`);
          enabledSet.add(dep);
          this.markState(dep, { installed: true, enabled: true });
        }
        forceClosure(dep);
      }
    };
    for (const m of this.installed.values()) if (m.manifest.required) forceClosure(m.manifest.id);
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...enabledSet]) {
        for (const dep of this.installed.get(id)!.manifest.dependsOn ?? []) {
          if (enabledSet.has(dep)) continue;
          this.log.warn(`module '${id}' disabled: its dependency '${dep}' is not enabled`);
          enabledSet.delete(id);
          this.markState(id, { enabled: false });
          changed = true;
          break;
        }
      }
    }

    // An entitled module whose licence lapsed is DISABLED, loudly, not booted
    // into a broken state and not allowed to take the daemon down. Its data and
    // configuration survive, so renewing and re-enabling restores it exactly.
    for (const id of [...enabledSet]) {
      const feature = this.installed.get(id)?.manifest.entitlement;
      if (!feature || this.entitlements.has(feature)) continue;
      this.log.warn(`module '${id}' disabled: '${feature}' is not licensed (${describeLicense(this.entitlements.current())})`);
      enabledSet.delete(id);
      this.markState(id, { enabled: false });
    }

    const enabled = this.topoSort([...enabledSet]);
    // One optional module failing to activate must not take the daemon down: it
    // is recorded (readiness() reports it), its partial registrations are rolled
    // back, its later phases are skipped, and boot continues. A REQUIRED
    // module's failure stays fatal, because module-core provides the
    // authenticator nothing can serve without. A dependent of a failed module
    // fails in turn when it reaches for the missing service, and cascades into
    // the same handling.
    const guard = async (id: ModuleId, run: () => void | Promise<void>): Promise<void> => {
      if (this.activationFailed.has(id)) return;
      try {
        await run();
      } catch (err) {
        if (this.installed.get(id)?.manifest.required) throw err;
        this.log.error(`module '${id}' failed to activate`, err);
        this.activationFailed.add(id);
        this.services.setActiveModule(null);
        this.services.revokeModule(id);
        this.router.unmount(id);
        this.rawRouter.unmount(id);
      }
    };
    // Loads are independent (only the activation phases below are ordered), so
    // overlap the dynamic imports instead of paying their sum on cold start.
    await Promise.all(
      enabled.map((id) =>
        guard(id, async () => {
          this.loaded.set(id, await this.installed.get(id)!.load());
        }),
      ),
    );
    this.assertNoCollisions(enabled);

    // Grid must be live before any request is served, so Auth sees the perms.
    this.rebuildGrid(enabled);

    // Before ANY module reads its config: a late swap would hand the first
    // readers the old backend's answers. Last provider in enabled order wins.
    for (const id of enabled) await guard(id, () => this.adoptSecretStore(id, this.loaded.get(id)!));

    for (const id of enabled) {
      await guard(id, async () => {
        const mod = this.loaded.get(id)!;
        if (mod.migrations?.length) this.migrations.migrateUp(id, mod.migrations);
        this.services.setActiveModule(id);
        await mod.registerServices?.(this.moduleCtx(id));
        this.services.setActiveModule(null);
      });
    }

    // module-core (required, first) provides the authenticator the router uses.
    // Audit follows the same shape; enabled order means a dedicated audit module
    // (which sorts after core) takes over from core's minimal table.
    for (const id of enabled) {
      await guard(id, () => {
        const mod = this.loaded.get(id)!;
        if (mod.provideAuthenticator) this.authenticator = mod.provideAuthenticator(this.moduleCtx(id));
        if (mod.provideAudit) this.auditSink = mod.provideAudit(this.moduleCtx(id));
      });
    }
    if (!this.authenticator) throw new Error('no module provided an authenticator (module-core missing?)');

    for (const id of enabled) {
      await guard(id, () => {
        const mod = this.loaded.get(id)!;
        if (mod.routes) this.router.mount(id, mod.routes(this.moduleCtx(id)));
        if (mod.rawRoutes) this.rawRouter.mount(id, mod.rawRoutes(this.moduleCtx(id)));
      });
    }
    for (const id of enabled) await guard(id, () => this.loaded.get(id)!.lifecycle?.onEnable?.(this.moduleCtx(id)));
    // Single post-activation pass: resumers fire only after every module subscribed.
    for (const id of enabled) await guard(id, () => this.loaded.get(id)!.lifecycle?.postActivate?.(this.moduleCtx(id)));

    const active = enabled.filter((id) => !this.activationFailed.has(id));
    // The grid built above may still credit a module that failed later phases.
    if (this.activationFailed.size) this.rebuildGrid(active);
    for (const id of active) this.startJobs(id);
    this.booted = true;
    this.log.info(`kernel booted: ${active.length} module(s) enabled [${active.join(', ')}]`);
    if (this.activationFailed.size) {
      this.log.error(`kernel booted degraded: [${[...this.activationFailed].join(', ')}] failed to activate`);
    }
  }

  /**
   * Deployment gate for /readyz: ready only once boot finished and every
   * DB-enabled module actually activated. States are deliberately coarse
   * (enabled/available/failed) so the body leaks no configuration.
   */
  readiness(): { ready: boolean; modules: readonly { id: ModuleId; state: 'enabled' | 'available' | 'failed' }[] } {
    const enabledRows = new Set(
      (this.db.prepare(`SELECT id FROM modules WHERE enabled = 1`).all() as { id: string }[]).map((r) => r.id),
    );
    const modules = [...this.installed.keys()].map((id) => ({
      id,
      state: this.activationFailed.has(id)
        ? ('failed' as const)
        : enabledRows.has(id)
          ? ('enabled' as const)
          : ('available' as const),
    }));
    return { ready: this.booted && !modules.some((m) => m.state === 'failed'), modules };
  }

  // ---- lifecycle transitions ----

  /**
   * 409 unless the module's entitlement is licensed. Checked at install and
   * enable, not per request: a licence cannot change without someone touching
   * the filesystem, so a hot-path check would buy nothing.
   */
  private assertEntitled(id: ModuleId): void {
    const feature = this.installed.get(id)?.manifest.entitlement;
    if (!feature || this.entitlements.has(feature)) return;
    throw new HttpError(
      409,
      `module '${id}' requires the '${feature}' entitlement: ${describeLicense(this.entitlements.current())}`,
    );
  }

  /** 409 unless every required config field has a stored value or a default. */
  private assertConfigured(id: ModuleId): void {
    const stored = new Set(Object.keys(this.moduleConfig.valuesFor(id)));
    const missing = this.configFields(id)
      .filter((f) => f.required && f.default === undefined && !stored.has(f.key))
      .map((f) => f.key);
    if (missing.length) {
      throw new HttpError(409, `module '${id}' is missing required configuration: ${missing.join(', ')}`);
    }
  }

  /** The one path from "Available" to running: validate + persist config, then activate. */
  async install(id: ModuleId, config?: Readonly<Record<string, unknown>>): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    this.assertEntitled(id);
    if (config && Object.keys(config).length) this.setConfig(id, config);
    if (this.isEnabled(id)) return; // idempotent — config patch (if any) still applied
    this.assertConfigured(id);
    // Config rows persisted above survive a failed activation (kept for the retry;
    // uninstall wipes them) — but installed=1 is only written on the success path.
    await this.activate(id, { markInstalled: true });
  }

  async enable(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (this.isEnabled(id)) return;
    if (this.row(id)?.installed === 0) throw new HttpError(409, `install '${id}' first`);
    this.assertEntitled(id);
    this.assertConfigured(id);
    await this.activate(id, { markInstalled: false });
  }

  /** Shared enable/install machinery. Single inFlight take; state flips only on success. */
  private async activate(id: ModuleId, opts: { markInstalled: boolean }): Promise<void> {
    const inst = this.installed.get(id)!;
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    for (const dep of inst.manifest.dependsOn ?? []) {
      if (!this.isEnabled(dep)) throw new HttpError(409, `enable dependency '${dep}' first`);
    }
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id) ?? (await inst.load());
      this.loaded.set(id, mod);
      // Candidate last, so the error names the module being enabled.
      this.assertNoCollisions([...this.enabledIds(), id]);
      const ctx = this.moduleCtx(id);
      if (mod.migrations?.length) this.migrations.migrateUp(id, mod.migrations);
      this.adoptSecretStore(id, mod);
      this.services.setActiveModule(id);
      await mod.registerServices?.(ctx);
      this.services.setActiveModule(null);
      if (mod.routes) this.router.mount(id, mod.routes(ctx));
      if (mod.rawRoutes) this.rawRouter.mount(id, mod.rawRoutes(ctx));
      this.markState(id, opts.markInstalled ? { installed: true, enabled: true } : { enabled: true });
      this.rebuildGrid(this.topoSort(this.enabledIds()));
      try {
        await mod.lifecycle?.onEnable?.(ctx);
        await mod.lifecycle?.postActivate?.(ctx);
      } catch (err) {
        // The DB now says enabled but activation broke: readiness() reports it
        // as failed until a successful re-enable or a disable resolves it.
        this.activationFailed.add(id);
        throw err;
      }
      this.activationFailed.delete(id);
      this.startJobs(id);
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.services.setActiveModule(null);
      this.inFlight.delete(id);
    }
  }

  // ---- per-module configuration ----

  /** Redacted read: secret values never leave the kernel — only their set/unset state. */
  getConfig(id: ModuleId): ModuleConfigState {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    const stored = this.moduleConfig.valuesFor(id);
    const values: Record<string, string | number | boolean> = {};
    const secrets: Record<string, boolean> = {};
    for (const f of this.configFields(id)) {
      if (f.kind === 'secret') secrets[f.key] = stored[f.key] !== undefined;
      else if (stored[f.key] !== undefined) values[f.key] = stored[f.key]!;
    }
    return { values, secrets };
  }

  /** Validated partial update: omitted key = unchanged, `null` = clear, secrets reject `''`. */
  setConfig(id: ModuleId, patch: Readonly<Record<string, unknown>>): void {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    // A write during an in-flight activation could unset a required key AFTER
    // assertConfigured passed — enabled-but-unconfigured through the API.
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    const { set, clear } = validatePatch(this.configFields(id), patch);
    // Unsetting a required field of an ENABLED module would drift `configured`
    // apart from "running" through the API — an upgrade is the only sanctioned
    // way to reach that state. Refuse it here.
    if (this.isEnabled(id)) {
      const stillSet = new Set(Object.keys(this.moduleConfig.valuesFor(id)));
      for (const key of clear) stillSet.delete(key);
      for (const key of Object.keys(set)) stillSet.add(key);
      const broken = this.configFields(id)
        .filter((f) => f.required && f.default === undefined && !stillSet.has(f.key))
        .map((f) => f.key);
      if (broken.length) {
        throw new HttpError(409, `cannot unset required configuration of enabled module '${id}': ${broken.join(', ')}`);
      }
    }
    if (Object.keys(set).length) this.moduleConfig.setMany(id, set);
    for (const key of clear) this.moduleConfig.deleteKey(id, key);
    const keys = [...Object.keys(set), ...clear];
    if (!keys.length) return;
    this.bus.emit('module-config.changed', { moduleId: id, keys });
    this.opts.broadcast({ t: 'modules.changed' });
  }

  async disable(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (inst.manifest.required) throw new HttpError(403, `module '${id}' is required`);
    if (!this.isEnabled(id)) return;
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    const dependents = [...this.installed.values()].filter(
      (m) => this.isEnabled(m.manifest.id) && (m.manifest.dependsOn ?? []).includes(id),
    );
    if (dependents.length) {
      throw new HttpError(409, `disable dependents first: ${dependents.map((d) => d.manifest.id).join(', ')}`);
    }
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id);
      this.stopJobs(id);
      // Stop serving BEFORE teardown: the module's paths answer 503 immediately,
      // so a request can't reach a half-shut-down service during a long onDisable
      // (e.g. operate awaiting orchestrator.shutdown()).
      this.router.unmount(id);
      this.rawRouter.unmount(id);
      this.markState(id, { enabled: false });
      // A deliberately disabled module is 'available' again, not 'failed'.
      this.activationFailed.delete(id);
      this.rebuildGrid(this.topoSort(this.enabledIds()));
      await mod?.lifecycle?.onDisable?.(this.moduleCtx(id));
      this.services.revokeModule(id);
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.inFlight.delete(id);
    }
  }

  async uninstall(id: ModuleId): Promise<void> {
    const inst = this.installed.get(id);
    if (!inst) throw new HttpError(404, `unknown module: ${id}`);
    if (this.isEnabled(id)) throw new HttpError(409, `disable '${id}' before uninstalling`);
    if (this.inFlight.has(id)) throw new HttpError(409, `module '${id}' is busy`);
    this.inFlight.add(id);
    try {
      const mod = this.loaded.get(id) ?? (await inst.load());
      try {
        if (mod.migrations?.length) this.migrations.migrateDown(id, mod.migrations, 0);
      } catch {
        if (mod.purge) mod.purge(this.db);
        else throw new HttpError(409, `module '${id}' is irreversible and defines no purge()`);
      }
      // Clean slate so a later re-install re-runs migrations from scratch, and the
      // module's paths become 404 (genuinely gone), not 503 (merely disabled). Keep
      // the row as installed=0 so boot's reconcile does NOT re-adopt/resurrect it —
      // it shows under "Available" instead. User-entered config is wiped with it.
      this.migrations.clearLedger(id);
      this.moduleConfig.deleteAll(id);
      this.router.forget(id);
      this.rawRouter.forget(id);
      this.markState(id, { installed: false, enabled: false, version: 0 });
      this.opts.broadcast({ t: 'modules.changed' });
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Drop an uninstalled external module from the catalog, because its files
   * are gone.
   *
   * Only the artifact's owner calls this (the `remove` route, after the files
   * are deleted). Without it the module would keep listing as "Available" until
   * the next boot, and installing it would dynamic-import a path that no longer
   * exists. Refuses a compiled-in module: nothing deleted its code, so pretending
   * it left the build would only make the next `modules.changed` disagree with
   * the registry.
   */
  forget(id: ModuleId): void {
    const inst = this.installed.get(id);
    if (!inst) return;
    if (inst.dir === undefined) throw new HttpError(403, `module '${id}' is compiled into this build`);
    if (this.isEnabled(id)) throw new HttpError(409, `disable '${id}' first`);
    this.installed.delete(id);
    this.loaded.delete(id);
    this.perModuleCtx.delete(id);
    this.secretFields.delete(id);
  }

  /**
   * Graceful process shutdown: stop jobs + run onDisable for every enabled
   * module in REVERSE topo order (dependents wind down before their
   * dependencies), WITHOUT flipping enabled flags — state stays durable for the
   * next boot. The app closes the DB afterwards.
   */
  async shutdown(): Promise<void> {
    const order = this.topoSort(this.enabledIds()).reverse();
    for (const id of order) {
      this.stopJobs(id);
      try {
        await this.loaded.get(id)?.lifecycle?.onDisable?.(this.moduleCtx(id));
      } catch (err) {
        this.log.warn(`module '${id}' onDisable failed during shutdown`, { err: String(err) });
      }
    }
  }

  // ---- internals ----

  private enabledIds(): ModuleId[] {
    const rows = this.db.prepare(`SELECT id FROM modules WHERE enabled = 1`).all() as { id: string }[];
    return rows
      .map((r) => r.id)
      .filter((id) => {
        if (this.installed.has(id)) return true;
        // A stale row for a module no longer compiled into this build — skip it
        // (loading it would crash boot) rather than dereference undefined.
        this.log.warn(`enabled module '${id}' is not in the compiled registry — skipping`);
        return false;
      });
  }

  /** Partial UPDATE of a module row's durable state. */
  private markState(id: ModuleId, s: { installed?: boolean; enabled?: boolean; version?: number }): void {
    const sets = ['updated_at = @now'];
    const args: Record<string, number | string> = { id, now: Date.now() };
    if (s.installed !== undefined) {
      sets.push('installed = @installed');
      args.installed = s.installed ? 1 : 0;
    }
    if (s.enabled !== undefined) {
      sets.push('enabled = @enabled');
      args.enabled = s.enabled ? 1 : 0;
    }
    if (s.version !== undefined) {
      sets.push('version = @version');
      args.version = s.version;
    }
    this.db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  /**
   * Runtime uniqueness of the ids two modules could both claim. TypeScript
   * cannot catch these: identical `PermissionRegistry` / `ServerMessageRegistry`
   * declarations from two contracts merge without error, after which the RBAC
   * grid would attribute a permission to the wrong owner and disabling one
   * module would silently strip the other's capability.
   */
  private assertNoCollisions(enabled: readonly ModuleId[]): void {
    const owner = new Map<string, ModuleId>();
    for (const id of enabled) {
      const declared = [
        ...(this.loaded.get(id)?.acl?.permissions ?? []).map((p) => `permission '${p.id}'`),
        ...(this.installed.get(id)?.manifest.messages ?? []).map((t) => `WS message '${t}'`),
      ];
      for (const key of declared) {
        const prev = owner.get(key);
        if (prev) throw new HttpError(409, `module '${id}' declares ${key}, already declared by '${prev}'`);
        owner.set(key, id);
      }
    }
  }

  private rebuildGrid(enabled: readonly ModuleId[]): void {
    const sources: AclSource[] = [];
    for (const id of enabled) {
      const acl = this.loaded.get(id)?.acl;
      if (acl) sources.push({ id, acl });
    }
    this.rbac.rebuild(sources);
  }

  private startJobs(id: ModuleId): void {
    const jobs = this.loaded.get(id)?.lifecycle?.jobs ?? [];
    const timers = jobs.map((j) => {
      const t = setInterval(() => {
        try {
          const r = j.run(this.moduleCtx(id));
          if (r instanceof Promise) r.catch((err) => this.log.error(`job '${j.id}' failed`, err));
        } catch (err) {
          this.log.error(`job '${j.id}' failed`, err);
        }
      }, j.everyMs);
      t.unref?.();
      return t;
    });
    if (timers.length) this.jobTimers.set(id, timers);
  }

  private stopJobs(id: ModuleId): void {
    for (const t of this.jobTimers.get(id) ?? []) clearInterval(t);
    this.jobTimers.delete(id);
  }

  /** Kahn topological sort over `dependsOn`; throws on a cycle or a missing/disabled required dep. */
  private topoSort(ids: readonly ModuleId[]): ModuleId[] {
    const set = new Set(ids);
    // Every REQUIRED installed module must be in the enabled set (this iterates
    // the registry, not `ids`, so a disabled required module is actually caught).
    for (const inst of this.installed.values()) {
      if (inst.manifest.required && !set.has(inst.manifest.id)) {
        throw new Error(`required module '${inst.manifest.id}' is disabled`);
      }
    }
    for (const id of ids) {
      for (const dep of this.installed.get(id)?.manifest.dependsOn ?? []) {
        if (!set.has(dep)) throw new Error(`module '${id}' depends on disabled/missing '${dep}'`);
      }
    }
    const order: ModuleId[] = [];
    const visited = new Map<ModuleId, 0 | 1>(); // 0 = visiting, 1 = done
    const visit = (id: ModuleId): void => {
      const state = visited.get(id);
      if (state === 1) return;
      if (state === 0) throw new Error(`dependency cycle at module '${id}'`);
      visited.set(id, 0);
      for (const dep of this.installed.get(id)?.manifest.dependsOn ?? []) {
        if (set.has(dep)) visit(dep);
      }
      visited.set(id, 1);
      order.push(id);
    };
    for (const id of ids) visit(id);
    return order;
  }
}
