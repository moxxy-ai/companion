import { defineJobs } from '@companion/core/server';

let offSetupCompleted: (() => void) | null = null;

/**
 * The cross-module seams, wired at enable time: the account-aware
 * git-credential resolver is PLUGGED INTO the execution plane (inversion of
 * control — operate never imports code), the orchestrator's replay resumers
 * are registered before operate's postActivate resumes the persisted queue,
 * Disable restores operate's fail-closed token source, so a disabled code
 * module cannot leave stale personal credentials reachable.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const code = ctx.services.get('code');
    const operate = ctx.services.get('operate');

    // Git credentials for clones/worktrees/pushes and remote runner agents,
    // resolved per repo and owning profile — and
    // access-VERIFIED when several accounts compete, so the account that can
    // actually see the repo is the one that clones it.
    // Also feeds /api/status with the current request owner's GitHub identity.
    operate.setGithubTokenSource({
      tokenFor: (repo, username, access) =>
        repo
          ? code.githubAccounts.verifiedTokenFor('runs', repo, {
              ...(username === undefined ? {} : { username }),
              // git only knows read vs write; map onto the RBAC ladder here.
              need: access === 'write' ? 'push' : 'pull',
            })
          : (code.githubAccounts.tokenFor('runs', username === undefined ? undefined : { username }) ?? null),
      login: () => code.githubAccounts.loginFor('fetch'),
    });

    // A clean install has no admin while services boot. First-boot onboarding
    // creates that admin later, so retry the host gh import at that exact
    // lifecycle edge instead of requiring a daemon restart.
    offSetupCompleted = ctx.bus.on('auth.setup.completed', ({ username }) => {
      if (ctx.services.get('core').primaryAdminUsername() !== username) return;
      void code.importLocalGhAccount();
    });

    // Replay unattended work that was still queued when the daemon last
    // stopped (legacy index.ts resumers). Each resumer rebuilds the prompt
    // from stored args and re-enqueues fresh; operate's postActivate calls
    // resumePersistedQueue after ALL modules' onEnable, so these are in place.
    const num = (a: Record<string, unknown>, k: string): number => Number(a[k]);
    const str = (a: Record<string, unknown>, k: string): string => String(a[k]);
    operate.orchestrator.registerResumer('triage', (a) =>
      code.triage.triageIssue(str(a, 'repo'), num(a, 'number'), str(a, 'userId')),
    );
    operate.orchestrator.registerResumer('pr-review', (a) =>
      code.prReviews.analyzePr(
        str(a, 'repo'),
        num(a, 'number'),
        str(a, 'userId'),
        typeof a.context === 'string' ? { context: a.context } : undefined,
      ),
    );
    operate.orchestrator.registerResumer('ci-analysis', (a) =>
      code.prReviews.analyzeFailedChecks(str(a, 'repo'), num(a, 'number'), str(a, 'userId')),
    );

  },
  onDisable: (ctx) => {
    offSetupCompleted?.();
    offSetupCompleted = null;
    // Unplug our account-aware resolver; operate then fails network Git closed.
    ctx.services.get('operate').resetGithubTokenSource();
  },
});
