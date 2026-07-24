import WebSocket from 'ws';
import type {
  AgentDiffResponse,
  AgentEventMessage,
  AgentHealth,
  AgentUpdateMoxxyResult,
  AgentHistoryResponse,
  AgentScratchResponse,
  AgentSessionInfoResponse,
  AgentStorageCleanupRequest,
  AgentStorageCleanupResponse,
  AgentWorktreeResponse,
  AgentCloneStatusResponse,
  AskResponse,
  HistorySegment,
  RunTurnArgs,
  RunTurnResult,
} from '@companion/types';
import { RUNNER_AGENT_PROTOCOL } from '@companion/types';
import { log } from '@companion/services';
import type { GitAccess, GitCredentialResolver, RunnerHealth } from '../contract/index.js';
import { MIN_MOXXY_VERSION } from '../exec/cli.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';

const HTTP_TIMEOUT_MS = 30_000;

/**
 * A runner on another machine, reached through its companion-runner agent.
 * Every backend method is one authenticated HTTP call to `/agent/*`; a single
 * long-lived WebSocket receives the run event stream and fans it into the
 * shared sink (the same one a local gateway feeds). Working directories are
 * the agent's local paths — opaque here, round-tripped verbatim.
 *
 * Git operations that touch the network carry the hub's GitHub credential
 * (`githubTokenFor`, per repo and owning profile), so the agent machine
 * needs no GitHub configuration of its own.
 */
export class RemoteRunnerBackend implements RunnerBackend {
  private ws: WebSocket | null = null;
  private wsRetry: NodeJS.Timeout | null = null;
  private closed = false;
  /** Runs believed live on the agent (from spawn/gone stream + local tracking). */
  private readonly liveRuns = new Set<string>();

  constructor(
    readonly id: string,
    private readonly endpoint: string,
    private readonly token: string,
    private readonly sink: RunnerEventSink,
    private readonly githubTokenFor: GitCredentialResolver,
    /** Event-stream up/down transitions — the registry probes on both edges. */
    private readonly onStreamState?: (up: boolean) => void,
  ) {
    this.connectEvents();
  }

