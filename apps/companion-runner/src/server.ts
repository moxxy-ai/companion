import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  RUNNER_AGENT_PROTOCOL,
  type AgentCloneStatusRequest,
  type AgentCloneStatusResponse,
  type AgentCommandRequest,
  type AgentCommitRequest,
  type AgentDiffRequest,
  type AgentDiffResponse,
  type AgentEnsureCloneRequest,
  type AgentFetchRequest,
  type AgentEventMessage,
  type AgentHealth,
  type AgentPromptRequest,
  type AgentPushRequest,
  type AgentRemoveWorktreeRequest,
  type AgentScratchRequest,
  type AgentScratchResponse,
  type AgentSessionInfoResponse,
  type AgentSpawnRequest,
  type AgentWorktreeAtRequest,
  type AgentWorktreeRequest,
  type AgentWorktreeResponse,
  type AgentWriteFileRequest,
} from '@companion/types';
import { paths } from '@companion/services';
import type { Checkouts } from '@companion/module-operate/exec';
import { configuredProviderNames } from '@companion/module-operate/exec';
import type { MoxxyCli } from '@companion/module-operate/exec';
import type { GatewayClient } from '@companion/module-operate/exec';
import type { GatewayPool } from '@companion/module-operate/exec';
import { readSessionHistory } from '@companion/module-operate/exec';
import { log } from './log.js';

/**
 * The agent's HTTP + WS surface: everything under `/agent/*`, bearer-token
 * auth (the runner token), plus `/agent/events` — one WS per controlling
 * companiond onto which every GatewayPool callback is broadcast as an
 * AgentEventMessage. Mirrors companiond's http/router style, just much
 * smaller: a handful of exact routes, no RBAC, no schema layer.
 */

export interface AgentDeps {
  readonly pool: GatewayPool;
  readonly checkouts: Checkouts;
  readonly moxxy: MoxxyCli | null;
  readonly maxRuns: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const badRequest = (why: string): HttpError => new HttpError(400, why);

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 1_000;

// ---------- event hub -------------------------------------------------------------

/** Fan-out of run events to every connected companiond (usually exactly one). */
export class EventHub {
  private readonly sockets = new Set<WebSocket>();

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => {
      this.sockets.delete(ws);
      ws.terminate();
    });
    this.send(ws, { t: 'hello', protocol: RUNNER_AGENT_PROTOCOL });
  }

  broadcast(msg: AgentEventMessage): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  close(): void {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
  }

  private send(ws: WebSocket, msg: AgentEventMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

// ---------- server ----------------------------------------------------------------

export function startAgentServer(opts: {
  host: string;
  port: number;
  token: string;
  deps: AgentDeps;
  hub: EventHub;
}): Promise<Server> {
  const { host, port, token, deps, hub } = opts;
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    void handle(req, res, token, deps);
  });

  // WS /agent/events?token=… — the run event stream companiond subscribes to.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent/events') {
      socket.destroy();
      return;
    }
    const presented = url.searchParams.get('token') ?? bearerToken(req);
    if (!tokenMatches(token, presented)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info(`agent listening on http://${host}:${port}`);
      resolve(server);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  deps: AgentDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  try {
    if (!path.startsWith('/agent/')) throw new HttpError(404, `no route: ${method} ${path}`);
    if (!tokenMatches(token, bearerToken(req))) throw new HttpError(401, 'invalid or missing token');
    const body = method === 'GET' ? {} : await readBody(req);
    const result = await route(deps, method, path, url, body);
    json(res, 200, result ?? null);
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    log.warn('request failed', { method, path, err: String(err) });
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- routes ----------------------------------------------------------------

async function route(
  deps: AgentDeps,
  method: string,
  path: string,
  url: URL,
  body: unknown,
): Promise<unknown> {
  if (method === 'GET' && path === '/agent/health') {
    const health: AgentHealth = {
      ok: true,
      moxxyVersion: deps.moxxy?.version ?? null,
      moxxyCompatible: deps.moxxy?.compatible ?? false,
      liveRuns: deps.pool.liveCount,
      maxRuns: deps.maxRuns,
      protocol: RUNNER_AGENT_PROTOCOL,
      providers: configuredProviderNames(),
    };
    return health;
  }

  const run = path.match(/^\/agent\/runs\/([^/]+)\/(spawn|stop|prompt|command|history|session-info)$/);
  if (run) {
    const runId = decodeURIComponent(run[1] ?? '');
    return routeRun(deps, method, run[2] ?? '', runId, url, body);
  }

  if (method === 'POST' && path === '/agent/scratch') {
    const { runId } = body as AgentScratchRequest;
    requireString(runId, 'runId');
    const cwd = join(paths.scratch(), safeId(runId));
    mkdirSync(cwd, { recursive: true });
    return { cwd } satisfies AgentScratchResponse;
  }

  if (method === 'POST' && path === '/agent/files/write') {
    const { cwd, path: relPath, content, mode } = body as AgentWriteFileRequest;
    requireString(cwd, 'cwd');
    requireString(relPath, 'path');
    requireString(content, 'content');
    // Only inside dirs the agent manages, and no traversal out of `cwd`.
    const roots = [paths.scratch(), paths.worktrees()].map((r) => resolve(r));
    const base = resolve(cwd);
    if (!roots.some((root) => base === root || base.startsWith(root + sep))) {
      throw new HttpError(403, 'cwd is outside the agent working area');
    }
    const target = resolve(base, relPath);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new HttpError(403, 'path escapes the working dir');
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: typeof mode === 'number' ? mode : 0o600 });
    return { ok: true };
  }

  if (method === 'POST' && path.startsWith('/agent/git/')) {
    return routeGit(deps.checkouts, path.slice('/agent/git/'.length), body);
  }

  throw new HttpError(404, `no route: ${method} ${path}`);
}

