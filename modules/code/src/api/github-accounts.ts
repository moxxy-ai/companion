import { randomUUID } from 'node:crypto';
import {
  GITHUB_PURPOSES,
  REPO_PERMISSION_RANK as RANK,
  type GitHubAccountRecord,
  type GitHubAccountScope,
  type GitHubPurpose,
  type RepoAccountOption,
  type RepoCandidate,
  type RepoPermission,
} from '../contract/index.js';
import { log, currentUser } from '@companion/services';
import { GitHubClient, GitHubError } from './github-client.js';
import type { CodeStore } from './code-store.js';
import type { GithubAccountRow } from './github-accounts-store.js';

/**
 * Optional resolution context. `username` overrides the request-scoped invoker;
 * `workspaceId` explicitly selects the target workspace. This matters while
 * adding a repo that is already connected elsewhere: account eligibility must
 * be checked against the requested destination, not the existing connection.
 */
type ResolveCtx = {
  repo?: string;
  accountId?: string;
  username?: string | null;
  workspaceId?: string;
  /**
   * The LEAST repository permission this action needs. Seeing a repo is not the
   * same as being allowed to change it: a read-only collaborator resolved for a
   * push is only discovered deep inside git, as GitHub's opaque 403. Defaults
   * to 'pull' so read paths are unaffected — writing callers say what they need.
   */
  need?: RepoPermission;
};

/**
 * Grade GitHub's per-token `permissions` block onto the ladder. A payload
 * without one cannot be judged — assume full rights so an unfamiliar response
 * shape degrades to attempting the action rather than locking the user out.
 */
export function gradeRepoPermissions(
  perms: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean } | undefined,
): RepoPermission {
  if (!perms) return 'admin';
  if (perms.admin) return 'admin';
  if (perms.maintain) return 'maintain';
  if (perms.push) return 'push';
  if (perms.triage) return 'triage';
  return 'pull';
}

/** How long a repo-access probe result (per account) stays trusted. */
const ACCESS_TTL_MS = 5 * 60_000;

/** One probe of `GET /repos/:full` as this account: the highest permission it
 *  holds there, or null when the repo is invisible to it. */
type RepoReach = { readonly granted: RepoPermission | null; readonly at: number };

/**
 * Registry of personal GitHub accounts (PATs). Every credential belongs to a
 * Companion profile and can only be resolved for that same profile. Multiple
 * accounts per user are supported; workspace selection only decides which of
 * their own accounts is eligible, never who may borrow it.
 */
export class GitHubAccounts {
  private readonly clients = new Map<string, GitHubClient>();
  /** `${accountId}:${repo}` → probed repo reach (TTL'd, cleared on account changes). */
  private readonly repoAccess = new Map<string, RepoReach>();

  constructor(private readonly store: CodeStore) {}

  /** Legacy instance-wide PATs are deliberately not adopted: there is no safe
   * owner to assign them to. The admin reconnects it from their own profile. */
  migrateLegacyToken(): void {
    // Kept as a compatibility hook for the module lifecycle. Importantly this
    // is a no-op: an unowned token must never become a credential for everyone.
  }

  list(): GitHubAccountRecord[] {
    return this.store.githubAccounts
      .list()
      .filter((row): row is GithubAccountRow & { ownerId: string } => row.ownerId !== null)
      .map(toRecord);
  }

  /** Validate the token, then insert (or replace the token of the same login). */
  async add(
    token: string,
    purposes: readonly GitHubPurpose[],
    ownerId: string,
    scope: GitHubAccountScope = 'all',
    workspaceIds: readonly string[] = [],
  ): Promise<GitHubAccountRecord> {
    const client = new GitHubClient(token);
    const viewer = await client.viewer();
    // The same GitHub login may be connected independently by different
    // Companion users. One user's connect flow must never replace another's.
    // Never let one user's connect flow overwrite another user's token.
    const existing = this.store.githubAccounts
      .list()
      .find((a) => a.login === viewer.login && a.ownerId === ownerId);
    if (existing) {
      this.store.githubAccounts.update(existing.id, { token, purposes, scope, workspaceIds });
      this.clients.set(existing.id, client);
      this.clearAccessCache(existing.id);
      // Ownership stays with whoever first connected the account.
      return toRecord({
        ...existing,
        login: viewer.login,
        purposes: [...purposes],
        scope,
        workspaceIds: [...workspaceIds],
        ownerId,
      });
    }
    const id = `gha-${randomUUID().slice(0, 12)}`;
    const createdAt = Date.now();
    this.store.githubAccounts.insert({ id, login: viewer.login, token, purposes, scope, workspaceIds, ownerId, createdAt });
    this.clients.set(id, client);
    return { id, login: viewer.login, purposes: [...purposes], scope, workspaceIds: [...workspaceIds], ownerId, createdAt };
  }

