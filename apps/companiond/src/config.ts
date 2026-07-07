import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@companion/contract';
import { log } from './log.js';

/**
 * Companion's own data root (NOT moxxy's). Everything Companion persists lives
 * under here, including the isolated moxxy home that keeps agent sessions
 * invisible to the user's daily `~/.moxxy`.
 */
export const companionHome = (): string =>
  process.env.COMPANION_HOME ?? join(homedir(), '.companion');

export const paths = {
  root: (): string => companionHome(),
  /** Isolated MOXXY_HOME for every runner Companion spawns. */
  moxxyHome: (): string => join(companionHome(), 'moxxy-home'),
  sockets: (): string => join(companionHome(), 'moxxy-home', 'sockets'),
  sessions: (): string => join(companionHome(), 'moxxy-home', 'sessions'),
  repos: (): string => join(companionHome(), 'repos'),
  worktrees: (): string => join(companionHome(), 'worktrees'),
  scratch: (): string => join(companionHome(), 'scratch'),
  /** Per-run explicit moxxy config files (passed via `moxxy --config`). */
  runConfigs: (): string => join(companionHome(), 'run-configs'),
  db: (): string => join(companionHome(), 'companion.db'),
  daemonConfig: (): string => join(companionHome(), 'companiond.json'),
  envFile: (): string => join(companionHome(), '.env'),
};

/** Model every agent run defaults to (overridable per prompt / via env). */
export const DEFAULT_MODEL = 'gpt-5.5';

export interface UserCredential {
  readonly username: string;
  readonly password: string;
  readonly role: Role;
}

export interface DaemonConfig {
  /** Host the companiond HTTP+WS server binds on. */
  host: string;
  /** Port the companiond HTTP+WS server binds on. */
  port: number;
  /** Max concurrently live gateway processes. */
  maxLiveRuns: number;
  /** Explicit path to the moxxy CLI entry (overrides PATH lookup). */
  moxxyCliPath?: string;
  /** Default model passed on every agent turn. */
  defaultModel: string;
  /** Accounts sourced from the .env files. */
  users: readonly UserCredential[];
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8901,
  maxLiveRuns: 3,
};

interface StoredConfig {
  host?: string;
  port?: number;
  maxLiveRuns?: number;
  moxxyCliPath?: string;
}

/**
 * Load (or create on first boot) the daemon config. Also creates the dir
 * layout and resolves auth credentials from the environment:
 * process.env > ./.env (cwd) > ~/.companion/.env. If no admin credential
 * exists anywhere, one is generated into ~/.companion/.env so the install
 * is never left without a login.
 */
export function loadDaemonConfig(): DaemonConfig {
  for (const dir of [
    paths.root(),
    paths.moxxyHome(),
    paths.sockets(),
    paths.repos(),
    paths.worktrees(),
    paths.scratch(),
    paths.runConfigs(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const file = paths.daemonConfig();
  let stored: StoredConfig = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf8')) as StoredConfig;
    } catch (err) {
      log.warn('unreadable companiond.json — using defaults', { err: String(err) });
    }
  } else {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
  }

  const env = resolveEnv();
  const users = resolveUsers(env);

  return {
    host: env.COMPANION_HOST?.trim() || stored.host || DEFAULTS.host,
    port: numberFrom(env.COMPANION_PORT) ?? stored.port ?? DEFAULTS.port,
    maxLiveRuns: stored.maxLiveRuns ?? DEFAULTS.maxLiveRuns,
    moxxyCliPath: stored.moxxyCliPath,
    defaultModel: env.COMPANION_MODEL?.trim() || DEFAULT_MODEL,
    users,
  };
}

// ---------- .env resolution ------------------------------------------------------

/** Layered env: home .env < cwd .env < real process env. */
function resolveEnv(): Record<string, string> {
  const layers = [paths.envFile(), join(process.cwd(), '.env')];
  const merged: Record<string, string> = {};
  for (const file of layers) {
    Object.assign(merged, parseEnvFile(file));
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('COMPANION_') && typeof value === 'string') merged[key] = value;
  }
  return merged;
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes. */
export function parseEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ROLE_ENV: ReadonlyArray<{ role: Role; user: string; pass: string }> = [
  { role: 'admin', user: 'COMPANION_ADMIN_USER', pass: 'COMPANION_ADMIN_PASSWORD' },
  { role: 'maintainer', user: 'COMPANION_MAINTAINER_USER', pass: 'COMPANION_MAINTAINER_PASSWORD' },
  { role: 'business', user: 'COMPANION_BUSINESS_USER', pass: 'COMPANION_BUSINESS_PASSWORD' },
];

/**
 * .env accounts are SEEDS: imported once into an empty user store, after
 * which the DB (and the Users admin module) is authoritative. A clean setup
 * with no .env credentials goes through first-boot onboarding in the SPA.
 */
function resolveUsers(env: Record<string, string>): UserCredential[] {
  const users: UserCredential[] = [];
  for (const { role, user, pass } of ROLE_ENV) {
    const username = env[user]?.trim();
    const password = env[pass];
    if (username && password) users.push({ username, password, role });
    else if (username || password) {
      log.warn(`incomplete ${role} credentials — need both ${user} and ${pass}; account disabled`);
    }
  }
  const seen = new Set<string>();
  return users.filter((u) => {
    if (seen.has(u.username)) {
      log.warn(`duplicate username "${u.username}" in .env — keeping the first, dropping the ${u.role} entry`);
      return false;
    }
    seen.add(u.username);
    return true;
  });
}

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
