import { defineJobs } from '@companion/core/server';

/**
 * The cross-module seams, wired at enable time: the account-aware
 * git-credential resolver is PLUGGED INTO the execution plane (inversion of
 * control — operate never imports code), the orchestrator's replay resumers
 * are registered before operate's postActivate resumes the persisted queue,
 * and the GitHub poller starts. Disable stops the poller AND restores operate's
 * default token source, so a disabled/uninstalled code module's account
 * registry no longer governs clones/pushes.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const code = ctx.services.get('code');
    const operate = ctx.services.get('operate');

    // Git credentials for clones/worktrees/pushes and remote runner agents,
    // resolved per repo so account pins and workspace delegation apply — and
    // access-VERIFIED when several accounts compete, so the account that can
    // actually see the repo is the one that clones it.
    // Mirrors the legacy githubTokenFor closure + the /api/status github fields.
    operate.setGithubTokenSource({
      tokenFor: (repo) =>
        repo ? code.githubAccounts.verifiedTokenFor('runs', repo) : (code.githubAccounts.tokenFor('runs') ?? null),
      login: () => {
        const list = code.githubAccounts.list();
        return (
          (list.find((a) => a.ownerId === null && a.purposes.includes('fetch')) ??
            list.find((a) => a.purposes.includes('fetch')))?.login ?? null
        );
      },
    });

    // Replay unattended work that was still queued when the daemon last
    // stopped (legacy index.ts resumers). Each resumer rebuilds the prompt
    // from stored args and re-enqueues fresh; operate's postActivate calls
    // resumePersistedQueue after ALL modules' onEnable, so these are in place.
    const num = (a: Record<string, unknown>, k: string): number => Number(a[k]);
    const str = (a: Record<string, unknown>, k: string): string => String(a[k]);
    operate.orchestrator.registerResumer('triage', (a) => code.triage.triageIssue(str(a, 'repo'), num(a, 'number')));
    operate.orchestrator.registerResumer('pr-review', (a) =>
      code.prReviews.analyzePr(str(a, 'repo'), num(a, 'number'), typeof a.context === 'string' ? { context: a.context } : undefined),
    );
    operate.orchestrator.registerResumer('ci-analysis', (a) =>
      code.prReviews.analyzeFailedChecks(str(a, 'repo'), num(a, 'number')),
    );

    code.sync.start();
  },
  onDisable: (ctx) => {
    ctx.services.get('code').sync.stop();
    // Unplug our account-aware resolver so operate falls back to its built-in
    // settings-key source (our github_accounts table may be uninstalled next).
    ctx.services.get('operate').resetGithubTokenSource();
  },
});
