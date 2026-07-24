import type Database from 'better-sqlite3';
import type { ServiceMap } from '@companion/contracts';
import type { RepoRecord } from '../contract/index.js';

/** Connected repos and their per-repo automation switches. */
export class ReposStore {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaces: ServiceMap['workspace'],
  ) {}

  upsert(repo: {
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
    workspaceId?: string;
  }): void {
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO repos (full_name, owner, name, default_branch, private, workspace_id)
           VALUES (@fullName, @owner, @name, @defaultBranch, @isPrivate, @workspaceId)
           ON CONFLICT(full_name) DO UPDATE SET
             owner = excluded.owner, name = excluded.name,
             default_branch = excluded.default_branch, private = excluded.private,
             workspace_id = COALESCE(repos.workspace_id, excluded.workspace_id)`,
        )
        .run({ ...repo, isPrivate: repo.private ? 1 : 0, workspaceId: repo.workspaceId ?? null });
      if (repo.workspaceId) this.addToWorkspace(repo.fullName, repo.workspaceId);
    });
    write();
    // Preserve the invariant that every installation has a default workspace;
    // callers may deliberately upsert global repo metadata without membership.
    this.workspaces.ensureDefault();
  }

  addToWorkspace(fullName: string, workspaceId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO repo_workspaces (repo, workspace_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(fullName, workspaceId, Date.now());
  }

  inWorkspace(fullName: string, workspaceId: string): boolean {
    return this.db
      .prepare(`SELECT 1 FROM repo_workspaces WHERE repo = ? AND workspace_id = ?`)
      .get(fullName, workspaceId) !== undefined;
  }

  workspaceIds(fullName: string): string[] {
    return (
      this.db
        .prepare(`SELECT workspace_id FROM repo_workspaces WHERE repo = ? ORDER BY created_at, workspace_id`)
        .all(fullName) as Array<{ workspace_id: string }>
    ).map((row) => row.workspace_id);
  }

  moveWorkspace(fullName: string, fromWorkspaceId: string, toWorkspaceId: string): void {
    if (fromWorkspaceId === toWorkspaceId) return;
    const move = this.db.transaction(() => {
      this.addToWorkspace(fullName, toWorkspaceId);
      this.db.prepare(`DELETE FROM repo_workspaces WHERE repo = ? AND workspace_id = ?`).run(fullName, fromWorkspaceId);
      this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE full_name = ?`).run(toWorkspaceId, fullName);
    });
    move();
  }

  listByWorkspace(workspaceId: string): RepoRow[] {
    return this.db
      .prepare(
        `SELECT r.full_name, r.owner, r.name, rw.workspace_id, r.github_account_id, r.runner_id,
                r.default_branch, r.private, r.clone_ready, r.last_sync_at, r.auto_triage,
                r.digest_enabled, r.stale_enabled, r.pr_gate, r.auto_merge, r.webhook_secret,
                r.automation_owner_id
         FROM repos r JOIN repo_workspaces rw ON rw.repo = r.full_name
         WHERE rw.workspace_id = ? ORDER BY r.full_name`,
      )
      .all(workspaceId) as RepoRow[];
  }

  getInWorkspace(fullName: string, workspaceId: string): RepoRow | undefined {
    return this.db
      .prepare(
        `SELECT r.full_name, r.owner, r.name, rw.workspace_id, r.github_account_id, r.runner_id,
                r.default_branch, r.private, r.clone_ready, r.last_sync_at, r.auto_triage,
                r.digest_enabled, r.stale_enabled, r.pr_gate, r.auto_merge, r.webhook_secret,
                r.automation_owner_id
         FROM repos r JOIN repo_workspaces rw ON rw.repo = r.full_name
         WHERE r.full_name = ? AND rw.workspace_id = ?`,
      )
      .get(fullName, workspaceId) as RepoRow | undefined;
  }

  setCloneReady(fullName: string, ready: boolean): void {
    this.db.prepare(`UPDATE repos SET clone_ready = ? WHERE full_name = ?`).run(ready ? 1 : 0, fullName);
  }

  setSynced(fullName: string): void {
    this.db.prepare(`UPDATE repos SET last_sync_at = ? WHERE full_name = ?`).run(Date.now(), fullName);
  }

  setAutomation(
    fullName: string,
    field: 'auto_triage' | 'digest_enabled' | 'stale_enabled' | 'pr_gate' | 'auto_merge',
    value: boolean,
  ): void {
    this.db.prepare(`UPDATE repos SET ${field} = ? WHERE full_name = ?`).run(value ? 1 : 0, fullName);
  }

  automationOwner(fullName: string): string | null {
    const row = this.db.prepare(`SELECT automation_owner_id FROM repos WHERE full_name = ?`).get(fullName) as
      | { automation_owner_id: string | null }
      | undefined;
    return row?.automation_owner_id ?? null;
  }

  setAutomationOwner(fullName: string, ownerId: string | null): void {
    this.db.prepare(`UPDATE repos SET automation_owner_id = ? WHERE full_name = ?`).run(ownerId, fullName);
  }

  setWebhookSecret(fullName: string, secret: string | null): void {
    this.db.prepare(`UPDATE repos SET webhook_secret = ? WHERE full_name = ?`).run(secret, fullName);
  }

  setWebhookRegistration(fullName: string, secret: string, ownerId: string, accountId: string): void {
    this.db
      .prepare(
        `UPDATE repos
         SET webhook_secret = ?, webhook_owner_id = ?, webhook_account_id = ?
         WHERE full_name = ?`,
      )
      .run(secret, ownerId, accountId, fullName);
  }

  clearWebhookRegistration(fullName: string): void {
    this.db
      .prepare(
        `UPDATE repos
         SET webhook_secret = NULL, webhook_owner_id = NULL, webhook_account_id = NULL
         WHERE full_name = ?`,
      )
      .run(fullName);
  }

  /** Disconnecting the owning account invalidates the registration. The next
   * owner gets a fresh secret and must update the hook on GitHub. */
  orphanWebhookRegistrationsForAccount(accountId: string): void {
    this.db
      .prepare(
        `UPDATE repos SET webhook_secret = NULL, webhook_owner_id = NULL, webhook_account_id = NULL
         WHERE webhook_account_id = ?`,
      )
      .run(accountId);
  }

  getWebhookRegistration(fullName: string): {
    secret: string;
    ownerId: string | null;
    accountId: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT webhook_secret AS secret, webhook_owner_id AS ownerId, webhook_account_id AS accountId
         FROM repos WHERE full_name = ?`,
      )
      .get(fullName) as { secret: string | null; ownerId: string | null; accountId: string | null } | undefined;
    return row?.secret ? { secret: row.secret, ownerId: row.ownerId, accountId: row.accountId } : null;
  }

  getWebhookSecret(fullName: string): string | null {
    const row = this.db.prepare(`SELECT webhook_secret FROM repos WHERE full_name = ?`).get(fullName) as
      | { webhook_secret: string | null }
      | undefined;
    return row?.webhook_secret ?? null;
  }

  setGithubAccount(fullName: string, accountId: string | null): void {
    this.db.prepare(`UPDATE repos SET github_account_id = ? WHERE full_name = ?`).run(accountId, fullName);
  }

  setRunner(fullName: string, runnerId: string | null): void {
    this.db.prepare(`UPDATE repos SET runner_id = ? WHERE full_name = ?`).run(runnerId, fullName);
  }

  get(fullName: string): RepoRow | undefined {
    return this.db.prepare(`SELECT * FROM repos WHERE full_name = ?`).get(fullName) as RepoRow | undefined;
  }

  /** The repo as its cross-module DTO (openIssues 0 — callers with the count fill
   *  it in). Lets other modules avoid re-implementing the row→RepoRecord mapper,
   *  which is code-owned and can't be imported across the /api boundary. */
  getRecord(fullName: string): RepoRecord | undefined {
    const row = this.get(fullName);
    return row ? rowToRepo(row) : undefined;
  }

  list(): RepoRow[] {
    return this.db.prepare(`SELECT * FROM repos ORDER BY full_name`).all() as RepoRow[];
  }

  listAccessible(workspaceIds: readonly string[]): RepoRow[] {
    if (workspaceIds.length === 0) return [];
    const placeholders = workspaceIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT r.full_name, r.owner, r.name, MIN(rw.workspace_id) AS workspace_id,
                r.github_account_id, r.runner_id, r.default_branch, r.private, r.clone_ready,
                r.last_sync_at, r.auto_triage, r.digest_enabled, r.stale_enabled, r.pr_gate,
                r.auto_merge, r.webhook_secret, r.automation_owner_id
         FROM repos r JOIN repo_workspaces rw ON rw.repo = r.full_name
         WHERE rw.workspace_id IN (${placeholders})
         GROUP BY r.full_name
         ORDER BY r.full_name`,
      )
      .all(...workspaceIds) as RepoRow[];
  }

  removeFromWorkspace(fullName: string, workspaceId: string): void {
    const remove = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM repo_workspaces WHERE repo = ? AND workspace_id = ?`).run(fullName, workspaceId);
      const next = this.db
        .prepare(`SELECT workspace_id FROM repo_workspaces WHERE repo = ? ORDER BY created_at, workspace_id LIMIT 1`)
        .get(fullName) as { workspace_id: string } | undefined;
      if (next) {
        this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE full_name = ?`).run(next.workspace_id, fullName);
        return;
      }
      this.db.prepare(`DELETE FROM issues WHERE repo = ?`).run(fullName);
      this.db.prepare(`DELETE FROM prs WHERE repo = ?`).run(fullName);
      this.db.prepare(`DELETE FROM repos WHERE full_name = ?`).run(fullName);
    });
    remove();
  }
}

