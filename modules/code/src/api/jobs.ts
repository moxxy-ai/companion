import { defineJobs, type ModuleContext } from '@moxxy/companion-sdk/server';
import type { TokenRefreshResult } from './github-accounts.js';
import { PrReviewsStore } from './pr-reviews-store.js';
import { TriageStore } from './triage-store.js';
import { PipelinesStore } from './pipelines-store.js';
import { createRepoScopeResolver, createStepOutputScopeResolver } from './ws-scope.js';

const DAY_MS = 24 * 60 * 60_000;

/** A declared retention window, floored to its manifest default on bad input. */
function retentionDays(ctx: ModuleContext, key: string, fallback: number): number {
  const value = Number(ctx.moduleConfig.get(key) ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let offSetupCompleted: (() => void) | null = null;
let offNativeReviewProvider: (() => void) | null = null;
let offWorkspaceDeleted: (() => void) | null = null;

/**
 * Surface a credential going bad, and coming back.
 *
 * This is the gap `docs/internal/open-items.md` §1 named: an app uninstalled on GitHub
 * left the account holding a dead token until a human read a log line or a call
 * failed over. Refresh runs every ten minutes, so the emit has to be driven by
 * the TRANSITION the refresh reports, never by the current state, or an outage
 * would post 144 times a day.
 *
 * Instance-wide (no workspace): a credential is not a workspace's property, and
 * scoping it to one would hide it from everybody else.
 */
function announceCredentialHealth(ctx: ModuleContext, result: TokenRefreshResult): void {
  for (const fault of result.started) {
    ctx.notify.emit({
      workspaceId: null,
      kind: 'error',
      title: `GitHub App '${fault.login}' can no longer refresh its token`,
      body:
        `${fault.error ?? 'the refresh failed'}. Agent runs and sync using this account will start failing when the ` +
        'current token expires. Check the app is still installed on the organisation and that its private key is current.',
      href: '#/github',
    });
  }
  for (const fault of result.recovered) {
    ctx.notify.emit({
      workspaceId: null,
      kind: 'info',
      title: `GitHub App '${fault.login}' is refreshing again`,
      body: 'Its installation token was re-minted successfully.',
      href: '#/github',
    });
  }
}

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

    offNativeReviewProvider?.();
    offNativeReviewProvider = ctx.services.get('integrations').registerProvider({
      descriptor: {
        id: 'companion.native-review',
        moduleId: 'code',
        vendor: 'Companion',
        title: 'Companion AI review',
        description: 'Companion-managed, evidence-backed review with chunking, verification and review-then-apply.',
        category: 'review',
        capabilities: ['code-review'],
        scopes: ['instance', 'workspace', 'repository'],
        connectionMode: 'none',
        execution: 'local',
        fields: [],
        defaultFor: ['code-review'],
      },
      // PrReviews owns the native orchestration because it needs authenticated
      // run admission and durable child-run state. The callback keeps the open
      // provider contract honest if another module tries to execute it directly.
      review: async () => {
        throw new Error('Companion native review must be launched through the code service');
      },
    });

    // Aggregate review rows are separate from their child operate runs. Mark
    // the old process's live rows failed before durable queue entries replay as
    // fresh reviews, otherwise the PR page shows two jobs still running.
    code.prReviews.recoverInterrupted();
    code.triage.recoverInterrupted();

    // Live command output is owner-private: the hub broadcasts anything no
    // resolver claims, and this message carries a command's raw stdout. Team
    // members replay the scrubbed tail through the authenticated REST route.
    ctx.ws.registerScopeResolver('code.stepOutput', createStepOutputScopeResolver());
    ctx.ws.registerScopeResolver('code.repo', createRepoScopeResolver(ctx));

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
      // Everyone gets the health dot; only whoever may manage GitHub accounts
      // gets the name behind it. /api/status is open to every role, so without
      // this the instance posting identity leaks to business profiles.
      canSeeLogin: (viewer) => ctx.rbac.allows(viewer, 'github:connect'),
      // Catalogue, not resolution: a workspace-scoped account is still an
      // account, and the instance health dot must not turn red because of how
      // one is scoped.
      hasAccounts: () => code.githubAccounts.list().length > 0,
    });

    // Pre-review verification: operate owns the execution (it has the runner and
    // the worktree), code owns the command (it owns repositories). Same inversion
    // as the git token source above; operate never imports code.
    operate.setVerifyCommandResolver((repo) => code.repos.get(repo)?.verify_command ?? null);
    operate.setWorkspaceForRepo((repo) => code.repos.get(repo)?.workspace_id ?? null);

    // A clean install has no admin while services boot. First-boot onboarding
    // creates that admin later, so retry the host gh import at that exact
    // lifecycle edge instead of requiring a daemon restart.
    offSetupCompleted = ctx.bus.on('auth.setup.completed', ({ username }) => {
      if (ctx.services.get('core').primaryAdminUsername() !== username) return;
      void code.importLocalGhAccount();
    });

    // These tables are code-owned, so their workspace-delete cleanup lives with
    // their owner; the signal is soft, so a disabled code module just leaves
    // rows that its own retention or a later delete would remove.
    offWorkspaceDeleted = ctx.bus.on('workspace.deleted', ({ workspaceId }) => {
      code.pipelines.removeForWorkspace(workspaceId);
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
    // Every option the review ran with is replayed: a resumed review that
    // silently reverted to the defaults would return a different verdict than
    // the one the user asked for.
    operate.orchestrator.registerResumer('pr-review', (a) =>
      code.prReviews.analyzePr(str(a, 'repo'), num(a, 'number'), str(a, 'userId'), {
        ...(typeof a.context === 'string' ? { context: a.context } : {}),
        ...(a.depth === 'high-level' || a.depth === 'in-depth' ? { depth: a.depth } : {}),
        ...(a.strictness === 'blockers-only' || a.strictness === 'balanced' || a.strictness === 'pedantic'
          ? { strictness: a.strictness }
          : {}),
        ...(typeof a.verify === 'boolean' ? { verify: a.verify } : {}),
        ...(typeof a.workspaceId === 'string' ? { workspaceId: a.workspaceId } : {}),
        ...(typeof a.providerId === 'string'
          ? {
              provider: {
                providerId: a.providerId,
                connectionId: typeof a.connectionId === 'string' ? a.connectionId : null,
              },
            }
          : {}),
      }),
    );
    operate.orchestrator.registerResumer('ci-analysis', (a) =>
      code.prReviews.analyzeFailedChecks(str(a, 'repo'), num(a, 'number'), str(a, 'userId')),
    );

  },
  /**
   * Installation tokens last an hour, so they are re-minted well before that.
   * The margin must exceed the interval: a single failed run then still leaves
   * a valid token and another attempt before anything expires.
   */
  jobs: [
    {
      id: 'code.github-app-tokens',
      everyMs: 10 * 60_000,
      run: async (ctx) => {
        const result = await ctx.services
          .get('code')
          .githubAccounts.refreshInstallationTokens(25 * 60_000, (msg) => ctx.log.warn(msg));
        if (result.refreshed) ctx.log.info(`refreshed ${result.refreshed} GitHub App installation token(s)`);
        announceCredentialHealth(ctx, result);
      },
    },
    {
      // Verdict/run history had no age bound and review/pipeline rows carry up
      // to ~200KB of step output each. Each store's prune is bounded per sweep
      // and always keeps the newest result per surface, whatever its age.
      id: 'code.history.prune',
      everyMs: DAY_MS,
      run: (ctx) => {
        const sweeps = [
          ['reviews', new PrReviewsStore(ctx.db).prune(retentionDays(ctx, 'reviewRetentionDays', 180) * DAY_MS)],
          ['triage', new TriageStore(ctx.db).prune(retentionDays(ctx, 'triageRetentionDays', 180) * DAY_MS)],
          ['pipeline runs', new PipelinesStore(ctx.db).pruneRuns(retentionDays(ctx, 'pipelineRunRetentionDays', 180) * DAY_MS)],
        ] as const;
        for (const [what, removed] of sweeps) {
          if (removed > 0) ctx.log.info(`code history: pruned ${removed} superseded ${what} row(s)`);
        }
      },
    },
  ],
  /** A daemon down longer than an hour wakes with every app token expired. */
  postActivate: async (ctx) => {
    const result = await ctx.services
      .get('code')
      .githubAccounts.refreshInstallationTokens(25 * 60_000, (msg) => ctx.log.warn(msg));
    announceCredentialHealth(ctx, result);
  },
  onDisable: async (ctx) => {
    // Persist interrupted pipeline evidence and stop its queued/running
    // children while the raw-output scope is still installed.
    await ctx.services.get('code').pipelines.shutdown();
    ctx.ws.unregisterScopeResolver('code.stepOutput');
    ctx.ws.unregisterScopeResolver('code.repo');
    offSetupCompleted?.();
    offSetupCompleted = null;
    offNativeReviewProvider?.();
    offNativeReviewProvider = null;
    offWorkspaceDeleted?.();
    offWorkspaceDeleted = null;
    // Unplug our account-aware resolver; operate then fails network Git closed.
    ctx.services.get('operate').resetGithubTokenSource();
  },
});
