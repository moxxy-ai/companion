import type { SpaServerMessage } from '@companion/contracts';
import type { PromptAttachment } from '@companion/types';
import type { RunRecord } from '@companion/module-operate/contract';
import type { PrRecord } from '../contract/index.js';
import type { CodeStore } from './code-store.js';
import type { Orchestrator, RunnerBackend } from './operate-types.js';
import type { GitHubClient } from './github-client.js';
import type { PrChecks } from './pr-checks.js';

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
    private readonly github: (repo?: string, username?: string | null) => GitHubClient | null,
    private readonly verifyGithub: (repo: string, username: string) => Promise<boolean>,
    /** Account that may actually PUSH to the repo — resolved once per approval
     *  so the branch and the PR it opens come from the same identity. */
    private readonly pushClient: (
      repo: string,
      username: string,
    ) => Promise<{ client: GitHubClient | null; tried: string[] }>,
    private readonly checks: PrChecks,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** Backend a completed/queued run's worktree lives on. */
  private backendForRun(runnerId: string | null): RunnerBackend {
    return this.orchestrator.runners.backend(runnerId);
  }

  async startFix(repo: string, issueNumber: number, userId: string | null = null): Promise<RunRecord> {
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
      userId,
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
    /** Triggering user — unlocks their personal runners for placement. */
    userId?: string | null;
    /** Feature task id for runner filtering (e.g. 'board.worker'); defaults by kind. */
    task?: string;
  }): Promise<RunRecord> {
    await this.requirePersonalAccess(opts.repo, opts.userId);
    const suffix = Date.now().toString(36).slice(-4);
    const branch = `${opts.branchPrefix}-${suffix}`;
    const task = opts.task ?? (opts.kind === 'fix' ? 'code.fix' : 'code.implement');
    const runnerId = this.orchestrator.placeRun(opts.repo, opts.kind, { userId: opts.userId, task });
    const backend = this.backendForRun(runnerId);
    await backend.ensureClone(opts.repo, opts.userId);
    const cwd = await backend.addWorktree(
      opts.repo,
      `${opts.kind}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      branch,
      opts.baseBranch,
      opts.userId,
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
      userId: opts.userId ?? null,
      task,
    });

    await this.orchestrator.setGoalMode(run.id);
    await this.orchestrator.sendPrompt(run.id, opts.objective, undefined, opts.attachments);
    return this.orchestrator.getRun(run.id)!;
  }

  // ---------- PR-branch repair runs -----------------------------------------------

  /** Agent repairs the failing CI on a PR, working directly on its branch. */
  async startCheckFix(repo: string, prNumber: number, userId: string | null = null, task?: string): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr } = this.requireOpenPr(repo, prNumber, userId);
    const summary = await this.checks.fetchSummary(repo, prNumber, userId!);
    const failing = summary.runs.filter(
      (r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped',
    );
    if (failing.length === 0) throw new Error('no failing checks on this PR');
    return this.createPrBranchRun(
      pr,
      `Fix CI on PR #${prNumber}: ${pr.title.slice(0, 50)}`,
      checkFixObjective(pr, failing),
      { userId, task },
    );
  }

  /** Agent implements the changes human reviewers asked for on a PR. */
  async startReviewFix(repo: string, prNumber: number, userId: string | null = null, task?: string): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr, client } = this.requireOpenPr(repo, prNumber, userId);
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
    return this.createPrBranchRun(
      pr,
      `Address reviews on PR #${prNumber}: ${pr.title.slice(0, 45)}`,
      reviewFixObjective(pr, feedback, comments),
      { userId, task },
    );
  }

  /** Agent merges the fresh base into the PR branch and resolves the conflicts. */
  async startConflictResolve(repo: string, prNumber: number, userId: string | null = null): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr, client } = this.requireOpenPr(repo, prNumber, userId);
    // Re-check GitHub live — the sync cache can lag a manual resolution, and a
    // run launched then would push a pointless no-op merge commit. Fail open on
    // fetch trouble: the run itself discovers "already up to date".
    const live = await client.pull(repo, prNumber).catch(() => null);
    if (live && live.mergeable !== undefined) {
      this.store.prs.setMergeable(repo, prNumber, live.mergeable);
      this.broadcast({ t: 'prs.changed', repo });
      if (live.mergeable === true) throw new Error('GitHub reports no merge conflicts on this PR');
    }
    return this.createPrBranchRun(
      pr,
      `Resolve conflicts on PR #${prNumber}: ${pr.title.slice(0, 45)}`,
      conflictObjective(pr),
      { userId },
    );
  }

  /** Agent works on the PR branch with a user-written objective. */
  async startCustomPrRun(repo: string, prNumber: number, instructions: string, userId: string | null = null): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr } = this.requireOpenPr(repo, prNumber, userId);
    const preview = instructions.trim().split('\n')[0]!.slice(0, 50);
    return this.createPrBranchRun(pr, `Agent on PR #${prNumber}: ${preview}`, customObjective(pr, instructions), {
      userId,
    });
  }

  private requireOpenPr(
    repo: string,
    prNumber: number,
    username?: string | null,
  ): { pr: PrRecord; client: GitHubClient } {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    if (pr.state !== 'open') throw new Error(`PR #${prNumber} is ${pr.state}`);
    if (!pr.headRef) throw new Error('PR has no head branch');
    const client = this.github(repo, username);
    if (!client) throw new Error('GitHub is not configured');
    return { pr, client };
  }

  /** Worktree AT the PR head; the run carries the PR so approve pushes to it. */
  private async createPrBranchRun(
    pr: PrRecord,
    title: string,
    objective: string,
    opts: { userId?: string | null; task?: string } = {},
  ): Promise<RunRecord> {
    await this.requirePersonalAccess(pr.repo, opts.userId);
    const suffix = `${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 8)}`;
    const task = opts.task ?? 'code.fix';
    const runnerId = this.orchestrator.placeRun(pr.repo, 'fix', { userId: opts.userId, task });
    const backend = this.backendForRun(runnerId);
    await backend.ensureClone(pr.repo, opts.userId);
    // The objective inspects the full PR locally; refresh the base and head refs
    // before creating the worktree so a large diff never needs prompt embedding.
    await backend.fetchOrigin(pr.repo, opts.userId);
    let cwd: string;
    try {
      cwd = await backend.addWorktreeAtBranch(pr.repo, `prfix-${suffix}`, pr.headRef, opts.userId);
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
      userId: opts.userId ?? null,
      task,
    });
    // The existing PR is this run's destination; approve() pushes to its
    // branch instead of opening a new one.
    this.store.runs.setPr(run.id, pr.headRef, pr.url);
    await this.orchestrator.setGoalMode(run.id);
    await this.orchestrator.sendPrompt(run.id, objective);
    return this.orchestrator.getRun(run.id)!;
  }

  async diff(runId: string, baseBranch?: string): Promise<{ diff: string; branch: string | null }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo) throw new Error('run not found or not a repo run');
    const repoRow = this.store.repos.get(run.repo);
    // PR-branch runs diff against the PR head (only the agent's delta);
    // fresh-branch runs diff against the default branch.
    const base = run.pr_url && run.branch ? run.branch : (baseBranch ?? repoRow?.default_branch ?? 'main');
    const diff = await this.backendForRun(run.runner_id).diffVsBase(run.cwd, base);
    return { diff, branch: run.branch };
  }

  /**
   * Human approved the diff: commit leftovers and push. Runs bound to an
   * existing PR stop there; fresh-branch runs open the PR.
   */
  async approve(
    runId: string,
    opts: { title?: string; body?: string; baseBranch?: string } = {},
    actorUsername?: string | null,
  ): Promise<{ prUrl: string }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo || !run.branch) throw new Error('run not found or has no branch');
    const repoRow = this.store.repos.get(run.repo);
    if (!repoRow) throw new Error(`unknown repo ${run.repo}`);
    // An interactive approver acts as themselves, never as the user who
    // originally created the run. Internal continuations omit the override and
    // remain bound to the persisted run owner.
    const credentialOwner = actorUsername === undefined ? run.user_id : actorUsername;
    // Write access is settled BEFORE anything is committed or pushed: a
    // read-only account would otherwise reach git and fail with GitHub's
    // opaque 403 after the agent already did all the work.
    const client = await this.requirePushAccess(run.repo, credentialOwner);

    const backend = this.backendForRun(run.runner_id);
    await backend.commitAll(run.cwd, opts.title ?? run.title);
    await backend.push(run.repo, run.cwd, run.branch, credentialOwner);

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
      base: opts.baseBranch ?? repoRow.default_branch,
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

  private async requirePersonalAccess(repo: string, username?: string | null): Promise<void> {
    if (!username || !(await this.verifyGithub(repo, username))) {
      throw new Error(`your GitHub accounts cannot access ${repo} — ask the repository owner to grant access`);
    }
  }

  /** The client of an account that may push here, or a diagnosis naming the
   *  accounts that were tried and rejected. */
  private async requirePushAccess(repo: string, username?: string | null): Promise<GitHubClient> {
    if (!username) throw new Error(`no GitHub account owner for ${repo} — the run has no owning profile`);
    const { client, tried } = await this.pushClient(repo, username);
    if (!client) {
      throw new Error(
        `no connected GitHub account can push to ${repo}` +
          (tried.length ? ` (tried ${tried.join(', ')})` : '') +
          ' — grant that account write access, or connect one that has it',
      );
    }
    return client;
  }
}

