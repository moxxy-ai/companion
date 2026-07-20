import type { SpaServerMessage } from '@companion/contracts';
import type {
  ChecksSummary,
  CheckRunInfo,
  ChecksSnapshot,
  PrRecord,
} from '../contract/index.js';
import { log } from '@companion/services';
import type { CodeStore } from './code-store.js';
import type { GitHubClient, GhCheckRun, GhCombinedStatus, GhReview } from './github-client.js';

/**
 * PR CI pipeline status. GitHub splits "CI" across two APIs — check runs
 * (Actions, apps) and legacy commit statuses — so this folds both into one
 * ChecksSummary. The compact snapshot is cached on the PR row (invalidated
 * when head_sha moves) and pushed to list views; detail views and reviewing
 * agents fetch fresh.
 */
export class PrChecks {
  /** In-flight de-dupe so bursts don't multiply GitHub calls. */
  private readonly inflight = new Map<string, Promise<ChecksSummary>>();

  constructor(
    private readonly store: CodeStore,
    private readonly github: (repo: string) => GitHubClient | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** Live-fetch the summary for a PR and refresh the cached snapshot. */
  async fetchSummary(repo: string, prNumber: number): Promise<ChecksSummary> {
    const key = `${repo}#${prNumber}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.fetchFresh(repo, prNumber).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /** Best-effort variant for callers that can live without checks (agents). */
  async trySummary(repo: string, prNumber: number): Promise<ChecksSummary | null> {
    try {
      return await this.fetchSummary(repo, prNumber);
    } catch (err) {
      log.warn('checks fetch failed', { repo, prNumber, err: String(err) });
      return null;
    }
  }

  /** Last preload kickoff per workspace — list views must not hammer GitHub. */
  private readonly lastWorkspacePreload = new Map<string, number>();

  /**
   * Fire-and-forget snapshot warm-up for a workspace's open PRs, invoked from
   * the list endpoint. Each finished fetch broadcasts prs.changed, so badges
   * stream into the open list view as they land.
   */
  preloadWorkspace(workspaceId: string, prs: ReadonlyArray<PrRecord>): void {
    const now = Date.now();
    if ((this.lastWorkspacePreload.get(workspaceId) ?? 0) > now - 60_000) return;
    this.lastWorkspacePreload.set(workspaceId, now);
    // Open PRs go stale as CI runs; merged/closed heads are frozen, so one
    // fetch fills them forever. Open first, then recent history.
    const openStale = prs.filter(
      (pr) => pr.state === 'open' && (!pr.checks || pr.checks.fetchedAt < now - 5 * 60_000),
    );
    const settledMissing = prs.filter((pr) => pr.state !== 'open' && !pr.checks);
    const queue = [...openStale, ...settledMissing].slice(0, 40);
    if (queue.length === 0) return;
    void (async () => {
      // Sequential on purpose: bounded GitHub pressure, snapshots land one by one.
      for (const pr of queue) {
        await this.trySummary(pr.repo, pr.number);
      }
    })();
  }

  /** Refresh snapshots for the most recently updated open PRs of a repo. */
  async refreshOpenPrs(repo: string, max = 25): Promise<void> {
    // Skip snapshot-fresh PRs: this rides the 2-min sync tick at several GitHub
    // requests per PR, and ungated it would eat the PAT budget on busy repos.
    const now = Date.now();
    const open = this.store.prs
      .list(repo)
      .filter((pr) => pr.state === 'open' && (!pr.checks || pr.checks.fetchedAt < now - 5 * 60_000))
      .slice(0, max);
    for (const pr of open) {
      await this.trySummary(repo, pr.number);
    }
  }

  private async fetchFresh(repo: string, prNumber: number): Promise<ChecksSummary> {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const client = this.github(repo);
    if (!client || !pr.headSha) {
      return { ...emptySnapshot(), repo, prNumber, headSha: pr?.headSha ?? null, runs: [] };
    }

    // Independent sources; one failing must not blank the others. The single-PR
    // GET rides along because it is the only feed that carries `mergeable` —
    // this cadence keeps conflict state fresh even when the PR itself is
    // untouched (a sibling PR merging can turn it conflicted).
    const [checkRuns, combined, ghPr] = await Promise.all([
      client.checkRuns(repo, pr.headSha).catch((err) => {
        log.warn('check-runs fetch failed', { repo, prNumber, err: String(err) });
        return [] as GhCheckRun[];
      }),
      client.combinedStatus(repo, pr.headSha).catch((err) => {
        log.warn('combined-status fetch failed', { repo, prNumber, err: String(err) });
        return null as GhCombinedStatus | null;
      }),
      client.pull(repo, prNumber).catch((err) => {
        log.warn('mergeable fetch failed', { repo, prNumber, err: String(err) });
        return null;
      }),
    ]);
    if (ghPr && ghPr.mergeable !== undefined) {
      this.store.prs.setMergeable(repo, prNumber, ghPr.mergeable);
    }

    const runs: CheckRunInfo[] = [
      ...checkRuns.map(fromCheckRun),
      ...(combined?.statuses ?? []).map(fromCommitStatus),
    ];
    const summary: ChecksSummary = {
      ...summarize(runs),
      repo,
      prNumber,
      headSha: pr.headSha,
      runs,
    };
    this.store.prs.setChecks(repo, prNumber, toSnapshot(summary));
    // Human review decision rides the same fetch cadence as the CI snapshot.
    try {
      const reviews = await client.prReviewList(repo, prNumber);
      this.store.prs.setReviewDecision(repo, prNumber, foldReviewDecision(reviews));
    } catch (err) {
      log.warn('review decision fetch failed', { repo, prNumber, err: String(err) });
    }
    this.broadcast({ t: 'prs.changed', repo });
    return summary;
  }
}

/** Latest substantive review per reviewer; any CHANGES_REQUESTED outweighs approvals. */
function foldReviewDecision(reviews: readonly GhReview[]): 'approved' | 'changes_requested' | null {
  const latest = new Map<string, GhReview['state']>();
  for (const r of reviews) {
    const who = r.user?.login;
    if (!who) continue;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(who, r.state);
    else if (r.state === 'DISMISSED') latest.delete(who);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return null;
}

// ---------- folding ---------------------------------------------------------------

const FAILING: ReadonlyArray<CheckRunInfo['conclusion']> = [
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
];

function summarize(runs: readonly CheckRunInfo[]): ChecksSnapshot {
  const pending = runs.filter((r) => r.status !== 'completed').length;
  const failed = runs.filter((r) => r.status === 'completed' && FAILING.includes(r.conclusion)).length;
  const passed = runs.length - pending - failed;
  const state =
    runs.length === 0 ? 'none' : failed > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing';
  return { state, total: runs.length, passed, failed, pending, fetchedAt: Date.now() };
}

function emptySnapshot(): ChecksSnapshot {
  return { state: 'none', total: 0, passed: 0, failed: 0, pending: 0, fetchedAt: Date.now() };
}

function toSnapshot(s: ChecksSummary): ChecksSnapshot {
  return {
    state: s.state,
    total: s.total,
    passed: s.passed,
    failed: s.failed,
    pending: s.pending,
    fetchedAt: s.fetchedAt,
  };
}

function fromCheckRun(run: GhCheckRun): CheckRunInfo {
  return {
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    detailsUrl: run.details_url,
    startedAt: run.started_at ? Date.parse(run.started_at) : null,
    completedAt: run.completed_at ? Date.parse(run.completed_at) : null,
  };
}

function fromCommitStatus(s: {
  context: string;
  state: 'success' | 'failure' | 'pending' | 'error';
  target_url: string | null;
  created_at: string;
  updated_at: string;
}): CheckRunInfo {
  const completed = s.state !== 'pending';
  return {
    name: s.context,
    status: completed ? 'completed' : 'in_progress',
    conclusion: !completed ? null : s.state === 'success' ? 'success' : 'failure',
    detailsUrl: s.target_url,
    startedAt: Date.parse(s.created_at) || null,
    completedAt: completed ? Date.parse(s.updated_at) || null : null,
  };
}

/** Render a summary as prompt-ready lines for a reviewing agent. */
export function describeChecks(summary: ChecksSummary | null): string {
  if (!summary || summary.state === 'none') {
    return 'No CI pipelines are configured or reported for this PR.';
  }
  const head = `CI pipeline status: ${summary.state.toUpperCase()} — ${summary.passed} passed, ${summary.failed} failed, ${summary.pending} running (of ${summary.total}).`;
  const lines = summary.runs.map((r) => {
    const outcome = r.status !== 'completed' ? 'running' : (r.conclusion ?? 'unknown');
    return `- ${r.name}: ${outcome}`;
  });
  return [head, ...lines].join('\n');
}