async function routeRun(
  deps: AgentDeps,
  method: string,
  action: string,
  runId: string,
  url: URL,
  body: unknown,
): Promise<unknown> {
  switch (action) {
    case 'spawn': {
      requireMethod(method, 'POST', action);
      const { cwd, sessionId } = body as AgentSpawnRequest;
      requireString(cwd, 'cwd');
      requireString(sessionId, 'sessionId');
      if (!deps.moxxy) throw new HttpError(503, 'moxxy CLI is not installed on this runner');
      // The pool pins MOXXY_SESSION_ID to the run id (sticky resume + history
      // file named after the run); companiond always sends sessionId === runId.
      if (sessionId !== runId) {
        log.warn('spawn sessionId differs from runId — using runId as the session id', { runId, sessionId });
      }
      mkdirSync(cwd, { recursive: true });
      await deps.pool.spawn({ runId, cwd, moxxyCliPath: deps.moxxy.path });
      return { ok: true };
    }
    case 'stop': {
      requireMethod(method, 'POST', action);
      await deps.pool.get(runId)?.stop();
      return { ok: true };
    }
    case 'prompt': {
      requireMethod(method, 'POST', action);
      const { prompt, model, attachments } = body as AgentPromptRequest;
      requireString(prompt, 'prompt');
      return liveClient(deps.pool, runId).runTurn({ prompt, ...(model === undefined ? {} : { model }), attachments });
    }
    case 'command': {
      requireMethod(method, 'POST', action);
      return runCommand(deps.pool, runId, body);
    }
    case 'history': {
      requireMethod(method, 'GET', action);
      const limit = clampInt(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw === null || beforeRaw === '' ? null : clampInt(beforeRaw, 0, Number.MAX_SAFE_INTEGER);
      const handle = deps.pool.get(runId);
      if (handle?.client.isOpen) return handle.client.loadHistory(runId, before, limit);
      return readSessionHistory(runId, before, limit);
    }
    case 'session-info': {
      requireMethod(method, 'GET', action);
      return { info: await liveClient(deps.pool, runId).sessionInfo() } satisfies AgentSessionInfoResponse;
    }
    default:
      throw new HttpError(404, `no run action: ${action}`);
  }
}

/** Dispatch the misc typed gateway commands onto the run's live GatewayClient. */
async function runCommand(pool: GatewayPool, runId: string, body: unknown): Promise<unknown> {
  const { command } = (body ?? {}) as AgentCommandRequest;
  if (!command || typeof command !== 'object' || typeof command.kind !== 'string') {
    throw badRequest('missing command');
  }
  const client = liveClient(pool, runId);
  switch (command.kind) {
    case 'abortTurn':
      await client.abortTurn(command.turnId);
      return { ok: true };
    case 'setMode':
      await client.setMode(requireString(command.mode, 'mode'));
      return { ok: true };
    case 'setModel':
      await client.setModel(command.model ?? null);
      return { ok: true };
    case 'setProvider':
      await client.setProvider(requireString(command.provider, 'provider'));
      return { ok: true };
    case 'setAutoApprove':
      await client.setAutoApprove(command.enabled === true);
      return { ok: true };
    case 'runCommand':
      // The command's own result IS the response body (companiond passes it through).
      return (await client.runCommand(requireString(command.name, 'name'), command.args)) ?? null;
    case 'respondAsk': {
      requireString(command.requestId, 'requestId');
      if (!command.response || typeof command.response !== 'object') throw badRequest('missing response');
      await client.respondAsk(command.requestId, command.response);
      return { ok: true };
    }
    default:
      throw badRequest(`unknown command kind: ${(command as { kind: string }).kind}`);
  }
}

async function routeGit(checkouts: Checkouts, action: string, body: unknown): Promise<unknown> {
  switch (action) {
    case 'clone-status': {
      const { repo } = body as AgentCloneStatusRequest;
      requireString(repo, 'repo');
      return {
        hasClone: checkouts.hasClone(repo),
        cloneDir: checkouts.cloneDir(repo),
      } satisfies AgentCloneStatusResponse;
    }
    case 'ensure-clone': {
      const { repo, githubToken } = body as AgentEnsureCloneRequest;
      requireString(repo, 'repo');
      await checkouts.clone(repo, githubToken);
      return { ok: true };
    }
    case 'fetch': {
      const { repo, githubToken } = body as AgentFetchRequest;
      requireString(repo, 'repo');
      await checkouts.fetch(repo, githubToken);
      return { ok: true };
    }
    case 'worktree': {
      const { repo, key, branch, baseBranch, githubToken } = body as AgentWorktreeRequest;
      requireString(repo, 'repo');
      requireString(key, 'key');
      requireString(branch, 'branch');
      requireString(baseBranch, 'baseBranch');
      const cwd = await checkouts.addWorktree(repo, key, branch, baseBranch, githubToken);
      return { cwd } satisfies AgentWorktreeResponse;
    }
    case 'worktree-at': {
      const { repo, key, branch, githubToken } = body as AgentWorktreeAtRequest;
      requireString(repo, 'repo');
      requireString(key, 'key');
      requireString(branch, 'branch');
      const cwd = await checkouts.addWorktreeAtBranch(repo, key, branch, githubToken);
      return { cwd } satisfies AgentWorktreeResponse;
    }
    case 'remove-worktree': {
      const { repo, cwd } = body as AgentRemoveWorktreeRequest;
      requireString(repo, 'repo');
      requireString(cwd, 'cwd');
      await checkouts.removeWorktree(repo, cwd);
      return { ok: true };
    }
    case 'diff': {
      const { cwd, baseBranch } = body as AgentDiffRequest;
      requireString(cwd, 'cwd');
      requireString(baseBranch, 'baseBranch');
      return { diff: await checkouts.diffVsBase(cwd, baseBranch) } satisfies AgentDiffResponse;
    }
    case 'commit-all': {
      const { cwd, message } = body as AgentCommitRequest;
      requireString(cwd, 'cwd');
      requireString(message, 'message');
      await checkouts.commitAll(cwd, message);
      return { ok: true };
    }
    case 'push': {
      const { repo, cwd, branch, githubToken } = body as AgentPushRequest;
      requireString(repo, 'repo');
      requireString(cwd, 'cwd');
      requireString(branch, 'branch');
      await checkouts.push(repo, cwd, branch, githubToken);
      return { ok: true };
    }
    default:
      throw new HttpError(404, `no git action: ${action}`);
  }
}

// ---------- helpers ---------------------------------------------------------------

function liveClient(pool: GatewayPool, runId: string): GatewayClient {
  const handle = pool.get(runId);
  if (!handle || !handle.client.isOpen) {
    throw new HttpError(409, `run ${runId} has no live gateway (spawn it first)`);
  }
  return handle.client;
}

function requireMethod(method: string, expected: string, action: string): void {
  if (method !== expected) throw new HttpError(405, `method ${method} not allowed on ${action}`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw badRequest(`missing ${name}`);
  return value;
}

function clampInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`invalid number: ${raw}`);
  return Math.min(n, max);
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return null;
}

/** Constant-time token comparison (hash first so lengths always match). */
function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw badRequest('body is not valid JSON');
  }
}