  update(
    id: string,
    fields: { purposes?: readonly GitHubPurpose[]; scope?: GitHubAccountScope; workspaceIds?: readonly string[] },
  ): GitHubAccountRecord {
    const row = this.store.githubAccounts
      .list()
      .find((a): a is GithubAccountRow & { ownerId: string } => a.id === id && a.ownerId !== null);
    if (!row) throw new Error(`unknown GitHub account: ${id}`);
    this.store.githubAccounts.update(id, fields);
    const updated = this.store.githubAccounts
      .list()
      .find((a): a is GithubAccountRow & { ownerId: string } => a.id === id && a.ownerId !== null) ?? row;
    return toRecord(updated);
  }

  /** The stored row (owner check for management gates). */
  row(id: string): GithubAccountRow | undefined {
    return this.store.githubAccounts.list().find((a) => a.id === id && a.ownerId !== null);
  }

  remove(id: string): void {
    this.store.repos.orphanWebhookRegistrationsForAccount(id);
    this.store.githubAccounts.delete(id);
    this.clients.delete(id);
    this.clearAccessCache(id);
  }

  /** A changed token/removal invalidates what we learned about the account's reach. */
  private clearAccessCache(accountId: string): void {
    for (const key of this.repoAccess.keys()) {
      if (key.startsWith(`${accountId}:`)) this.repoAccess.delete(key);
    }
  }

  clientFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GitHubClient | null {
    const row = this.rowFor(purpose, ctx);
    return row ? this.clientOf(row) : null;
  }

  tokenFor(purpose: GitHubPurpose, ctx?: ResolveCtx): string | null {
    return this.rowFor(purpose, ctx)?.token ?? null;
  }

  loginFor(purpose: GitHubPurpose): string | null {
    const login = this.rowFor(purpose)?.login;
    return login ? login : null;
  }

  /**
   * Access-verified resolution for repo-bound work (clone/fetch/push, adding a
   * repo): walk the candidates in precedence order and return the first with
   * the requested reach, probing GitHub when several compete. `tried` lists the
   * logins that were rejected — feed it into user-facing errors.
   */
  async verifiedRowFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<{ row: GithubAccountRow | null; tried: string[] }> {
    const need = ctx?.need ?? 'pull';
    const candidates = this.candidatesFor(purpose, { ...ctx, repo: fullName });
    // A lone read-only candidate is returned unprobed: whatever operation
    // follows is its own probe, and there is no better account to fall over to
    // anyway. Anything ABOVE 'pull' always probes — "it fails later" is exactly
    // the opaque 403-mid-push this resolution exists to prevent.
    if (need === 'pull' && candidates.length <= 1) return { row: candidates[0] ?? null, tried: [] };
    const tried: string[] = [];
    for (const row of candidates) {
      if (await this.hasAccess(row, fullName, need)) return { row, tried };
      tried.push(row.login || row.id);
    }
    return { row: null, tried };
  }

