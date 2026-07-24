// Brings module-core's + module-workspace's augmentations (operate dependsOn both).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import type { AskRequest, MoxxyEvent } from '@companion/types';
import type { OperateService } from '../api/operate-service.js';

/**
 * module-operate contract slice — the execution plane: agent runs + the run
 * queue, runner machines (local/remote), the moxxy gateway surface, and skills.
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'runs:read': true;
    'runs:act': true;
    'runners:manage': true;
    /** Connect and manage runner machines you own (bring-your-own-subscription). */
    'runners:connect': true;
    'skills:manage': true;
  }
  interface ServerMessageRegistry {
    /** Live transcript event of a run the viewer may see. */
    event: { readonly runId: string; readonly event: MoxxyEvent };
    turn: { readonly runId: string; readonly phase: 'started' | 'complete'; readonly turnId?: string };
    ask: { readonly runId: string; readonly ask: AskRequest };
    askResolved: { readonly runId: string; readonly requestId: string };
    'run.changed': { readonly run: RunRecord };
    'runs.changed': Record<never, never>;
    'queue.changed': Record<never, never>;
    'runners.changed': Record<never, never>;
  }
  interface ServiceMap {
    /** The execution plane: orchestrator + runners + checkouts + the moxxy CLI. */
    operate: OperateService;
  }
  interface BusEvents {
    /** Server-internal run lifecycle signal (modules react in onEnable, e.g. plan). */
    'run.changed': RunRecord;
  }
}

/**
 * Cross-module seam: where network git credentials come from. GitHub accounts
 * are owned by module-code (which depends on operate), so code PLUGS its
 * resolver in via `services.get('operate').setGithubTokenSource(...)` at
 * onEnable — inversion of control; operate never imports code. The default is
 * fail-closed until code registers its personal-account resolver.
 */
export interface GithubTokenSource {
  /**
   * Token for network git operations, resolved per repo and optional owning
   * user; null = none configured. May be async — an access-verified resolver
   * probes GitHub to pick an account that can actually reach the repo.
   *
   * `access` states what the operation needs: reading (clone/fetch) accepts any
   * account that can see the repo, 'write' (push) demands one that may push, so
   * a read-only account is never handed to git only to 403 mid-push.
   */
  tokenFor(repo?: string, username?: string | null, access?: GitAccess): string | null | Promise<string | null>;
  /** Login of the default posting account, when known (feeds /api/status). */
  login?(): string | null;
}

/** Reach a git network operation needs from the credential it is given. */
export type GitAccess = 'read' | 'write';

/** The resolver shape the execution plane passes around internally. */
export type GitCredentialResolver = (
  repo: string,
  username?: string | null,
  access?: GitAccess,
) => Promise<string | null> | string | null;

// ---------- runs ----------

export type RunKind = 'interactive' | 'triage' | 'fix' | 'analysis' | 'implement' | 'report' | 'assistant';

export type RunStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  /** Attended run (interactive chat / AI Help) whose gateway is live but no
   *  turn is in flight — it answered and is waiting for the next message. */
  | 'idle'
  | 'review'
  | 'completed'
  | 'abandoned'
  | 'interrupted'
  | 'failed'
  | 'stopped';

export interface RunRecord {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  readonly title: string;
  readonly cwd: string;
  /** Repo this run belongs to, `owner/name`; null for scratch/interactive runs. */
  readonly repo: string | null;
  readonly issueNumber: number | null;
  readonly proposalId: string | null;
  /** Branch a fix/implement run works on (in its worktree). */
  readonly branch: string | null;
  readonly prUrl: string | null;
  /** Per-run model override; null rides the daemon default. */
  readonly model: string | null;
  /** Runner (machine) this run executes on; null = the built-in local runner. */
  readonly runnerId: string | null;
  /**
   * User who owns this run. Attended chats (interactive / AI Help) are private
   * to their owner; null for automated/system runs (triage, digests, webhooks).
   */
  readonly userId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** True while a gateway process is attached (live transcript available). */
  readonly live: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Outcome summary (goal_complete/goal_abandon payload or error message). */
  readonly outcome: string | null;
}

/**
 * An unattended run waiting for a runner slot. It has no run row yet — it
 * becomes a real run only once it starts — so the queue is its own list the
 * user can watch, reorder, and cancel while runners are busy.
 */
export interface QueuedRunEntry {
  readonly id: string;
  readonly position: number;
  readonly kind: RunKind;
  readonly title: string;
  readonly repo: string | null;
  readonly issueNumber: number | null;
  /** Profile whose personal GitHub access authorized this repo-bound work. */
  readonly userId: string | null;
  /** Scheduling weight — higher starts sooner; sets the initial place in line. */
  readonly priority: number;
  readonly enqueuedAt: number;
}

