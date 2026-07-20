import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpaServerMessage } from '@companion/contracts';
import type { PrReviewResult, PrReviewVerdict } from '../contract/index.js';
import { log, extractModelJson } from '@companion/services';
import type { CodeStore } from './code-store.js';
import type { Orchestrator, Checkouts } from './operate-types.js';
import { GitHubError, type GitHubClient } from './github-client.js';
import { describeChecks, type PrChecks } from './pr-checks.js';

const verdictSchema = z.object({
  summary: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  recommendation: z.enum(['approve', 'request_changes', 'comment']),
  findings: z.array(z.string()).max(15),
  reviewBody: z.string(),
});

const MAX_DIFF_CHARS = 60_000;

/**
 * PR reviews, review-then-apply like triage: an agent reads the PR diff
 * against the repo checkout and returns a structured verdict; posting the
 * review / merging / closing only happens on explicit human action — except
 * when the repo's PR gate auto-posts a confident verdict (see Automations).
 */
export class PrReviews {
  constructor(
    private readonly store: CodeStore,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly github: (ctx?: { repo?: string; accountId?: string }) => GitHubClient | null,
    private readonly checks: PrChecks,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  async analyzePr(repo: string, prNumber: number, opts?: { context?: string }): Promise<PrReviewResult> {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const client = this.github({ repo });
    if (!client) throw new Error('GitHub is not configured');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    // The assistant sees the PR's CI pipelines alongside the diff.
    const [diff, checksSummary] = await Promise.all([
      client.prDiff(repo, prNumber),
      this.checks.trySummary(repo, prNumber),
    ]);
    const clippedDiff =
      diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;

    const { runId, finalMessage } = await this.orchestrator.runOneShot({
      kind: 'analysis',
      title: `Review PR #${prNumber}: ${pr.title.slice(0, 60)}`,
      cwd: this.checkouts.cloneDir(repo),
      repo,
      issueNumber: prNumber,
      prompt: reviewPrompt(pr.title, pr.body, pr.author, pr.baseRef, clippedDiff, describeChecks(checksSummary), opts?.context),
      timeoutMs: 8 * 60_000,
      // The caller's context rides along so a resumed review keeps its briefing.
      resume: { type: 'pr-review', args: { repo, number: prNumber, ...(opts?.context ? { context: opts.context } : {}) } },
    });

    let verdict: PrReviewVerdict | null = null;
    let error: string | null = null;
    try {
      verdict = parseReviewVerdict(finalMessage ?? '');
    } catch (err) {
      error = `could not parse review verdict: ${String(err)}`;
      log.warn('pr review parse failed', { repo, prNumber, err: String(err) });
    }

    const result: PrReviewResult = {
      id: `prr-${randomUUID().slice(0, 12)}`,
      repo,
      prNumber,
      runId,
      status: verdict ? 'pending' : 'failed',
      verdict,
      error,
      createdAt: Date.now(),
    };
    this.store.prReviews.insert(result);
    this.broadcast({ t: 'prs.changed', repo });
    return result;
  }

  /** Review history of a PR, newest first (for detail views, e.g. board tasks). */
  listForPr(repo: string, prNumber: number): PrReviewResult[] {
    return this.store.prReviews.listForPr(repo, prNumber);
  }

  /** Post the verdict to GitHub as a PR review. */
  async apply(id: string, accountId?: string): Promise<{ repo: string; number: number }> {
    const result = this.store.prReviews.get(id);
    if (!result?.verdict) throw new Error('review not found or has no verdict');
    if (result.status !== 'pending') throw new Error(`review is ${result.status}, not pending`);
    const client = this.github({ repo: result.repo, accountId });
    if (!client) throw new Error('GitHub is not configured');

    const event =
      result.verdict.recommendation === 'approve'
        ? 'APPROVE'
        : result.verdict.recommendation === 'request_changes'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
    const post = (e: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'): Promise<unknown> =>
      client.createPrReview(result.repo, result.prNumber, { body: result.verdict!.reviewBody, event: e });
    try {
      await post(event);
    } catch (err) {
      // GitHub rejects APPROVE/REQUEST_CHANGES from the PR's own author (422)
      // — common here, since the agent's account both opens PRs and reviews.
      // The verdict is still worth publishing: fall back to a comment review.
      if (err instanceof GitHubError && err.status === 422 && event !== 'COMMENT') {
        log.info('review event rejected by GitHub, posting as comment', {
          repo: result.repo,
          pr: result.prNumber,
          event,
          err: String(err),
        });
        await post('COMMENT');
      } else {
        throw err;
      }
    }
    this.store.prReviews.update(id, 'applied');
    this.broadcast({ t: 'prs.changed', repo: result.repo });
    return { repo: result.repo, number: result.prNumber };
  }

  dismiss(id: string): void {
    const result = this.store.prReviews.get(id);
    if (!result) throw new Error('review not found');
    this.store.prReviews.update(id, 'dismissed');
    this.broadcast({ t: 'prs.changed', repo: result.repo });
  }

  async merge(repo: string, prNumber: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
    const client = this.github({ repo });
    if (!client) throw new Error('GitHub is not configured');
    const result = await client.mergePr(repo, prNumber, method);
    if (!result.merged) throw new Error(result.message || 'merge refused by GitHub');
    // The caller (route) re-pulls the PR from GitHub so the cache — and thus the
    // UI — reflects the merged state immediately, not on the next full sync.
  }

  async close(repo: string, prNumber: number): Promise<void> {
    const client = this.github({ repo });
    if (!client) throw new Error('GitHub is not configured');
    await client.closePr(repo, prNumber);
  }

  /**
   * Agent post-mortem of a PR's failing CI pipelines: given the failing check
   * names, the diff, and the repo checkout, the agent investigates locally
   * (may run builds/tests read-only) and writes a markdown report stored as a
   * ci-analysis report on the PR.
   */
  async analyzeFailedChecks(repo: string, prNumber: number): Promise<void> {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const client = this.github();
    if (!client) throw new Error('GitHub is not configured');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    const summary = await this.checks.fetchSummary(repo, prNumber);
    const failing = summary.runs.filter(
      (r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped',
    );
    if (failing.length === 0) throw new Error('no failing checks on this PR');

    const diff = await client.prDiff(repo, prNumber);
    const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
    const { finalMessage } = await this.orchestrator.runOneShot({
      kind: 'analysis',
      title: `CI failure analysis — PR #${prNumber}`,
      cwd: this.checkouts.cloneDir(repo),
      repo,
      issueNumber: prNumber,
      prompt: ciAnalysisPrompt(pr.title, pr.headRef, failing, clipped),
      timeoutMs: 10 * 60_000,
      resume: { type: 'ci-analysis', args: { repo, number: prNumber } },
    });
    if (!finalMessage?.trim()) throw new Error('CI analysis produced no report');

    this.store.reports.insert({
      id: `rep-${randomUUID().slice(0, 12)}`,
      repo,
      issueNumber: prNumber,
      kind: 'ci-analysis',
      title: `CI failure analysis — PR #${prNumber}`,
      body: finalMessage.trim(),
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
    this.broadcast({ t: 'prs.changed', repo });
  }

  /**
   * The PR gate (webhook → pull_request.opened): analyze, then auto-post ONLY
   * a confident low-risk verdict on a PR whose CI is not failing; anything
   * else stays pending for the human. Merging is never automatic.
   */
  async gate(repo: string, prNumber: number): Promise<void> {
    const result = await this.analyzePr(repo, prNumber);
    if (!result.verdict || result.verdict.risk !== 'low') return;
    const checks = this.store.prs.get(repo, prNumber)?.checks ?? null;
    if (checks && checks.state === 'failing') {
      log.info('PR gate: verdict held back (CI failing)', { repo, prNumber });
      return;
    }
    await this.apply(result.id);
    log.info('PR gate auto-posted review', { repo, prNumber, recommendation: result.verdict.recommendation });
  }
}

function reviewPrompt(
  title: string,
  body: string,
  author: string,
  baseRef: string,
  diff: string,
  checks: string,
  context?: string,
): string {
  return `You are reviewing a GitHub pull request against the repository checked out in the current directory (branch ${baseRef}).

READ-ONLY RULES (mandatory): you may read files and search the codebase for context, but you must NOT modify anything. Your ONLY output is the final JSON.

## PR: ${title}
Author: ${author}

${body || '(no description)'}

## CI pipelines
${checks}
${context ? `\n## Review context\n${context}\n` : ''}
## Diff
\`\`\`diff
${diff}
\`\`\`

## Your task
Assess correctness, risk, and fit with the surrounding code, then reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "summary": "<2-3 sentence assessment of what the PR does and its quality>",
  "risk": "low" | "medium" | "high",
  "recommendation": "approve" | "request_changes" | "comment",
  "findings": ["<specific issues or observations, empty if none>"],
  "reviewBody": "<the full review comment to post on the PR, markdown, friendly and specific>"
}
Weigh the CI pipeline status in your assessment: failing or missing CI raises risk; do not recommend "approve" while required pipelines are failing.`;
}

export function parseReviewVerdict(text: string): PrReviewVerdict {
  return verdictSchema.parse(extractModelJson(text)) as PrReviewVerdict;
}

function ciAnalysisPrompt(
  title: string,
  headRef: string,
  failing: ReadonlyArray<{ name: string; conclusion: string | null; detailsUrl: string | null }>,
  diff: string,
): string {
  const list = failing
    .map((f) => `- ${f.name}: ${f.conclusion ?? 'failed'}${f.detailsUrl ? ` (${f.detailsUrl})` : ''}`)
    .join('\n');
  return `You are investigating why CI pipelines are failing on the pull request "${title}" (branch ${headRef}). The repository's base branch is checked out in the current directory.

RULES: you may read files, search, and run non-destructive commands (installs into the existing environment, builds, linters, test suites) to reproduce the failures locally. You must NOT modify, commit, or push anything.

## Failing pipelines
${list}

## PR diff
\`\`\`diff
${diff}
\`\`\`

## Your task
Figure out the most likely cause of each failing pipeline. Where practical, reproduce locally (e.g. run the linter or the test suite the check corresponds to) against the diff's changes. Reply with a concise markdown report:
1. **Verdict per failing check** — probable cause, evidence, and whether you reproduced it.
2. **Suggested fix** — concrete change(s) the author should make.
3. **Confidence** — high/medium/low per finding.`;
}
