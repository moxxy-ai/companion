// Brings core's + workspace's + operate's augmentations (code dependsOn all three).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import type { ChecksSnapshot } from './checks.js';
import type { CodeService } from '../api/code-service.js';

export * from './checks.js';
export * from './pipelines.js';

/**
 * module-code contract slice — the GitHub-facing domain: repositories + the
 * multi-account registry, the issues/PRs sync cache (GitHub stays
 * authoritative), triage, AI reviews + CI checks, and pipelines.
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'repos:read': true;
    'repos:manage': true;
    'issues:read': true;
    'issues:act': true;
    'prs:read': true;
    'prs:act': true;
    'pipelines:read': true;
    'pipelines:manage': true;
    'pipelines:run': true;
    'github:connect': true;
  }
  interface ServerMessageRegistry {
    'repos.changed': Record<never, never>;
    'issues.changed': { readonly repo: string };
    'triage.changed': { readonly repo: string };
    'prs.changed': { readonly repo: string };
    'pipelines.changed': Record<never, never>;
    'pipelineRuns.changed': { readonly repo: string };
  }
  interface ServiceMap {
    /** The GitHub/code domain: repos + accounts + sync cache + triage/reviews/checks/fixes/pipelines. */
    code: CodeService;
  }
}

// ---------- GitHub domain -----------------------------------------------------

export interface RepoRecord {
  /** `owner/name` — the primary key everywhere. */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  /** Workspace this repo belongs to. */
  readonly workspaceId: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly cloneReady: boolean;
  readonly lastSyncAt: number | null;
  readonly openIssues: number;
  /** Automation switches. */
  readonly autoTriage: boolean;
  readonly digestEnabled: boolean;
  readonly staleSweepEnabled: boolean;
  /** Auto-analyze newly opened PRs (webhook) and post the review when confident. */
  readonly prGateEnabled: boolean;
  /** Auto-merge open PRs that are green + human-approved + AI-reviewed low risk. */
  readonly autoMergeEnabled: boolean;
  /** Set once a webhook secret was generated (receiver active). */
  readonly webhookConfigured: boolean;
  /** Pinned GitHub account for this repo's posting/actions; null = purpose bindings. */
  readonly githubAccountId: string | null;
  /** Preferred runner for this repo's agent work; null = auto-place among eligible. */
  readonly runnerId: string | null;
}

/** A repository a reachable GitHub account can see — the add-repo picker feed. */
export interface RepoCandidate {
  readonly fullName: string;
  readonly private: boolean;
  readonly description: string | null;
  readonly pushedAt: number | null;
  /** Login of the account that sees it (highest-precedence when several do). */
  readonly accountLogin: string;
}

export interface IssueRecord {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: ReadonlyArray<string>;
  readonly author: string;
  readonly assignees: ReadonlyArray<string>;
  readonly comments: number;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  /** Latest triage result status for this issue, if any. */
  readonly triage: 'pending' | 'applied' | 'dismissed' | null;
}

export interface PrRecord {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRef: string;
  readonly headSha: string | null;
  readonly baseRef: string;
  readonly draft: boolean;
  readonly author: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  /** Conversation comment count (harvested from the issues feed; 0 until synced). */
  readonly comments: number;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the PR was closed or merged. */
  readonly closedAt: number | null;
  /** Latest AI review status for this PR, if any. */
  readonly review: 'pending' | 'applied' | 'dismissed' | null;
  /** Risk from the latest AI review verdict — the auto-merge/priority signal. */
  readonly reviewRisk: 'low' | 'medium' | 'high' | null;
  /** Human review decision on GitHub (folded per reviewer, latest wins). */
  readonly reviewDecision: 'approved' | 'changes_requested' | null;
  /** Whether GitHub can merge cleanly; null = unknown (still computing / not fetched). */
  readonly mergeable: boolean | null;
  /** Latest CI pipeline snapshot (null until first fetch). */
  readonly checks: ChecksSnapshot | null;
}

/**
 * One changed file in a PR, from GitHub's paginated files API — which, unlike
 * the single `.diff` payload, never 406s on large pull requests. `patch` is the
 * unified hunk body; GitHub omits it for binary files and very large diffs.
 */
export interface PrFileChange {
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

// ---------- PR reviews -----------------------------------------------------------

export interface PrReviewVerdict {
  readonly summary: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly recommendation: 'approve' | 'request_changes' | 'comment';
  readonly findings: ReadonlyArray<string>;
  readonly reviewBody: string;
}

export interface PrReviewResult {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly runId: string;
  readonly status: 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: PrReviewVerdict | null;
  readonly error: string | null;
  readonly createdAt: number;
}

// ---------- Triage -------------------------------------------------------------

export interface TriageVerdict {
  readonly summary: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'trivial';
  readonly kind: 'bug' | 'feature' | 'question' | 'docs' | 'chore' | 'invalid';
  readonly labels: ReadonlyArray<string>;
  readonly duplicateOf: number | null;
  readonly needsInfo: boolean;
  readonly draftReply: string;
}

export interface TriageResult {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly runId: string;
  readonly status: 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: TriageVerdict | null;
  readonly error: string | null;
  readonly createdAt: number;
}

// ---------- GitHub accounts ----------------------------------------------------

/** What an account is bound to do; one account can hold several purposes. */
export type GitHubPurpose = 'fetch' | 'runs' | 'pipelines' | 'webhooks';

export const GITHUB_PURPOSES: readonly GitHubPurpose[] = ['fetch', 'runs', 'pipelines', 'webhooks'];

/**
 * Where an account may act. `shared` accounts serve any workspace; `delegated`
 * accounts only act for repos in the workspaces explicitly assigned to them
 * (GitHubAccountRecord.workspaceIds) — mirroring RunnerScope.
 */
export type GitHubAccountScope = 'shared' | 'delegated';

/** A connected GitHub account (PAT); tokens never leave the daemon. */
export interface GitHubAccountRecord {
  readonly id: string;
  readonly login: string;
  readonly purposes: readonly GitHubPurpose[];
  readonly scope: GitHubAccountScope;
  /** Workspaces this account serves when `delegated` (ignored when `shared`). */
  readonly workspaceIds: ReadonlyArray<string>;
  /**
   * User who connected/owns this account. A user's own account is preferred
   * when they invoke an action; null = a shared default account (admin-managed)
   * used as the fallback for everyone.
   */
  readonly ownerId: string | null;
  readonly createdAt: number;
}

// ---------- comments / webhooks / briefings -------------------------------------

/** A GitHub issue/PR conversation comment (read-through, not cached). */
export interface CommentRecord {
  readonly author: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface WebhookInfo {
  /** Deliveries POST here (behind the public tunnel / the user's port-forward). */
  readonly path: string;
  readonly secret: string;
  /** Absolute delivery URL when the moxxy-proxy tunnel is up; null otherwise. */
  readonly url: string | null;
}

/** How often a workspace's briefing report is generated. */
export type BriefingCadence = 'off' | 'daily' | 'weekly';