/** The run scheduler's live state: how many are running vs the combined cap. */
export interface RunQueueSnapshot {
  readonly active: number;
  readonly capacity: number;
  readonly entries: readonly QueuedRunEntry[];
}

export interface CreateRunRequest {
  readonly kind?: RunKind;
  readonly title?: string;
  readonly prompt?: string;
}

export interface PromptRequest {
  readonly prompt: string;
  readonly model?: string;
}

export interface AskRespondRequest {
  readonly requestId: string;
  readonly response: {
    readonly mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny';
    readonly optionId?: string;
    readonly text?: string;
  };
}

/**
 * One local-day bucket of token spend across the runs the viewer may see —
 * the dashboard burn chart's series (aggregated in SQL, zero-filled).
 */
export interface TokenUsageDay {
  /** Start of the local day, ms since epoch. */
  readonly dayStart: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One model's window totals — a "most-used models" leaderboard row. */
export interface TokenUsageModel {
  /** Model id as recorded on the run; null = rode the daemon default. */
  readonly model: string | null;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The dashboard cost-analytics payload: daily series + per-model totals. */
export interface TokenUsage {
  readonly days: readonly TokenUsageDay[];
  readonly models: readonly TokenUsageModel[];
}

// ---------- runners (execution machines) ----------

export type RunnerKind = 'local' | 'remote';

/** Workspace reach: `shared` serves any workspace; `delegated` only assigned ones. */
export type RunnerScope = 'shared' | 'delegated';

export type RunnerStatus = 'online' | 'degraded' | 'offline' | 'unknown';

/** Live health of a runner, refreshed by the daemon's health poller. */
export interface RunnerHealth {
  readonly status: RunnerStatus;
  readonly moxxyVersion: string | null;
  readonly moxxyCompatible: boolean;
  readonly liveRuns: number;
  readonly maxRuns: number;
  readonly lastSeenAt: number | null;
  readonly detail: string | null;
  /**
   * Model provider names configured on the runner. null = unknown (old agent /
   * not probed yet) — placement assumes capable. Empty = can't serve any model.
   */
  readonly providers: readonly string[] | null;
  /**
   * The runner AGENT speaks an older protocol than this daemon — only an
   * on-machine agent update fixes it (set by the remote probe; absent
   * elsewhere). Distinct from moxxyCompatible, which the daemon can fix
   * remotely via update-moxxy.
   */
  readonly agentOutdated?: boolean;
}

/** Result of updating the moxxy CLI on a runner's machine. */
export interface RunnerMoxxyUpdateResult {
  readonly previous: string | null;
  readonly version: string | null;
  readonly compatible: boolean;
}

/**
 * Action kinds a runner can pin a model to — resolved against THIS runner's own
 * available models. A kind left unpinned rides the runner's own moxxy default.
 */
export type RunnerPinnableKind = 'triage' | 'analysis' | 'fix' | 'implement' | 'report' | 'interactive' | 'assistant';

export const RUNNER_PINNABLE_KINDS: readonly RunnerPinnableKind[] = [
  'triage',
  'analysis',
  'fix',
  'implement',
  'report',
  'interactive',
  'assistant',
];

/** A runner's own provider/model catalog, fetched live from its moxxy. */
export interface RunnerCatalog {
  readonly providers: ReadonlyArray<ModelCatalogProvider>;
  readonly defaultModel: string | null;
  readonly fetchedAt: number;
}

/** Per-runner model pins: action kind → model id (only kinds the user set). */
export type RunnerModelPins = Partial<Record<RunnerPinnableKind, string>>;

/**
 * A feature-level unit of agent work — 'board.worker', 'code.fix',
 * 'automations.digest' — registered by its owning module so runners can be
 * included in / excluded from specific tasks. Finer than RunKind, which only
 * classifies how a run behaves: board workers and user-triggered implement
 * runs share a kind but are different tasks. Registration is in-memory at
 * module enable; a disabled module's entries linger until restart (the same
 * discipline as queue resumers).
 */
export interface RunTaskDescriptor {
  readonly id: string;
  readonly label: string;
  /**
   * False = this task's runs currently always execute on the daemon's own
   * machine (their working dir is prepared there) and never go through
   * placement — its toggle is shown for completeness and takes effect only
   * once such runs learn to place remotely.
   */
  readonly placeable: boolean;
  readonly hint?: string;
}

/**
 * An execution host. The built-in `local` runner (id `runner-local`) always
 * exists, is `shared`, and cannot be deleted. `remote` runners are other
 * machines running the companion-runner agent, reached at `endpoint` with a
 * bearer `token` (write-only; never returned).
 */
export interface RunnerRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: RunnerKind;
  readonly endpoint: string | null;
  /** True once a token is stored (the token itself never leaves the daemon). */
  readonly hasToken: boolean;
  /**
   * Owning user, or null for a shared instance-wide runner. A personal runner
   * only receives runs its owner triggers — their own machine, their own
   * model subscription.
   */
  readonly ownerId: string | null;
  readonly scope: RunnerScope;
  readonly workspaceIds: ReadonlyArray<string>;
  readonly maxRuns: number;
  readonly enabled: boolean;
  /**
   * Task ids (RunTaskDescriptor) this machine refuses — placement never sends
   * them here; empty = takes everything. An exclude-list, so tasks added by
   * future modules stay opted-in by default. Hard filter (outranks the repo
   * pin), except the local runner remains the last resort when no machine at
   * all accepts a task.
   */
  readonly blockedTasks: readonly string[];
  readonly health: RunnerHealth;
  readonly catalog: RunnerCatalog | null;
  readonly modelPins: RunnerModelPins;
  readonly createdAt: number;
}

/** Viewer-specific runner-pool occupancy: shared runners plus their own private ones. */
export interface RunnerCapacitySnapshot {
  readonly active: number;
  readonly capacity: number;
}

export interface CreateRunnerRequest {
  readonly name: string;
  readonly endpoint: string;
  readonly token: string;
  /** Admin-only: true = instance-wide (no owner). Otherwise the runner is private to its creator. */
  readonly shared?: boolean;
  readonly scope?: RunnerScope;
  readonly workspaceIds?: ReadonlyArray<string>;
  readonly maxRuns?: number;
  readonly modelPins?: RunnerModelPins;
  readonly blockedTasks?: ReadonlyArray<string>;
}

export interface UpdateRunnerRequest {
  readonly name?: string;
  readonly endpoint?: string;
  /** New bearer token; omit to keep the current one. */
  readonly token?: string;
  readonly scope?: RunnerScope;
  readonly workspaceIds?: ReadonlyArray<string>;
  readonly maxRuns?: number;
  readonly enabled?: boolean;
  readonly modelPins?: RunnerModelPins;
  /** Full replacement block-list; empty clears it. Omit to keep the current one. */
  readonly blockedTasks?: ReadonlyArray<string>;
}

/** Result of probing a runner's endpoint (the "Test connection" action). */
export interface RunnerProbeResult {
  readonly ok: boolean;
  readonly health: RunnerHealth;
  readonly catalog: RunnerCatalog | null;
}

// ---------- moxxy / model catalog ----------

export interface MoxxyStatus {
  readonly cliPath: string | null;
  readonly cliVersion: string | null;
  readonly compatible: boolean;
  readonly homeDir: string;
  readonly homeReady: boolean;
  readonly providersImported: boolean;
  readonly githubConfigured: boolean;
  readonly githubUser: string | null;
}

export interface ModelCatalogModel {
  readonly id: string;
  readonly contextWindow: number | null;
}

export interface ModelCatalogProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** Credentials resolved — moxxy can actually serve this provider. */
  readonly ready: boolean;
  readonly models: ReadonlyArray<ModelCatalogModel>;
}

/** Connected providers + their models, read live from a run's gateway. */
export interface ModelCatalog {
  readonly activeProvider: string | null;
  readonly providers: ReadonlyArray<ModelCatalogProvider>;
  /** Model the next turn of this run will use (override or daemon default). */
  readonly current: string;
  readonly defaultModel: string;
}

export interface SetRunModelRequest {
  /** null clears the override (back to the daemon default). */
  readonly model: string | null;
  /** Switch the session's active provider first (for provider-scoped models). */
  readonly provider?: string;
}

/** State of the instance-wide webhook tunnel (public delivery via moxxy proxy). */
export interface WebhookTunnelState {
  readonly enabled: boolean;
  readonly status: 'off' | 'connecting' | 'connected' | 'error';
  /** Public base URL while up (e.g. https://<uuid>.proxy.moxxy.ai/gh). */
  readonly url: string | null;
  /** Sanitized operator-facing failure; relay internals stay in server logs. */
  readonly error: string | null;
}

// ---------- skills ----------

export interface SkillFile {
  readonly name: string;
  readonly content: string;
  readonly updatedAt: number;
}