  private base(): string {
    return this.endpoint.replace(/\/+$/, '');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base()}/agent${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `agent ${res.status} on ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(): Promise<RunnerHealth> {
    try {
      // /health is trivial; a machine that can't answer it in 5s is not a
      // machine to place work on — and a hanging probe must not stall the poll.
      const h = await this.call<AgentHealth>('GET', '/health', undefined, 5_000);
      const protocolOk = h.protocol === RUNNER_AGENT_PROTOCOL;
      return {
        status: protocolOk && h.moxxyCompatible ? 'online' : 'degraded',
        moxxyVersion: h.moxxyVersion,
        moxxyCompatible: h.moxxyCompatible,
        liveRuns: h.liveRuns,
        maxRuns: h.maxRuns,
        lastSeenAt: Date.now(),
        detail: !protocolOk
          ? `agent protocol ${h.protocol} != ${RUNNER_AGENT_PROTOCOL} (version mismatch)`
          : h.moxxyCompatible
            ? null
            : `agent's moxxy is missing or older than ${MIN_MOXXY_VERSION}`,
        // Older agents don't report providers — null = unknown, assume capable.
        providers: h.providers ?? null,
        agentOutdated: !protocolOk,
      };
    } catch (err) {
      return {
        status: 'offline',
        moxxyVersion: null,
        moxxyCompatible: false,
        liveRuns: 0,
        maxRuns: 0,
        lastSeenAt: null,
        detail: err instanceof Error ? err.message : String(err),
        providers: null,
      };
    }
  }

  /**
   * Trigger `npm i -g @moxxy/cli@latest` on the agent's machine. Generous
   * timeout — npm can be slow. Pre-update agents 404 this route; the caller
   * turns that into "update the agent manually first" guidance.
   */
  async updateMoxxy(): Promise<AgentUpdateMoxxyResult> {
    return this.call<AgentUpdateMoxxyResult>('POST', '/update-moxxy', undefined, 240_000);
  }

  // ---------- gateway lifecycle ----------

  async spawn(runId: string, cwd: string): Promise<void> {
    await this.call('POST', `/runs/${runId}/spawn`, { cwd, sessionId: runId });
    this.liveRuns.add(runId);
  }
  async stop(runId: string): Promise<void> {
    await this.call('POST', `/runs/${runId}/stop`).catch(() => undefined);
    this.liveRuns.delete(runId);
  }
  isLive(runId: string): boolean {
    return this.liveRuns.has(runId);
  }
  liveIds(): string[] {
    return [...this.liveRuns];
  }

  // ---------- interaction ----------

  async runTurn(runId: string, args: RunTurnArgs): Promise<RunTurnResult> {
    return this.call<RunTurnResult>('POST', `/runs/${runId}/prompt`, args);
  }
  async abortTurn(runId: string, turnId?: string): Promise<void> {
    await this.command(runId, { kind: 'abortTurn', turnId });
  }
  async sessionInfo(runId: string): Promise<unknown> {
    const r = await this.call<AgentSessionInfoResponse>('GET', `/runs/${runId}/session-info`);
    return r.info;
  }
  async setMode(runId: string, mode: string): Promise<void> {
    await this.command(runId, { kind: 'setMode', mode });
  }
  async setModel(runId: string, model: string | null): Promise<void> {
    await this.command(runId, { kind: 'setModel', model });
  }
  async setProvider(runId: string, provider: string): Promise<void> {
    await this.command(runId, { kind: 'setProvider', provider });
  }
  async runCommand(runId: string, name: string, args?: string): Promise<unknown> {
    return this.command(runId, { kind: 'runCommand', name, args });
  }
  async respondAsk(runId: string, requestId: string, response: AskResponse): Promise<void> {
    await this.command(runId, { kind: 'respondAsk', requestId, response });
  }
  private command(runId: string, command: unknown): Promise<unknown> {
    return this.call('POST', `/runs/${runId}/command`, { command });
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const q = `?limit=${limit}${before === null ? '' : `&before=${before}`}`;
    // Shorter than the default: this call blocks the transcript view, and an
    // updated agent answers within its own ~4s gateway-RPC fallback anyway.
    // Only a pre-fallback agent with a busy gateway ever reaches this deadline.
    return this.call<AgentHistoryResponse>('GET', `/runs/${runId}/history${q}`, undefined, 12_000);
  }

  async writeFile(cwd: string, relPath: string, content: string): Promise<void> {
    await this.call('POST', '/files/write', { cwd, path: relPath, content });
  }

  // ---------- git working area ----------

  async scratchDir(runId: string): Promise<string> {
    return (await this.call<AgentScratchResponse>('POST', '/scratch', { runId })).cwd;
  }
  async hasClone(repo: string): Promise<boolean> {
    return (await this.call<AgentCloneStatusResponse>('POST', '/git/clone-status', { repo })).hasClone;
  }
  async cloneDir(repo: string): Promise<string> {
    return (await this.call<AgentCloneStatusResponse>('POST', '/git/clone-status', { repo })).cloneDir;
  }
  async ensureClone(repo: string, username?: string | null): Promise<void> {
    await this.call('POST', '/git/ensure-clone', { repo, ...(await this.ghToken(repo, username)) });
  }
  async fetchOrigin(repo: string, username?: string | null): Promise<void> {
    await this.call('POST', '/git/fetch', { repo, ...(await this.ghToken(repo, username)) });
  }
  async addWorktree(
    repo: string,
    key: string,
    branch: string,
    baseBranch: string,
    username?: string | null,
  ): Promise<string> {
    return (
      await this.call<AgentWorktreeResponse>('POST', '/git/worktree', {
        repo,
        key,
        branch,
        baseBranch,
        ...(await this.ghToken(repo, username)),
      })
    ).cwd;
  }
  async addWorktreeAtBranch(repo: string, key: string, branch: string, username?: string | null): Promise<string> {
    return (
      await this.call<AgentWorktreeResponse>('POST', '/git/worktree-at', {
        repo,
        key,
        branch,
        ...(await this.ghToken(repo, username)),
      })
    ).cwd;
  }
  async removeWorktree(repo: string, cwd: string): Promise<void> {
    await this.call('POST', '/git/remove-worktree', { repo, cwd });
  }
  async diffVsBase(cwd: string, baseBranch: string): Promise<string> {
    return (await this.call<AgentDiffResponse>('POST', '/git/diff', { cwd, baseBranch })).diff;
  }
  async commitAll(cwd: string, message: string): Promise<void> {
    await this.call('POST', '/git/commit-all', { cwd, message });
  }
  async push(repo: string, cwd: string, branch: string, username?: string | null): Promise<void> {
    await this.call('POST', '/git/push', { repo, cwd, branch, ...(await this.ghToken(repo, username, 'write')) });
  }

  cleanupStorage(request: AgentStorageCleanupRequest): Promise<AgentStorageCleanupResponse> {
    // Removing dependency-heavy worktrees can take minutes on slower disks.
    return this.call<AgentStorageCleanupResponse>('POST', '/storage/cleanup', request, 10 * 60_000);
  }

  /** Every remote network operation carries the run owner's verified token;
   * never let the runner fall back to a machine-wide credential. */
  private async ghToken(
    repo: string,
    username?: string | null,
    access: GitAccess = 'read',
  ): Promise<{ githubToken: string }> {
    const token = await this.githubTokenFor(repo, username, access);
    if (!token) {
      throw new Error(
        access === 'write'
          ? `no personal GitHub credential with push access to ${repo} — connect an account with write access, or ask the repository owner to grant it`
          : `no personal GitHub credential with access to ${repo}`,
      );
    }
    return { githubToken: token };
  }

  // ---------- event stream ----------

  private connectEvents(): void {
    if (this.closed) return;
    const url = `${this.base().replace(/^http/, 'ws')}/agent/events?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => this.onStreamState?.(true));
    ws.on('message', (data) => {
      let msg: AgentEventMessage;
      try {
        msg = JSON.parse(String(data)) as AgentEventMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'event':
          this.sink.onEvent(msg.runId, msg.event);
          break;
        case 'turn.complete':
          this.sink.onTurnComplete(msg.runId, msg.turnId);
          break;
        case 'ask':
          this.sink.onAsk(msg.runId, msg.ask);
          break;
        case 'ask.resolved':
          this.sink.onAskResolved(msg.runId, msg.requestId);
          break;
        case 'gone':
          this.liveRuns.delete(msg.runId);
          this.sink.onGone(msg.runId);
          break;
        default:
          break;
      }
    });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (err) => {
      log.warn('runner agent event stream error', { runner: this.id, err: String(err) });
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.wsRetry) return;
    this.onStreamState?.(false);
    // Agent restarts reap its gateways; mark our runs gone so the UI reflects it.
    for (const runId of [...this.liveRuns]) {
      this.liveRuns.delete(runId);
      this.sink.onGone(runId);
    }
    this.wsRetry = setTimeout(() => {
      this.wsRetry = null;
      this.connectEvents();
    }, 5_000);
  }

  dispose(): void {
    this.closed = true;
    if (this.wsRetry) clearTimeout(this.wsRetry);
    this.ws?.close();
    this.ws = null;
  }
}
