/**
 * The companion-runner agent wire protocol.
 *
 * A remote runner is another machine running the `companion-runner` agent: a
 * slim daemon that does locally what companiond does on its own box — spawn
 * moxxy gateways, hold git clones/worktrees, serve session history. companiond
 * drives it over this HTTP + WebSocket API. Both sides import these types so
 * the contract can't drift.
 *
 * Transport:
 *   - HTTP  POST/GET under `/agent/*`, bearer-token auth (the runner's token).
 *   - WS    `/agent/events?token=…` — the agent pushes run events, ask
 *           requests/resolutions, turn completions, and gone notices; the
 *           daemon fans them into the same sinks a local gateway feeds.
 *
 * Working directories (cwd, worktree paths) are OPAQUE to companiond for
 * remote runs — they are paths on the agent's machine. companiond only stores
 * them on the run row and hands them back to the agent verbatim.
 */

import type { AskRequest, AskResponse, HistorySegment, MoxxyEvent, PromptAttachment } from './moxxy.js';

/** GET /agent/health */
export interface AgentHealth {
  readonly ok: true;
  readonly moxxyVersion: string | null;
  readonly moxxyCompatible: boolean;
  readonly liveRuns: number;
  readonly maxRuns: number;
  /** Protocol version so companiond can refuse an incompatible agent. */
  readonly protocol: number;
  /**
   * Model provider names configured in this runner's moxxy home. Placement
   * matches a run's model against these so work lands on a machine that can
   * serve it. Absent on older agents — companiond treats that as unknown
   * (assume capable).
   */
  readonly providers?: readonly string[];
}

/**
 * Version 2 adds image attachments to AgentPromptRequest. Bumping this makes a
 * new companiond mark pre-attachment runners degraded instead of silently
 * starting a turn that drops its visual context.
 */
export const RUNNER_AGENT_PROTOCOL = 2;

/** POST /agent/runs/:runId/spawn — bring up serve+gateway for a run at `cwd`. */
export interface AgentSpawnRequest {
  readonly cwd: string;
  /** Sticky moxxy session id (companiond uses the run id). */
  readonly sessionId: string;
}

/** POST /agent/runs/:runId/prompt */
export interface AgentPromptRequest {
  readonly prompt: string;
  readonly model?: string;
  readonly attachments?: readonly PromptAttachment[];
}

/**
 * POST /agent/files/write — drop a small file into a run's working dir (used to
 * hand AI Help its scoped credentials). `cwd` must be one the agent handed out
 * (under its scratch/worktrees root); `path` is relative and may not escape it.
 */
export interface AgentWriteFileRequest {
  readonly cwd: string;
  readonly path: string;
  readonly content: string;
  /** Octal file mode (e.g. 0o600); defaults to 0o600 for credential hygiene. */
  readonly mode?: number;
}

/** POST /agent/runs/:runId/command — the misc typed gateway commands. */
export interface AgentCommandRequest {
  readonly command:
    | { readonly kind: 'abortTurn'; readonly turnId?: string }
    | { readonly kind: 'setMode'; readonly mode: string }
    | { readonly kind: 'setModel'; readonly model: string | null }
    | { readonly kind: 'setProvider'; readonly provider: string }
    | { readonly kind: 'setAutoApprove'; readonly enabled: boolean }
    | { readonly kind: 'runCommand'; readonly name: string; readonly args?: string }
    | { readonly kind: 'respondAsk'; readonly requestId: string; readonly response: AskResponse };
}

/** GET /agent/runs/:runId/history?before=&limit= */
export type AgentHistoryResponse = HistorySegment;

/** GET /agent/runs/:runId/session-info */
export interface AgentSessionInfoResponse {
  readonly info: unknown;
}

// ---------- git working area (proxied Checkouts) -------------------------------

/** POST /agent/git/clone-status */
export interface AgentCloneStatusRequest {
  readonly repo: string;
}
export interface AgentCloneStatusResponse {
  readonly hasClone: boolean;
  /** Agent-local clone path (opaque to companiond). */
  readonly cloneDir: string;
}

/**
 * POST /agent/git/ensure-clone — clone if missing.
 *
 * `githubToken` on this and the other network-touching git requests is the
 * hub's configured GitHub credential, sent per call so the agent needs no
 * GitHub setup of its own. The agent holds it in memory only for that one git
 * invocation (same ephemeral-credential-helper hygiene as Checkouts). A
 * COMPANION_RUNNER_GITHUB_TOKEN set on the agent's machine overrides it.
 */
export interface AgentEnsureCloneRequest {
  readonly repo: string;
  readonly githubToken?: string;
}

/** POST /agent/git/fetch — refresh all origin refs of an existing clone. */
export interface AgentFetchRequest {
  readonly repo: string;
  readonly githubToken?: string;
}

/** POST /agent/git/worktree — create a fresh branch off a base (fetches). */
export interface AgentWorktreeRequest {
  readonly repo: string;
  readonly key: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly githubToken?: string;
}
/** POST /agent/git/worktree-at — check out at an existing remote branch (PR head). */
export interface AgentWorktreeAtRequest {
  readonly repo: string;
  readonly key: string;
  readonly branch: string;
  readonly githubToken?: string;
}
export interface AgentWorktreeResponse {
  /** Agent-local worktree path — becomes the run's cwd (opaque to companiond). */
  readonly cwd: string;
}

/** POST /agent/git/diff */
export interface AgentDiffRequest {
  readonly cwd: string;
  readonly baseBranch: string;
}
export interface AgentDiffResponse {
  readonly diff: string;
}

/** POST /agent/git/commit-all */
export interface AgentCommitRequest {
  readonly cwd: string;
  readonly message: string;
}
/** POST /agent/git/push */
export interface AgentPushRequest {
  readonly repo: string;
  readonly cwd: string;
  readonly branch: string;
  readonly githubToken?: string;
}
/** POST /agent/git/remove-worktree */
export interface AgentRemoveWorktreeRequest {
  readonly repo: string;
  readonly cwd: string;
}
/** POST /agent/scratch — allocate a throwaway working dir for a scratch run. */
export interface AgentScratchRequest {
  readonly runId: string;
}
export interface AgentScratchResponse {
  readonly cwd: string;
}

// ---------- WS event envelope (agent → companiond) -----------------------------

export type AgentEventMessage =
  | { readonly t: 'event'; readonly runId: string; readonly event: MoxxyEvent }
  | { readonly t: 'turn.complete'; readonly runId: string; readonly turnId?: string }
  | { readonly t: 'ask'; readonly runId: string; readonly ask: AskRequest }
  | { readonly t: 'ask.resolved'; readonly runId: string; readonly requestId: string }
  | { readonly t: 'gone'; readonly runId: string }
  | { readonly t: 'hello'; readonly protocol: number };