export interface RepoRow {
  full_name: string;
  owner: string;
  name: string;
  workspace_id: string;
  github_account_id: string | null;
  runner_id: string | null;
  default_branch: string;
  private: number;
  clone_ready: number;
  last_sync_at: number | null;
  auto_triage: number;
  digest_enabled: number;
  stale_enabled: number;
  pr_gate: number;
  auto_merge: number;
  webhook_secret: string | null;
  webhook_owner_id?: string | null;
  webhook_account_id?: string | null;
  automation_owner_id?: string | null;
}

export function rowToRepo(row: RepoRow): RepoRecord {
  return {
    // Global repo pins belonged to the removed shared-account model.
    githubAccountId: null,
    runnerId: row.runner_id ?? null,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    workspaceId: row.workspace_id,
    defaultBranch: row.default_branch,
    private: row.private === 1,
    cloneReady: row.clone_ready === 1,
    lastSyncAt: row.last_sync_at,
    openIssues: 0, // filled by callers that have the count
    // A raw cache row cannot prove who is asking. Request routes replace this
    // only after checking one of the current profile's own accounts.
    githubAccessible: false,
    githubPermission: null,
    autoTriage: row.auto_triage === 1,
    digestEnabled: row.digest_enabled === 1,
    staleSweepEnabled: row.stale_enabled === 1,
    prGateEnabled: row.pr_gate === 1,
    autoMergeEnabled: row.auto_merge === 1,
    webhookConfigured: row.webhook_secret !== null,
    automationOwnerId: row.automation_owner_id ?? null,
  };
}
