import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthMode } from '@moxxy/companion-contracts';
import type { Role } from '@moxxy/companion-types';
import { log } from './lib/log.js';
import { readRegularTextFile } from './lib/files.js';

export type { AuthMode } from '@moxxy/companion-contracts';

/**
 * Companion's own data root (NOT moxxy's). Everything Companion persists lives
 * under here, including the isolated moxxy home that keeps agent sessions
 * invisible to the user's daily `~/.moxxy`.
 */
export const companionHome = (): string => process.env.COMPANION_HOME ?? join(homedir(), '.companion');

export const paths = {
  root: (): string => companionHome(),
  /** Isolated MOXXY_HOME for every runner Companion spawns. */
  moxxyHome: (): string => join(companionHome(), 'moxxy-home'),
  sockets: (): string => join(companionHome(), 'moxxy-home', 'sockets'),
  sessions: (): string => join(companionHome(), 'moxxy-home', 'sessions'),
  repos: (): string => join(companionHome(), 'repos'),
  worktrees: (): string => join(companionHome(), 'worktrees'),
  scratch: (): string => join(companionHome(), 'scratch'),
  /**
   * Per-run files a harness needs in order to start that run again: moxxy's
   * explicit config (passed via `moxxy --config`) and Codex's thread pointer.
   */
  runConfigs: (): string => join(companionHome(), 'run-configs'),
  db: (): string => join(companionHome(), 'companion.db'),
  daemonConfig: (): string => join(companionHome(), 'companiond.json'),
  envFile: (): string => join(companionHome(), '.env'),
  /** Bearer token the local CLI authenticates with (mode 0600, minted at boot). */
  cliToken: (): string => join(companionHome(), 'cli-token'),
  /** One-time first-admin capability. Removed immediately after setup. */
  bootstrapToken: (): string => join(companionHome(), 'bootstrap-token'),
  /** Local encryption key kept outside SQLite and excluded from DB backups. */
  secretKey: (): string => join(companionHome(), 'secret-key'),
  /** Offline, signed entitlement file. Absent on every OSS install. */
  license: (): string => join(companionHome(), 'license.jwt'),
  /** Marker requesting a fresh database on the NEXT boot (see requestDbRecreate). */
  recreateDbMarker: (): string => join(companionHome(), 'recreate-db'),
  /** Out-of-tree modules, one directory per module id. */
  externalModules: (): string => join(companionHome(), 'modules'),
};

/**
 * Where the encryption key came from. Rotation needs this: a key held in a file
 * can be replaced in place, while one injected through the environment can only
 * be replaced by the operator in whatever holds that environment.
 */
export type SecretKeySource =
  | { readonly key: Buffer; readonly origin: 'env' }
  | { readonly key: Buffer; readonly origin: 'file'; readonly file: string };

/**
 * Resolve the encryption key WITHOUT creating one. Returns null only when the
 * default file is simply absent (a first boot, or an install that has never
 * stored a secret); every other misconfiguration still throws, because silently
 * inventing a key for an instance that already has ciphertext would present a
 * working daemon that cannot read a single stored secret.
 */
