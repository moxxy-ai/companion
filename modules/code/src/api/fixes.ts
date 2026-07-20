import type { SpaServerMessage } from '@companion/contracts';
import type { PromptAttachment } from '@companion/types';
import type { RunRecord } from '@companion/module-operate/contract';
import type { PrRecord } from '../contract/index.js';
import type { CodeStore } from './code-store.js';
import type { Orchestrator, RunnerBackend } from './operate-types.js';
import type { GitHubClient } from './github-client.js';
import type { PrChecks } from './pr-checks.js';

const MAX_DIFF_CHARS = 60_000;

/**
 * Fix-to-PR flows: a goal-mode agent works in a dedicated worktree; the human
 * reviews the diff; companiond (never the agent) pushes. Two shapes:
 * fresh-branch runs (fix an issue, implement a proposal) open a NEW PR on
 * approval; PR-branch runs (repair failing checks, address review feedback)
 * continue an EXISTING PR's branch and push straight to it.
 *
 * The worktree lives on the run's placed runner (local or remote): placement
 * happens up front, the worktree + clone are prepared through that runner's
 * backend, and diff/commit/push route back to the same backend so the whole
 * fix executes on one machine.
 */
export class Fixes {
  constructor(
    private readonly store: CodeStore,
    private readonly orchestrator: Orchestrator,
    private readonly github: (repo?: string) => GitHubClient | null,
    private readonly checks: PrChecks,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** Backend a completed/queued run's worktree lives on. */
  private backendForRun(runnerId: string | null): RunnerBackend {
    return this.orchestrator.runners.backend(runnerId);
  }

  async startFix(repo: string, issueNumber: number): Promise<RunRecord> {
    const issue = this.store.issues.get(repo, issueNumber);
    if (!issue) throw new Error(`unknown issue ${repo}#${issueNumber}`);
    const repoRow = this.store.repos.get(repo);
    if (!repoRow) throw new Error(`unknown repo ${repo}`);

    const run = await this.createGoalRun({
      kind: 'fix',
      title: `Fix #${issueNumber}: ${issue.title.slice(0, 60)}`,
      repo,
      issueNumber,
      branchPrefix: `companion/issue-${issueNumber}`,
      baseBranch: repoRow.default_branch,
      objective: fixObjective(issue.title, issue.body, issueNumber, repoRow.default_branch),
    });
    return run;
  }

  /**
   * Shared goal-run bootstrap for fixes and proposal implementations: place →
   * ensure clone + worktree on the chosen runner → run with cwd=worktree →
   * goal mode → objective prompt.
   */
  async createGoalRun(opts: {
    kind: 'fix' | 'implement';
    title: string;
    repo: string;
    issueNumber?: number | null;
    proposalId?: string | null;
    branchPrefix: string;
    baseBranch: string;
    objective: string;
    attachments?: readonly PromptAttachment[];
  }): Promise<RunRecord> {
    const suffix = Date.now().toString(36).slice(-4);
    const branch = `${opts.branchPrefix}-${suffix}`;
    const runnerId = this.orchestrator.placeRun(opts.repo, opts.kind);
    const backend = this.backendForRun(runnerId);
    await backend.ensureClone(opts.repo);
    const cwd = await backend.addWorktree(
      opts.repo,
      `${opts.kind}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      branch,
      opts.baseBranch,
    );

    const run = await this.orchestrator.createRun({
      kind: opts.kind,
      title: opts.title,
      runnerId,
      cwd,
      repo: opts.repo,
      issueNumber: opts.issueNumber ?? null,
      proposalId: opts.proposalId ?? null,
      branch,
    });

    await this.orchestrator.setGoalMode(run.id);
    await this.orchestrator.sendPrompt(run.id, opts.objective, undefined, opts.attachments);
    return this.orchestrator.getRun(run.id)!;
  }

  // ---------- PR-branch repair runs -----------------------------------------------

  /** Agent repairs the failing CI on a PR, working directly on its branch. */
  async startCheckFix(repo: string, prNumber: number): Promise<RunRecord> {
    const { pr, client } = this.requireOpenPr(repo, prNumber);
    const summary = await this.checks.fetchSummary(repo, prNumber);
    const failing = summary.runs.filter(
      (r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped',
    );
    if (failing.length === 0) throw new Error('no failing checks on this PR');
    const diff = await client.prDiff(repo, prNumber);
    return this.createPrBranchRun(
      pr,
      `Fix CI on PR #${prNumber}: ${pr.title.slice(0, 50)}`,
      checkFixObjective(pr, failing, clip(diff)),
    );
  }

  /** Agent implements the changes human reviewers asked for on a PR. */
  async startReviewFix(repo: string, prNumber: number): Promise<RunRecord> {
    const { pr, client } = this.requireOpenPr(repo, prNumber);
    const [reviews, inline] = await Promise.all([
      client.prReviewList(repo, prNumber),
      client.prReviewComments(repo, prNumber).catch(() => []),
    ]);
    const feedback = reviews
      .filter((r) => (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') && r.body?.trim())
      .map((r) => `Review by ${r.user?.login ?? 'reviewer'} (${r.state}):\n${r.body!.trim()}`);
    const comments = inline.map(
      (c) => `- ${c.path}:${c.line ?? c.original_line ?? '?'} (${c.user?.login ?? 'reviewer'}): ${c.body.trim()}`,
    );
    if (feedback.length === 0 && comments.length === 0) {
      throw new Error('no human review feedback found on this PR');
    }
    const diff = await client.prDiff(repo, prNumber);
    return this.createPrBranchRun(
      pr,
      `Address reviews on PR #${prNumber}: ${pr.title.slice(0, 45)}`,
      reviewFixObjective(pr, feedback, comments, clip(diff)),
    );
  }

  /** Agent merges the fresh base into the PR branch and resolves the conflicts. */
  async startConflictResolve(repo: string, prNumber: number): Promise<RunRecord> {
    const { pr, client } = this.requireOpenPr(repo, prNumber);
    // Re-check GitHub live — the sync cache can lag a manual resolution, and a
    // run launched then would push a pointless no-op merge commit. Fail open on
    // fetch trouble: the run itself discovers "already up to date".
    const live = await client.pull(repo, prNumber).catch(() => null);
    if (live && live.mergeable !== undefined) {
      this.store.prs.setMergeable(repo, prNumber, live.mergeable);
      this.broadcast({ t: 'prs.changed', repo });
      if (live.mergeable === true) throw new Error('GitHub reports no merge conflicts on this PR');
    }
    const diff = await this.contextDiff(client, repo, prNumber);
    return this.createPrBranchRun(
      pr,
      `Resolve conflicts on PR #${prNumber}: ${pr.title.slice(0, 45)}`,
      conflictObjective(pr, diff),
      // Merging against a stale base would "resolve" nothing — refresh origin.
      { freshOrigin: true },
    );
  }

  /** Agent works on the PR branch with a user-written objective. */
  async startCustomPrRun(repo: string, prNumber: number, instructions: string): Promise<RunRecord> {
    const { pr, client } = this.requireOpenPr(repo, prNumber);
    const diff = await this.contextDiff(client, repo, prNumber);
    const preview = instructions.trim().split('\n')[0]!.slice(0, 50);
    return this.createPrBranchRun(pr, `Agent on PR #${prNumber}: ${preview}`, customObjective(pr, instructions, diff));
  }

  /**
   * The PR diff as prompt context only — GitHub 406s the single-payload diff on
   * large PRs, and losing the context must not block the run itself.
   */
  private async contextDiff(client: GitHubClient, repo: string, prNumber: number): Promise<string> {
    const diff = await client.prDiff(repo, prNumber).catch(() => '(diff too large to include — read it from git)');
    return clip(diff);
  }

  private requireOpenPr(repo: string, prNumber: number): { pr: PrRecord; client: GitHubClient } {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    if (pr.state !== 'open') throw new Error(`PR #${prNumber} is ${pr.state}`);
    if (!pr.headRef) throw new Error('PR has no head branch');
    const client = this.github(repo);
    if (!client) throw new Error('GitHub is not configured');
    return { pr, client };
  }

  /** Worktree AT the PR head; the run carries the PR so approve pushes to it. */
  private async createPrBranchRun(
    pr: PrRecord,
    title: string,
    objective: string,
    opts: { freshOrigin?: boolean } = {},
  ): Promise<RunRecord> {
    const suffix = `${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 8)}`;
    const runnerId = this.orchestrator.placeRun(pr.repo, 'fix');
    const backend = this.backendForRun(runnerId);
    await backend.ensureClone(pr.repo);
    if (opts.freshOrigin) await backend.fetchOrigin(pr.repo);
    let cwd: string;
    try {
      cwd = await backend.addWorktreeAtBranch(pr.repo, `prfix-${suffix}`, pr.headRef);
    } catch (err) {
      // Only the checkout step earns the fork-branch diagnosis — clone/fetch
      // failures surface raw so a network blip isn't mislabelled.
      throw new Error(
        `could not check out ${pr.headRef} from origin — fork-branch PRs are not supported yet (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
      );
    }
    const run = await this.orchestrator.createRun({
      kind: 'fix',
      title,
      runnerId,
      cwd,
      repo: pr.repo,
      issueNumber: pr.number,
      branch: pr.headRef,
    });
    // The existing PR is this run's destination; approve() pushes to its
    // branch instead of opening a new one.
    this.store.runs.setPr(run.id, pr.headRef, pr.url);
    await this.orchestrator.setGoalMode(run.id);
    await this.orchestrator.sendPrompt(run.id, objective);
    return this.orchestrator.getRun(run.id)!;
  }

  async diff(runId: string): Promise<{ diff: string; branch: string | null }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo) throw new Error('run not found or not a repo run');
    const repoRow = this.store.repos.get(run.repo);
    // PR-branch runs diff against the PR head (only the agent's delta);
    // fresh-branch runs diff against the default branch.
    const base = run.pr_url && run.branch ? run.branch : (repoRow?.default_branch ?? 'main');
    const diff = await this.backendForRun(run.runner_id).diffVsBase(run.cwd, base);
    return { diff, branch: run.branch };
  }

  /**
   * Human approved the diff: commit leftovers and push. Runs bound to an
   * existing PR stop there; fresh-branch runs open the PR.
   */
  async approve(runId: string, opts: { title?: string; body?: string } = {}): Promise<{ prUrl: string }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo || !run.branch) throw new Error('run not found or has no branch');
    const repoRow = this.store.repos.get(run.repo);
    if (!repoRow) throw new Error(`unknown repo ${run.repo}`);
    const client = this.github(run.repo);
    if (!client) throw new Error('GitHub is not configured');

    const backend = this.backendForRun(run.runner_id);
    await backend.commitAll(run.cwd, opts.title ?? run.title);
    await backend.push(run.repo, run.cwd, run.branch);

    if (run.pr_url) {
      this.orchestrator.markRun(runId, 'completed', `pushed to ${run.branch} (${run.pr_url})`);
      await this.orchestrator.stopRun(runId).catch(() => undefined);
      this.broadcast({ t: 'runs.changed' });
      this.broadcast({ t: 'prs.changed', repo: run.repo });
      return { prUrl: run.pr_url };
    }

    const pr = await client.createPr(run.repo, {
      title: opts.title ?? run.title,
      head: run.branch,
      base: repoRow.default_branch,
      body:
        opts.body ??
        `${run.outcome ?? ''}\n\n${run.issue_number ? `Closes #${run.issue_number}.` : ''}`.trim(),
    });

    this.store.runs.setPr(runId, run.branch, pr.html_url);
    this.orchestrator.markRun(runId, 'completed', `PR opened: ${pr.html_url}`);
    // Stop the gateway; the worktree stays for post-merge cleanup.
    await this.orchestrator.stopRun(runId).catch(() => undefined);
    this.store.runs.updateStatus(runId, 'completed');
    this.broadcast({ t: 'runs.changed' });
    return { prUrl: pr.html_url };
  }

  /** Human rejected the work: stop the run and drop the worktree. */
  async discard(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error('run not found');
    await this.orchestrator.stopRun(runId).catch(() => undefined);
    if (run.repo && run.cwd.includes('worktrees')) {
      await this.backendForRun(run.runner_id).removeWorktree(run.repo, run.cwd).catch(() => undefined);
    }
    this.orchestrator.markRun(runId, 'abandoned', 'discarded by user');
  }
}

function clip(diff: string): string {
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
}

function checkFixObjective(
  pr: PrRecord,
  failing: ReadonlyArray<{ name: string; conclusion: string | null; detailsUrl: string | null }>,
  diff: string,
): string {
  const list = failing
    .map((f) => `- ${f.name}: ${f.conclusion ?? 'failed'}${f.detailsUrl ? ` (${f.detailsUrl})` : ''}`)
    .join('\n');
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). The PR's CI is failing; your job is to make it pass without changing what the PR intends to do.

## Failing pipelines
${list}

## The PR's diff (for context — this work is already on your branch)
\`\`\`diff
${diff}
\`\`\`

## Rules
- Work ONLY inside this worktree, on this branch.
- Reproduce the failures locally where practical (run the linter/build/test suite the failing check corresponds to), fix the causes minimally, and re-run to verify.
- Respect the PR's intent — repair it, don't rewrite it.
- Commit your work with clear messages (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a short summary: cause of each failure, what you changed, and how you verified it.`;
}

function reviewFixObjective(pr: PrRecord, feedback: readonly string[], comments: readonly string[], diff: string): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). Human reviewers asked for changes; implement them.

## Review feedback
${feedback.join('\n\n') || '(none beyond the inline comments)'}

## Inline comments (file:line)
${comments.join('\n') || '(none)'}

## The PR's diff (for context — this work is already on your branch)
\`\`\`diff
${diff}
\`\`\`

## Rules
- Work ONLY inside this worktree, on this branch.
- Address every piece of feedback; where a comment is ambiguous, pick the reading most consistent with the codebase and note the choice in your summary.
- Verify your changes (run relevant tests/builds where possible).
- Commit with clear messages (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a summary mapping each review comment to what you did about it.`;
}

function conflictObjective(pr: PrRecord, diff: string): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). The PR has merge conflicts against its target branch ${pr.baseRef}; your job is to resolve them so the PR merges cleanly, without changing what it intends to do.

## The PR's diff (for context — this work is already on your branch)
\`\`\`diff
${diff}
\`\`\`

## Rules
- Work ONLY inside this worktree, on this branch. All origin refs were fetched just now — do NOT fetch or pull.
- Run \`git merge origin/${pr.baseRef}\` and resolve every conflict by hand, preserving the intent of BOTH sides: keep what ${pr.baseRef} changed AND what this PR changes. Never resolve by wholesale taking one side.
- After resolving, verify the result compiles/passes (run the build or test suite where practical), then complete the merge commit (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a short summary: which files conflicted, how you resolved each, and how you verified the result.`;
}

function customObjective(pr: PrRecord, instructions: string, diff: string): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}, targeting ${pr.baseRef}). The maintainer asked you to do the following on this PR's branch.

## Task
${instructions.trim()}

## The PR's diff (for context — this work is already on your branch)
\`\`\`diff
${diff}
\`\`\`

## Rules
- Work ONLY inside this worktree, on this branch.
- Respect the PR's intent unless the task explicitly says otherwise.
- Verify your changes (run relevant tests/builds where possible).
- Commit your work with clear messages (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a short summary of what you did and how you verified it.`;
}

function fixObjective(title: string, body: string, issueNumber: number, baseBranch: string): string {
  return `You are an autonomous software engineer working in a dedicated git worktree (branch off origin/${baseBranch}). Fix the following GitHub issue.

## Issue #${issueNumber}: ${title}

${body || '(no description)'}

## Rules
- Work ONLY inside this worktree.
- Investigate the codebase, implement a minimal correct fix, and verify it (run existing tests or a quick check where possible).
- Commit your work with clear messages (git add + git commit). Do NOT push — the maintainer reviews the diff and pushes after approval.
- When the fix is complete and verified, finish with a short summary of what you changed and how you verified it.`;
}
