import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AskResponse, HistorySegment, RunTurnArgs, RunTurnResult } from '@companion/types';
import { paths } from '@companion/services';
import type { RunnerHealth } from '../contract/index.js';
import { GatewayPool } from '../exec/gateway-pool.js';
import { configuredProviderNames } from '../exec/home.js';
import { readSessionHistory } from '../exec/history.js';
import type { Checkouts } from '../exec/checkouts.js';
import { MIN_MOXXY_VERSION } from '../exec/cli.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';

/**
 * The built-in runner: companiond's own machine. Wraps the existing
 * GatewayPool + Checkouts + on-disk history so the local execution path is
 * byte-for-byte what it was before runners existed.
 */
export class LocalRunnerBackend implements RunnerBackend {
  readonly id: string;
  private readonly pool: GatewayPool;
  private readonly maxLive: number;

  constructor(
    id: string,
    private readonly checkouts: Checkouts,
    private readonly moxxyCliPath: string,
    private moxxyVersion: string | null,
    private moxxyCompatible: boolean,
    maxLive: number,
    sink: RunnerEventSink,
  ) {
    this.id = id;
    this.maxLive = maxLive;
    this.pool = new GatewayPool(
      {
        onEvent: (runId, event) => sink.onEvent(runId, event),
        onTurnComplete: (runId, turnId) => sink.onTurnComplete(runId, turnId),
        onAsk: (runId, ask) => sink.onAsk(runId, ask),
        onAskResolved: (runId, requestId) => sink.onAskResolved(runId, requestId),
        onGone: (runId) => sink.onGone(runId),
      },
      maxLive,
    );
  }

  /** After an in-place CLI upgrade: health re-advertises without a daemon restart. */
  updateMoxxyCli(version: string | null, compatible: boolean): void {
    this.moxxyVersion = version;
    this.moxxyCompatible = compatible;
  }

  async probe(): Promise<RunnerHealth> {
    return {
      status: this.moxxyCompatible ? 'online' : 'degraded',
      moxxyVersion: this.moxxyVersion,
      moxxyCompatible: this.moxxyCompatible,
      liveRuns: this.pool.liveCount,
      maxRuns: this.maxLive,
      lastSeenAt: Date.now(),
      detail: this.moxxyCompatible ? null : `moxxy is missing or older than ${MIN_MOXXY_VERSION}`,
      providers: configuredProviderNames(),
    };
  }

  async spawn(runId: string, cwd: string): Promise<void> {
    mkdirSync(cwd, { recursive: true });
    await this.pool.spawn({ runId, cwd, moxxyCliPath: this.moxxyCliPath });
  }

  async stop(runId: string): Promise<void> {
    const handle = this.pool.get(runId);
    if (handle) await handle.stop();
  }

  isLive(runId: string): boolean {
    return this.pool.get(runId)?.client.isOpen ?? false;
  }

  liveIds(): string[] {
    return this.pool.liveIds();
  }

  private live(runId: string) {
    const handle = this.pool.get(runId);
    if (!handle || !handle.client.isOpen) throw new Error(`run ${runId} has no live gateway (resume it first)`);
    return handle.client;
  }

  runTurn(runId: string, args: RunTurnArgs): Promise<RunTurnResult> {
    return this.live(runId).runTurn(args);
  }
  abortTurn(runId: string, turnId?: string): Promise<void> {
    return this.live(runId).abortTurn(turnId);
  }
  sessionInfo(runId: string): Promise<unknown> {
    return this.live(runId).sessionInfo();
  }
  setMode(runId: string, mode: string): Promise<void> {
    return this.live(runId).setMode(mode);
  }
  setModel(runId: string, model: string | null): Promise<void> {
    return this.live(runId).setModel(model);
  }
  setProvider(runId: string, provider: string): Promise<void> {
    return this.live(runId).setProvider(provider);
  }
  runCommand(runId: string, name: string, args?: string): Promise<unknown> {
    return this.live(runId).runCommand(name, args);
  }
  respondAsk(runId: string, requestId: string, response: AskResponse): Promise<void> {
    return this.live(runId).respondAsk(requestId, response);
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const handle = this.pool.get(runId);
    if (handle?.client.isOpen) return handle.client.loadHistory(runId, before, limit);
    return readSessionHistory(runId, before, limit);
  }

  async writeFile(cwd: string, relPath: string, content: string): Promise<void> {
    const target = join(cwd, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
  }

  // ---------- git working area ----------

  async scratchDir(runId: string): Promise<string> {
    const dir = join(paths.scratch(), runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  async hasClone(repo: string): Promise<boolean> {
    return this.checkouts.hasClone(repo);
  }
  async cloneDir(repo: string): Promise<string> {
    return this.checkouts.cloneDir(repo);
  }
  async ensureClone(repo: string): Promise<void> {
    await this.checkouts.clone(repo);
  }
  fetchOrigin(repo: string): Promise<void> {
    return this.checkouts.fetch(repo);
  }
  addWorktree(repo: string, key: string, branch: string, baseBranch: string): Promise<string> {
    return this.checkouts.addWorktree(repo, key, branch, baseBranch);
  }
  addWorktreeAtBranch(repo: string, key: string, branch: string): Promise<string> {
    return this.checkouts.addWorktreeAtBranch(repo, key, branch);
  }
  removeWorktree(repo: string, cwd: string): Promise<void> {
    return this.checkouts.removeWorktree(repo, cwd);
  }
  diffVsBase(cwd: string, baseBranch: string): Promise<string> {
    return this.checkouts.diffVsBase(cwd, baseBranch);
  }
  commitAll(cwd: string, message: string): Promise<void> {
    return this.checkouts.commitAll(cwd, message);
  }
  push(repo: string, cwd: string, branch: string): Promise<void> {
    return this.checkouts.push(repo, cwd, branch);
  }

  /** Reap all gateways (daemon shutdown). */
  async stopAll(): Promise<void> {
    await this.pool.stopAll();
  }
}