export function readSecretEncryptionKey(): SecretKeySource | null {
  const env = resolveEnv();
  const inline = env.COMPANION_SECRET_KEY?.trim();
  const customFile = env.COMPANION_SECRET_KEY_FILE?.trim();
  if (inline && customFile) throw new Error('set only one of COMPANION_SECRET_KEY and COMPANION_SECRET_KEY_FILE');
  if (inline) return { key: decodeSecretKey(inline, 'COMPANION_SECRET_KEY'), origin: 'env' };

  const file = customFile || paths.secretKey();
  try {
    return {
      key: decodeSecretKey(
        readRegularTextFile(file, { maxBytes: 4_096, ...(customFile ? {} : { mode: 0o600 }) }).trim(),
        file,
      ),
      origin: 'file',
      file,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (customFile) throw new Error(`COMPANION_SECRET_KEY_FILE does not exist: ${file}`);
  return null;
}

/**
 * Load the AES key used by the default SQLite SecretStore. The key is never
 * stored in the database (or a database-only backup). Production can inject it
 * directly or mount a file; a local appliance gets an owner-only generated
 * file so secure defaults do not add setup questions.
 */
export function loadSecretEncryptionKey(): Buffer {
  const existing = readSecretEncryptionKey();
  if (existing) return existing.key;

  const file = paths.secretKey();
  const key = randomBytes(32);
  try {
    writeFileSync(file, `${key.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    // Two composition roots should never race because the instance lock is
    // acquired first, but reading an exclusively-created winner is safer than
    // replacing it if startup order ever changes.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return decodeSecretKey(readRegularTextFile(file, { maxBytes: 4_096, mode: 0o600 }).trim(), file);
    }
    throw error;
  }
}

/** Parse a 32-byte key from its base64url or hex spelling, naming the source on failure. */
export function decodeSecretKey(raw: string, source: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error(`${source} must encode exactly 32 bytes (base64url or 64 hex characters)`);
  }
  return key;
}

/**
 * Database recreation is a two-phase contract between the admin surface and
 * the daemon's composition root: a live process cannot delete the SQLite file
 * under its own open handle, so the route drops a marker and exits gracefully;
 * the supervisor restarts the daemon and the next boot — BEFORE opening the
 * database — consumes the marker by deleting the db files. A fresh database
 * then runs first-boot setup (or re-seeds env-configured accounts).
 */
export const requestDbRecreate = (): void => {
  mkdirSync(companionHome(), { recursive: true });
  writeFileSync(paths.recreateDbMarker(), String(Date.now()), 'utf8');
};

/** Boot-time half: if a recreation was requested, wipe the db (+WAL/SHM) and the marker. */
export const consumePendingDbRecreate = (): boolean => {
  if (!existsSync(paths.recreateDbMarker())) return false;
  for (const file of [paths.db(), `${paths.db()}-wal`, `${paths.db()}-shm`, paths.recreateDbMarker()]) {
    rmSync(file, { force: true });
  }
  return true;
};

export interface UserCredential {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly role: Role;
}

export interface DaemonConfig {
  /** Host the API server binds on. */
  host: string;
  /** Port the API server binds on. */
  port: number;
  /** Max concurrently live gateway processes. */
  maxLiveRuns: number;
  /** Browser admission policy. Local mode is accepted only on loopback. */
  authMode: AuthMode;
  /** URL remote runners use to reach this daemon's REST API. */
  publicUrl?: string;
  /**
   * Which GitHub this instance talks to. Defaults to github.com; point it at a
   * GitHub Enterprise Server by setting both. `apiUrl` must include the API path
   * GHES serves under (`https://ghe.corp/api/v3`), which composes correctly with
   * every `${apiUrl}${path}` call because the resource paths are identical.
   *
   * Daemon-level rather than module config: `code` speaks the REST API and
   * `operate` clones over git, and operate cannot read a dependent's config.
   */
  github: { readonly apiUrl: string; readonly host: string };
  /** Daemon-scheduled database backups; absent = disabled. */
  backup?: { readonly dir: string; readonly keep: number };
  /** Accounts sourced from the .env files. */
  users: readonly UserCredential[];
  /** Optional operator-supplied first-admin capability; never returned by HTTP. */
  bootstrapToken?: string;
  /**
   * Reverse proxies (IPs or CIDRs) whose X-Forwarded-For identifies the real
   * client. From any other peer the header is ignored, so the login throttle
   * cannot be steered by a spoofed header.
   */
  trustedProxies?: readonly string[];
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8901,
  maxLiveRuns: 3,
  authMode: 'password' as const,
  githubApiUrl: 'https://api.github.com',
  githubHost: 'github.com',
};

interface StoredConfig {
  host?: string;
  port?: number;
  authMode?: AuthMode;
  githubApiUrl?: string;
  githubHost?: string;
  maxLiveRuns?: number;
  publicUrl?: string;
  backupDir?: string;
  backupKeep?: number;
}

/**
 * Load (or create on first boot) the daemon config. Also creates the dir layout
 * and resolves auth credentials from the environment:
 * process.env > ./.env (cwd) > ~/.companion/.env. With no seeded account, the
 * browser presents first-boot onboarding instead.
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
  try {
    stored = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024, mode: 0o600 })) as StoredConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        try {
          stored = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024, mode: 0o600 })) as StoredConfig;
        } catch (winnerError) {
          log.warn('unreadable companiond.json — using defaults', { err: String(winnerError) });
        }
      }
    } else {
      log.warn('unreadable companiond.json — using defaults', { err: String(err) });
    }
  }

  const env = resolveEnv();
  const users = resolveUsers(env);
  scrubSeedPasswordEnvironment();
  const backupDir = env.COMPANION_BACKUP_DIR?.trim() || stored.backupDir?.trim() || undefined;
  const host = env.COMPANION_HOST?.trim() || stored.host || DEFAULTS.host;
  const authMode = authModeFrom(env.COMPANION_AUTH_MODE, stored.authMode);
  if (authMode === 'local' && !isLoopbackHost(host)) {
    throw new Error(
      `COMPANION_AUTH_MODE=local requires a loopback bind; got COMPANION_HOST=${host}. ` +
        'Use password auth before exposing Companion on a network.',
    );
  }

  return {
    host,
    port: numberFrom(env.COMPANION_PORT) ?? stored.port ?? DEFAULTS.port,
    maxLiveRuns: stored.maxLiveRuns ?? DEFAULTS.maxLiveRuns,
    authMode,
    publicUrl: env.COMPANION_PUBLIC_URL?.trim() || stored.publicUrl || undefined,
    github: {
      apiUrl: (env.COMPANION_GITHUB_API_URL?.trim() || stored.githubApiUrl || DEFAULTS.githubApiUrl).replace(/\/+$/, ''),
      host: githubHostFrom(env, stored),
    },
    backup: backupDir
      ? { dir: backupDir, keep: numberFrom(env.COMPANION_BACKUP_KEEP) ?? stored.backupKeep ?? 7 }
      : undefined,
    users,
    bootstrapToken: env.COMPANION_BOOTSTRAP_TOKEN?.trim() || undefined,
    trustedProxies: listFrom(env.COMPANION_TRUSTED_PROXIES),
  };
}

const githubHostFrom = (env: Record<string, string>, stored: StoredConfig): string =>
  env.COMPANION_GITHUB_HOST?.trim() || stored.githubHost || DEFAULTS.githubHost;

/**
 * The GitHub host this install talks to, resolved exactly as loadDaemonConfig
 * resolves `github.host` but without its boot side effects (no directory
 * creation, no config seeding). CLI callers use it for `gh --hostname` identity
 * work so a GHES instance imports the matching gh account.
 */
export function resolveGithubHost(): string {
  let stored: StoredConfig = {};
  try {
    stored = JSON.parse(readRegularTextFile(paths.daemonConfig(), { maxBytes: 1024 * 1024 })) as StoredConfig;
  } catch {
    // An uninitialized home has no stored config; env layers and the default apply.
  }
  return githubHostFrom(resolveEnv(), stored);
}

/** Comma-separated list; syntax of each entry is validated where it is used. */
function listFrom(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Only these bind names guarantee that another machine cannot connect. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Browser-facing admission guard for local auth. Binding the socket to
 * loopback keeps other machines out, but without validating the HTTP authority
 * a DNS-rebinding page could still make the browser address Companion through
 * an attacker-controlled hostname. A local CLI has no Origin/Sec-Fetch-Site,
 * so an absent Origin is accepted only when Host itself is loopback.
 */
export function isTrustedLocalHttpRequest(input: {
  readonly host?: string;
  readonly origin?: string;
  readonly secFetchSite?: string;
}): boolean {
  if (input.secFetchSite === 'cross-site') return false;
  if (!isLoopbackHost(authorityHostname(input.host))) return false;
  if (input.origin === undefined) return true;
  try {
    const origin = new URL(input.origin);
    return (origin.protocol === 'http:' || origin.protocol === 'https:') && isLoopbackHost(normalizeHostname(origin.hostname));
  } catch {
    return false;
  }
}

function authorityHostname(authority: string | undefined): string {
  if (!authority) return '';
  try {
    return normalizeHostname(new URL(`http://${authority}`).hostname);
  } catch {
    return '';
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function authModeFrom(envValue: string | undefined, storedValue: AuthMode | undefined): AuthMode {
  const isMode = (v: string | undefined): v is AuthMode => v === 'local' || v === 'password' || v === 'sso';
  const value = envValue?.trim();
  if (value !== undefined && value !== '' && !isMode(value)) {
    throw new Error(`Invalid COMPANION_AUTH_MODE=${value}; expected local, password or sso.`);
  }
  return isMode(value) ? value : isMode(storedValue) ? storedValue : DEFAULTS.authMode;
}

// ---------- .env resolution ----------

/** Layered env: home .env < cwd .env < real process env. */
function resolveEnv(): Record<string, string> {
  const layers = [paths.envFile(), join(process.cwd(), '.env')];
  const merged: Record<string, string> = {};
  for (const file of layers) Object.assign(merged, parseEnvFile(file));
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('COMPANION_') && typeof value === 'string') merged[key] = value;
  }
  return merged;
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes. */
export function parseEnvFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readRegularTextFile(file, { maxBytes: 1024 * 1024 });
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ROLE_ENV: ReadonlyArray<{ role: Role; user: string; email: string; pass: string }> = [
  { role: 'admin', user: 'COMPANION_ADMIN_USER', email: 'COMPANION_ADMIN_EMAIL', pass: 'COMPANION_ADMIN_PASSWORD' },
  {
    role: 'maintainer',
    user: 'COMPANION_MAINTAINER_USER',
    email: 'COMPANION_MAINTAINER_EMAIL',
    pass: 'COMPANION_MAINTAINER_PASSWORD',
  },
  {
    role: 'business',
    user: 'COMPANION_BUSINESS_USER',
    email: 'COMPANION_BUSINESS_EMAIL',
    pass: 'COMPANION_BUSINESS_PASSWORD',
  },
];

/**
 * Drop the seed passwords from the process environment once they have been read
 * into `users`.
 *
 * Everything the daemon spawns (git, moxxy agent runs, hooks) inherits this
 * environment, and an agent run is the last place an admin credential belongs.
 * The .env layers are deliberately left alone: they are the operator's file,
 * and a re-seed on a later boot is a no-op against a populated user store.
 */
function scrubSeedPasswordEnvironment(): void {
  for (const { pass } of ROLE_ENV) delete process.env[pass];
}

/**
 * .env accounts are SEEDS: imported once into an empty user store, after which
 * the DB (and the Users admin module) is authoritative. A clean setup with no
 * .env credentials goes through first-boot onboarding in the SPA.
 */
function resolveUsers(env: Record<string, string>): UserCredential[] {
  const users: UserCredential[] = [];
  for (const { role, user, email, pass } of ROLE_ENV) {
    const username = env[user]?.trim();
    const address = env[email]?.trim() ?? '';
    const password = env[pass];
    if (username && password) users.push({ username, email: address, password, role });
    else if (username || address || password) {
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