  /**
   * Every account this profile could act with on a repo, each graded by what it
   * may actually do there, and which one is bound. This is the picker's feed:
   * choosing a credential is only meaningful when its reach is visible.
   */
  async accountsForRepo(fullName: string, ownerId: string): Promise<RepoAccountOption[]> {
    const bound = this.store.githubAccounts.binding(fullName, ownerId);
    // A binding is purpose-agnostic, so the candidate set is the union across
    // purposes — an account connected only for 'fetch' is still bindable.
    const seen = new Set<string>();
    const candidates: GithubAccountRow[] = [];
    for (const purpose of GITHUB_PURPOSES) {
      for (const row of this.candidatesFor(purpose, { repo: fullName, username: ownerId })) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          candidates.push(row);
        }
      }
    }
    return Promise.all(
      candidates.map(async (row) => ({
        id: row.id,
        login: row.login,
        permission: await this.grantedOn(row, fullName),
        bound: row.id === bound,
      })),
    );
  }

  /** The account this profile bound to the repo (null when unset/ineligible). */
  bindingFor(fullName: string, ownerId: string): string | null {
    return this.store.githubAccounts.binding(fullName, ownerId);
  }

  /**
   * Bind one of the caller's OWN accounts to a repo, or clear the binding.
   * Ownership is re-checked here: a binding must never name a credential the
   * caller could not already resolve for themselves.
   */
  bind(fullName: string, ownerId: string, accountId: string | null): void {
    if (accountId !== null) {
      const row = this.store.githubAccounts.list().find((a) => a.id === accountId);
      if (!row || row.ownerId !== ownerId) throw new Error('choose one of your own connected GitHub accounts');
    }
    this.store.githubAccounts.setBinding(fullName, ownerId, accountId);
  }

  /**
   * The best permission any of this profile's eligible accounts holds on the
   * repo — null when none can even see it. This is the single signal the UI
   * gates on, so a user is never offered an action their credentials cannot
   * complete. Probes are shared with resolution (same TTL cache), so listing a
   * workspace's repos costs one request per repo, not one per repo per action.
   */
  async permissionFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo' | 'need'>,
  ): Promise<RepoPermission | null> {
    const candidates = this.candidatesFor(purpose, { ...ctx, repo: fullName });
    let best: RepoPermission | null = null;
    for (const row of candidates) {
      const granted = await this.grantedOn(row, fullName);
      if (granted && (!best || RANK[granted] > RANK[best])) best = granted;
      if (best === 'admin') break;
    }
    return best;
  }

  async verifiedTokenFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<string | null> {
    const { row } = await this.verifiedRowFor(purpose, fullName, ctx);
    if (!row || !(await this.hasAccess(row, fullName, ctx?.need ?? 'pull'))) return null;
    return row.token;
  }

  /** Access-verified client for a repo-bound API action. This is the write-side
   *  equivalent of verifiedTokenFor: a higher-precedence account that cannot
   *  see the repo must not turn a valid action into GitHub's opaque 404. */
  async verifiedClientFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<{ client: GitHubClient | null; tried: string[] }> {
    const { row, tried } = await this.verifiedRowFor(purpose, fullName, ctx);
    if (!row) return { client: null, tried };
    // verifiedRowFor deliberately skips a redundant probe for a lone
    // candidate. A caller asking specifically for a verified client needs the
    // stronger contract even then (write actions must not leak GitHub's opaque
    // 404 when the selected account cannot see this repository).
    if (!(await this.hasAccess(row, fullName, ctx?.need ?? 'pull'))) {
      return { client: null, tried: [...tried, row.login || row.id] };
    }
    return { client: this.clientOf(row), tried };
  }

  /**
   * Run a repo-bound GitHub action with account failover. Visibility alone is
   * not enough for writes: a fine-grained token may read the repo but GitHub
   * can still hide a write endpoint behind 403/404. Those credential failures
   * advance to the next eligible account; semantic failures (for example a
   * non-mergeable PR) remain authoritative and are returned to the caller.
   */
  async performForRepo<T>(
    purpose: GitHubPurpose,
    fullName: string,
    action: (client: GitHubClient) => Promise<T>,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<{ result: T | null; client: GitHubClient | null; tried: string[] }> {
    const candidates = this.candidatesFor(purpose, { ...ctx, repo: fullName });
    const tried: string[] = [];
    for (const row of candidates) {
      const label = row.login || row.id;
      if (!(await this.hasAccess(row, fullName, ctx?.need ?? 'pull'))) {
        tried.push(label);
        continue;
      }
      const client = this.clientOf(row);
      try {
        return { result: await action(client), client, tried };
      } catch (err) {
        const credentialFailure =
          err instanceof GitHubError && [401, 403, 404].includes(err.status) && !/rate limit/i.test(err.message);
        if (!credentialFailure) throw err;
        tried.push(label);
      }
    }
    return { result: null, client: null, tried };
  }

  /**
   * The add-repo picker feed: repositories visible to the accounts the invoking
   * user may act with in this workspace (fetch purpose), deduped by full name
   * with the highest-precedence account winning, newest push first. Browsing is
   * best-effort — an account that errors (revoked token, rate limit) is skipped.
   */
  async repoCandidates(workspaceId: string): Promise<RepoCandidate[]> {
    // Cap the fan-out: beyond the top few accounts the union stops adding reach.
    const rows = this.candidatesFor('fetch', { workspaceId }).slice(0, 3);
    const listed = await Promise.all(
      rows.map(async (row) => {
        try {
          return { row, repos: await this.clientOf(row).viewerRepos() };
        } catch (err) {
          log.warn('listing repos failed for GitHub account', { login: row.login || row.id, err: String(err) });
          return { row, repos: [] };
        }
      }),
    );
    const seen = new Set<string>();
    const out: RepoCandidate[] = [];
    for (const { row, repos } of listed) {
      for (const r of repos) {
        if (r.archived || seen.has(r.full_name)) continue;
        seen.add(r.full_name);
        out.push({
          fullName: r.full_name,
          private: r.private,
          description: r.description,
          pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : null,
          accountLogin: row.login || row.id,
        });
      }
    }
    return out.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));
  }

  /** Does this account hold at least `need` on the repo? */
  private async hasAccess(row: GithubAccountRow, fullName: string, need: RepoPermission = 'pull'): Promise<boolean> {
    const granted = await this.grantedOn(row, fullName);
    return granted !== null && RANK[granted] >= RANK[need];
  }

  /**
   * The permission this account holds on the repo, or null if it cannot see it.
   * Probes `GET /repos/:fullName`, TTL-cached: the response's `permissions`
   * block is evaluated for THIS token, which is what makes a read-only
   * collaborator distinguishable from one that may actually push.
   */
  private async grantedOn(row: GithubAccountRow, fullName: string): Promise<RepoPermission | null> {
    const key = `${row.id}:${fullName}`;
    const cached = this.repoAccess.get(key);
    if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached.granted;
    try {
      const granted = gradeRepoPermissions((await this.clientOf(row).repo(fullName)).permissions);
      this.repoAccess.set(key, { granted, at: Date.now() });
      return granted;
    } catch (err) {
      // Authorization gates fail closed: an outage must not expose a cache
      // populated by someone else. Cache only definitive credential failures;
      // transient errors are retried on the next request.
      const definitive =
        err instanceof GitHubError && [401, 403, 404].includes(err.status) && !/rate limit/i.test(err.message);
      if (definitive) this.repoAccess.set(key, { granted: null, at: Date.now() });
      return null;
    }
  }

  /** The client for an already-resolved row (e.g. the one verifiedRowFor returned). */
  clientOf(row: GithubAccountRow): GitHubClient {
    let client = this.clients.get(row.id);
    if (!client) {
      client = new GitHubClient(row.token);
      this.clients.set(row.id, client);
    }
    return client;
  }

  private rowFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GithubAccountRow | undefined {
    const candidates = this.candidatesFor(purpose, ctx);
    if (!ctx?.repo) return candidates[0];
    // Sync paths can't probe, but they can respect what probes already learned:
    // skip candidates known (cached) to lack the reach this call needs.
    const repo = ctx.repo;
    const need = ctx.need ?? 'pull';
    const holds = (r: GithubAccountRow): boolean | null => {
      const cached = this.repoAccess.get(`${r.id}:${repo}`);
      if (!cached || Date.now() - cached.at >= ACCESS_TTL_MS) return null; // unprobed
      return cached.granted !== null && RANK[cached.granted] >= RANK[need];
    };
    // An account already KNOWN to hold the permission beats one whose reach is
    // merely unprobed, so a sync path lands on the same account the verified
    // (async) path would have chosen. Known-insufficient accounts are skipped.
    return candidates.find((r) => holds(r) === true) ?? candidates.find((r) => holds(r) !== false);
  }

  /**
   * Every personal account the current Companion profile may use, in
   * precedence order. Purpose, owner, and workspace selection are hard
   * boundaries on every path, including explicit account selection.
   */
  private candidatesFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GithubAccountRow[] {
    const rows = this.store.githubAccounts.list();
    const workspaceIds = ctx?.workspaceId
      ? [ctx.workspaceId]
      : ctx?.repo
        ? this.store.repos.workspaceIds(ctx.repo)
        : [];
    // An explicit null means system-owned work and must not inherit a request
    // that happened to enqueue it. Omission alone falls back to the invoker.
    const username = ctx && 'username' in ctx ? ctx.username : (currentUser()?.username ?? null);
    if (!username) return [];
    const eligibleHere = (r: GithubAccountRow): boolean =>
      r.ownerId === username &&
      r.purposes.includes(purpose) &&
      (r.scope === 'all' || workspaceIds.some((id) => r.workspaceIds.includes(id)));

    const ordered: GithubAccountRow[] = [];

    // 1. Explicit per-action account override — only if the caller may use it.
    if (ctx?.accountId) {
      const explicit = rows.find((r) => r.id === ctx.accountId && eligibleHere(r));
      // Explicit selection is fail-closed. An ineligible account must not
      // silently fall through to a more privileged credential.
      return explicit ? [explicit] : [];
    }

    // 2. The account this profile bound to the repo, when it is still eligible.
    //    A stale binding (purpose removed, workspace narrowed) demotes rather
    //    than blocks: it is a stated preference, not an authorization.
    if (ctx?.repo) {
      const boundId = this.store.githubAccounts.binding(ctx.repo, username);
      const bound = boundId ? rows.find((r) => r.id === boundId && eligibleHere(r)) : undefined;
      if (bound) ordered.push(bound);
    }

    // 3. The invoking user's own accounts, if they hold the purpose and are
    //    eligible here — a maintainer acts as themselves when they've connected.
    ordered.push(...rows.filter(eligibleHere));

    // Dedupe, keeping the first (highest-precedence) occurrence.
    const seen = new Set<string>();
    return ordered.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }
}

function toRecord(r: GithubAccountRow & { ownerId: string }): GitHubAccountRecord {
  return {
    id: r.id,
    login: r.login,
    purposes: r.purposes,
    scope: r.scope,
    workspaceIds: r.workspaceIds,
    ownerId: r.ownerId,
    createdAt: r.createdAt,
  };
}