function checkFixObjective(
  pr: PrRecord,
  failing: ReadonlyArray<{ name: string; conclusion: string | null; detailsUrl: string | null }>,
): string {
  const list = failing
    .map((f) => `- ${f.name}: ${f.conclusion ?? 'failed'}${f.detailsUrl ? ` (${f.detailsUrl})` : ''}`)
    .join('\n');
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). The PR's CI is failing; your job is to make it pass without changing what the PR intends to do.

## Failing pipelines
${list}

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch.
- Reproduce the failures locally where practical (run the linter/build/test suite the failing check corresponds to), fix the causes minimally, and re-run to verify.
- Respect the PR's intent — repair it, don't rewrite it.
- Commit your work with clear messages (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a short summary: cause of each failure, what you changed, and how you verified it.`;
}

function reviewFixObjective(pr: PrRecord, feedback: readonly string[], comments: readonly string[]): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). Human reviewers asked for changes; implement them.

## Review feedback
${feedback.join('\n\n') || '(none beyond the inline comments)'}

## Inline comments (file:line)
${comments.join('\n') || '(none)'}

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch.
- Address every piece of feedback; where a comment is ambiguous, pick the reading most consistent with the codebase and note the choice in your summary.
- Verify your changes (run relevant tests/builds where possible).
- Commit with clear messages (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a summary mapping each review comment to what you did about it.`;
}

