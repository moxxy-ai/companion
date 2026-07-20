import type { AskRequest, AskResponse, HistorySegment, MoxxyEvent, RunTurnArgs, RunTurnResult } from '@companion/types';
import type { RunnerHealth } from '../contract/index.js';

/**
 * A RunnerBackend is everything the orchestrator needs to run an agent on a
 * particular machine: the gateway lifecycle, the interaction surface, the git
 * working area, and session history. `LocalRunnerBackend` forwards to the
 * in-process GatewayPool + Checkouts (today's behavior, unchanged);
 * `RemoteRunnerBackend` proxies each call to a companion-runner agent.
 *
 * Working directories (cwd, worktree paths) are backend-owned: for remote runs
 * they are paths on the agent's machine, opaque to companiond, which only
 * stores them on the run row and hands them back.
 */
export interface RunnerBackend {
  readonly id: string;

  /** Probe the machine — feeds the health poller and the "Test connection" action. */
  probe(): Promise<RunnerHealth>;

  // ---------- gateway lifecycle ----------
  /** Bring up serve+gateway for a run whose working dir is `cwd`. */
  spawn(runId: string, cwd: string): Promise<void>;
  stop(runId: string): Promise<void>;
  isLive(runId: string): boolean;
  liveIds(): string[];

  // ---------- interaction (proxied to the gateway) ----------
  runTurn(runId: string, args: RunTurnArgs): Promise<RunTurnResult>;
  abortTurn(runId: string, turnId?: string): Promise<void>;
  sessionInfo(runId: string): Promise<unknown>;
  setMode(runId: string, mode: string): Promise<void>;
  setModel(runId: string, model: string | null): Promise<void>;
  setProvider(runId: string, provider: string): Promise<void>;
  runCommand(runId: string, name: string, args?: string): Promise<unknown>;
  respondAsk(runId: string, requestId: string, response: AskResponse): Promise<void>;
  /** Gateway when live, else the session JSONL on the runner's disk. */
  loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment>;

  /** Drop a small file into a run's working dir (e.g. AI Help's scoped creds). */
  writeFile(cwd: string, relPath: string, content: string): Promise<void>;

  // ---------- git working area (proxied to Checkouts) ----------
  /** Throwaway working dir for scratch/interactive runs (returns the cwd). */
  scratchDir(runId: string): Promise<string>;
  hasClone(repo: string): Promise<boolean>;
  cloneDir(repo: string): Promise<string>;
  ensureClone(repo: string): Promise<void>;
  /** Refresh all origin refs of the clone (e.g. a fresh base before a merge). */
  fetchOrigin(repo: string): Promise<void>;
  addWorktree(repo: string, key: string, branch: string, baseBranch: string): Promise<string>;
  addWorktreeAtBranch(repo: string, key: string, branch: string): Promise<string>;
  removeWorktree(repo: string, cwd: string): Promise<void>;
  diffVsBase(cwd: string, baseBranch: string): Promise<string>;
  commitAll(cwd: string, message: string): Promise<void>;
  push(repo: string, cwd: string, branch: string): Promise<void>;
}

/** The event sink a backend feeds — one shared instance drives the orchestrator. */
export interface RunnerEventSink {
  onEvent(runId: string, event: MoxxyEvent): void;
  onTurnComplete(runId: string, turnId?: string): void;
  onAsk(runId: string, ask: AskRequest): void;
  onAskResolved(runId: string, requestId: string): void;
  onGone(runId: string): void;
}
