import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { log, paths } from '@companion/services';
import type { GitAccess, GitCredentialResolver } from '../contract/index.js';

const execFileP = promisify(execFile);

/** A git invocation that exited non-zero, carrying its streams for callers
 *  (some read stdout of an expected failure, e.g. `diff --no-index`). */
class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * execFile's message is `Command failed: <the entire argv>` — which for network
 * operations means the ephemeral credential helper ends up quoted in every
 * user-facing error, burying git's actual complaint. Keep git's own words.
 */
function gitFailure(args: readonly string[], err: unknown): GitCommandError {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const stdout = e.stdout ?? '';
  const stderr = e.stderr ?? '';
  const detail =
    (stderr.trim() || (e.message ?? '').replace(/^Command failed:.*$/m, '').trim() || 'git failed')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' ');
  // The subcommand, skipping leading `-c key=value` pairs.
  const verb = args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'command';
  return new GitCommandError(`git ${verb} failed: ${redactSecrets(detail)}`, stdout, stderr);
}

/** git may echo a remote URL back; never let a credential in one reach a UI. */
function redactSecrets(text: string): string {
  return text
    .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/\/\/[^/@\s]+@/g, '//***@');
}

/**
 * Companion-owned clones + one git worktree per agent run. The user's own
 * checkout is never touched.
 *
 * PAT hygiene: the token never lands in .git/config or remote URLs. Every
 * network operation passes an ephemeral credential helper via `-c` that echoes
 * the token from the child's env.
 *
 * Network-touching methods take an optional per-call `token` used when the
 * constructor thunk yields none. On a remote runner this is the hub-supplied,
 * access-verified personal credential riding the request and it always wins
 * over any legacy machine credential.
 */
export class Checkouts {
  /** Per-repo mutex: `git worktree add` / fetch mutate shared .git state. */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * The thunk resolves per repo, profile and required access, and may be async
   * because access is probed at GitHub. Only network operations resolve it.
   */
  constructor(private readonly token: GitCredentialResolver) {}

  /** The explicit per-operation personal credential wins; the resolver is for local calls. */
  private async creds(
    fullName: string,
    fallback?: string,
    username?: string | null,
    access: GitAccess = 'read',
  ): Promise<string> {
    const credential = fallback?.trim() || (await this.token(fullName, username, access)) || null;
    if (!credential) {
      throw new Error(
        access === 'write'
          ? `no personal GitHub credential with push access to ${fullName} — connect an account with write access, or ask the repository owner to grant it`
          : `no personal GitHub credential with access to ${fullName}`,
      );
    }
    return credential;
  }

  cloneDir(fullName: string): string {
    const [owner, name] = fullName.split('/');
    return join(paths.repos(), owner ?? '_', name ?? '_');
  }

  hasClone(fullName: string): boolean {
    return existsSync(join(this.cloneDir(fullName), '.git'));
  }

  async clone(fullName: string, token?: string, username?: string | null): Promise<void> {
    await this.locked(fullName, async () => {
      const dir = this.cloneDir(fullName);
      if (existsSync(join(dir, '.git'))) return;
      mkdirSync(dir, { recursive: true });
      await this.git(
        ['clone', '--quiet', `https://github.com/${fullName}.git`, dir],
        undefined,
        await this.creds(fullName, token, username),
      );
      log.info(`cloned ${fullName}`);
    });
  }

  async fetch(fullName: string, token?: string, username?: string | null): Promise<void> {
    await this.locked(fullName, async () =>
      this.git(['fetch', '--quiet', 'origin'], this.cloneDir(fullName), await this.creds(fullName, token, username)),
    );
  }