function conflictObjective(pr: PrRecord): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). The PR has merge conflicts against its target branch ${pr.baseRef}; your job is to resolve them so the PR merges cleanly, without changing what it intends to do.

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch. All origin refs were fetched just now — do NOT fetch or pull.
- Run \`git merge origin/${pr.baseRef}\` and resolve every conflict by hand, preserving the intent of BOTH sides: keep what ${pr.baseRef} changed AND what this PR changes. Never resolve by wholesale taking one side.
- After resolving, verify the result compiles/passes (run the build or test suite where practical), then complete the merge commit (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a short summary: which files conflicted, how you resolved each, and how you verified the result.`;
}

function customObjective(pr: PrRecord, instructions: string): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}, targeting ${pr.baseRef}). The maintainer asked you to do the following on this PR's branch.

## Task
${instructions.trim()}

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch.
- Respect the PR's intent unless the task explicitly says otherwise.
- Verify your changes (run relevant tests/builds where possible).
- Commit your work with clear messages (git add + git commit). Do NOT push — the maintainer reviews the delta and pushes after approval.
- Finish with a short summary of what you did and how you verified it.`;
}

function prDiffInspectionGuide(baseRef: string): string {
  return `## Inspecting the complete PR
The worktree is at the exact PR head and \`origin/${baseRef}\` was refreshed. Inspect the complete existing change locally; no prompt-sized diff was provided.

- Start with \`git diff --stat origin/${baseRef}...HEAD\`, \`git diff --numstat origin/${baseRef}...HEAD\`, and \`git diff --name-only origin/${baseRef}...HEAD\`.
- Inspect relevant files in bounded groups with \`git diff origin/${baseRef}...HEAD -- <path>...\`; do not dump an oversized whole-PR diff into one tool call.
- If collaboration/subagent tools are available, delegate read-only investigation of disjoint file groups and synthesize the evidence before editing. Do not assume delegation exists.`;
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