  /** Create a worktree + branch for a run. Returns the worktree path. */
  async addWorktree(
    fullName: string,
    runId: string,
    branch: string,
    baseBranch: string,
    token?: string,
    username?: string | null,
  ): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(['fetch', '--quiet', 'origin', baseBranch], clone, await this.creds(fullName, token, username));
      const wt = join(paths.worktrees(), runId);
      await this.git(['worktree', 'add', '-b', branch, wt, `origin/${baseBranch}`], clone);
      // Keep run scaffolding (agent notes etc.) out of accidental commits.
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
  }

  /**
   * Worktree checked out AT an existing remote branch (a PR head) — for agents
   * that continue someone's branch instead of starting a fresh one. The local
   * branch is named after the run so concurrent repairs never collide; pushes
   * go to the original remote branch via `push(..., branch)`.
   */
  async addWorktreeAtBranch(
    fullName: string,
    runId: string,
    branch: string,
    token?: string,
    username?: string | null,
  ): Promise<string> {
    return this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      await this.git(['fetch', '--quiet', 'origin', branch], clone, await this.creds(fullName, token, username));
      const wt = join(paths.worktrees(), runId);
      await this.git(['worktree', 'add', '-b', `companion/${runId}`, wt, `origin/${branch}`], clone);
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });
  }

  /**
   * Temporary detached worktree at GitHub's synthetic pull-request head ref.
   * Unlike an origin branch checkout this also works for PRs opened from forks.
   * The base tracking ref is refreshed so agents can inspect the complete PR
   * incrementally with `git diff origin/<base>...HEAD -- <path>` instead of
   * receiving one oversized diff in their prompt.
   */
  async withPullRequestWorktree<T>(
    fullName: string,
    key: string,
    number: number,
    baseBranch: string,
    fn: (cwd: string) => Promise<T>,
    token?: string,
    username?: string | null,
  ): Promise<T> {
    const worktree = await this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      const credential = await this.creds(fullName, token, username);
      await this.git(
        ['fetch', '--quiet', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        clone,
        credential,
      );
      await this.git(['fetch', '--quiet', 'origin', `refs/pull/${number}/head`], clone, credential);
      const wt = join(paths.worktrees(), key);
      await this.git(['worktree', 'add', '--detach', wt, 'FETCH_HEAD'], clone);
      await this.git(['config', 'core.excludesFile', join(wt, '.git-companion-exclude')], wt).catch(
        () => undefined,
      );
      return wt;
    });

    try {
      return await fn(worktree);
    } finally {
      await this.removeWorktree(fullName, worktree).catch(() => undefined);
    }
  }

  async removeWorktree(fullName: string, worktreePath: string): Promise<void> {
    const managed = this.managedWorktree(worktreePath);
    await this.locked(fullName, async () => {
      const clone = this.cloneDir(fullName);
      const cloneReady = existsSync(join(clone, '.git'));
      if (cloneReady) {
        await this.git(['worktree', 'remove', '--force', managed], clone).catch(() => undefined);
      }
      // `git worktree remove` cannot help when the clone/admin dir vanished.
      // The path was resolved as a direct child of our managed root, so the
      // orphan fallback cannot escape into an operator-owned checkout.
      await rm(managed, { recursive: true, force: true });
      // Prune after the fallback removal too: if `git worktree remove` failed,
      // the administrative entry becomes stale only once the directory is gone.
      if (cloneReady) await this.git(['worktree', 'prune', '--expire', 'now'], clone).catch(() => undefined);
    });
  }

  /** Remove a stale worktree discovered locally by the storage janitor. The
   * .git pointer identifies the owning clone when it still exists; otherwise
   * remove only the already-validated orphan directory. */
  async removeStaleWorktree(worktreePath: string): Promise<void> {
    const managed = this.managedWorktree(worktreePath);
    const fullName = this.repoForWorktree(managed);
    if (fullName) {
      await this.removeWorktree(fullName, managed);
      return;
    }
    await rm(managed, { recursive: true, force: true });
  }

  async pruneWorktrees(fullName: string): Promise<void> {
    await this.locked(fullName, () =>
      this.git(['worktree', 'prune'], this.cloneDir(fullName)).catch(() => undefined),
    );
  }

  /** Diff of a worktree vs its base (staged + unstaged + committed on the branch). */
  async diffVsBase(worktree: string, baseBranch: string): Promise<string> {
    // Committed work on the branch…
    const committed = await this.git(['diff', `origin/${baseBranch}...HEAD`], worktree);
    // …plus anything the agent left uncommitted.
    const uncommitted = await this.git(['diff', 'HEAD'], worktree).catch(() => ({ stdout: '' }));
    const untracked = await this.untrackedPatch(worktree);
    return [committed.stdout, uncommitted.stdout, untracked].filter(Boolean).join('\n');
  }

  async hasChanges(worktree: string, baseBranch: string): Promise<boolean> {
    return (await this.diffVsBase(worktree, baseBranch)).trim().length > 0;
  }

  /** Commit everything in the worktree (agent may have left work uncommitted). */
  async commitAll(worktree: string, message: string): Promise<void> {
    await this.git(['add', '-A'], worktree);
    const status = await this.git(['status', '--porcelain'], worktree);
    if (!status.stdout.trim()) return;
    await this.git(
      ['-c', 'user.name=Companion', '-c', 'user.email=companion@localhost', 'commit', '-q', '-m', message],
      worktree,
    );
  }

  async push(
    fullName: string,
    worktree: string,
    branch: string,
    token?: string,
    username?: string | null,
  ): Promise<void> {
    await this.locked(fullName, async () =>
      this.git(
        ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`],
        worktree,
        await this.creds(fullName, token, username, 'write'),
      ),
    );
  }

  // ---------- internals ---------------------------------------------------------

  private async untrackedPatch(worktree: string): Promise<string> {
    const files = await this.git(['ls-files', '--others', '--exclude-standard'], worktree);
    const list = files.stdout.split('\n').filter(Boolean);
    let patch = '';
    for (const file of list.slice(0, 50)) {
      const diff = await this.git(['diff', '--no-index', '/dev/null', file], worktree).catch(
        (err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }),
      );
      patch += diff.stdout;
    }
    return patch;
  }

  private async git(
    args: string[],
    cwd: string | undefined,
    /** Already-resolved credential (network operations only — see creds()). */
    token?: string | null,
  ): Promise<{ stdout: string; stderr: string }> {
    // Ephemeral credential helper: git asks it for credentials; it answers with
    // the PAT from env. Nothing token-shaped touches disk or process args.
    // The leading empty helper CLEARS inherited helpers (osxkeychain etc.) —
    // helpers are cumulative, and a stale keychain identity would otherwise
    // win and push as the wrong user.
    const cred = token
      ? [
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!f() { echo "username=x-access-token"; echo "password=$COMPANION_GH_TOKEN"; }; f',
        ]
      : [];
    try {
      return await execFileP('git', [...cred, ...args], {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          ...(token ? { COMPANION_GH_TOKEN: token } : {}),
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (err) {
      throw gitFailure(args, err);
    }
  }

  private locked<T>(fullName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(fullName) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(fullName, next.catch(() => undefined));
    return next;
  }

  private managedWorktree(worktreePath: string): string {
    const root = resolve(paths.worktrees());
    const candidate = resolve(worktreePath);
    if (dirname(candidate) !== root) throw new Error('worktree path is outside the managed root');
    return candidate;
  }

  private repoForWorktree(worktreePath: string): string | null {
    let pointer: string;
    try {
      pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    } catch {
      return null;
    }
    if (!pointer.startsWith('gitdir:')) return null;
    let gitdir: string;
    let reposRoot: string;
    try {
      // macOS aliases /var to /private/var; compare canonical paths so a valid
      // managed clone is not mistaken for an orphan in temporary/data roots.
      gitdir = realpathSync(resolve(worktreePath, pointer.slice('gitdir:'.length).trim()));
      reposRoot = realpathSync(paths.repos());
    } catch {
      return null;
    }
    const worktreesAdmin = dirname(gitdir);
    const gitAdmin = dirname(worktreesAdmin);
    if (basename(worktreesAdmin) !== 'worktrees' || basename(gitAdmin) !== '.git') return null;
    const clone = dirname(gitAdmin);
    const rel = relative(reposRoot, clone);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
    const parts = rel.split(sep).filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
  }
}
