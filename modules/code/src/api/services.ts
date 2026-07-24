import { defineServices } from '@companion/core/server';
import { ReposStore } from './repos-store.js';
import { IssuesStore } from './issues-store.js';
import { PrsStore } from './prs-store.js';
import { TriageStore } from './triage-store.js';
import { PrReviewsStore } from './pr-reviews-store.js';
import { PipelinesStore } from './pipelines-store.js';
import { GithubAccountsStore } from './github-accounts-store.js';
import { CodeStore } from './code-store.js';
import { GitHubAccounts } from './github-accounts.js';
import { GitHubSync } from './github-sync.js';
import { PrChecks } from './pr-checks.js';
import { Triage } from './triage.js';
import { PrReviews } from './pr-reviews.js';
import { Fixes } from './fixes.js';
import { Pipelines, type SlopGateService } from './pipelines.js';
import { CodeService } from './code-service.js';
import { readActiveLocalGhAccount } from './local-gh-account.js';

/**
 * Construct the GitHub/code domain: the sync-cache stores, the narrow store
 * facade, the personal multi-account registry, request-owned sync + CI checks,
 * and the triage/review/fix/pipeline
 * services — then publish the bundle as `code`. Wiring mirrors the legacy
 * composition root's construction order; the git-credential seam into operate
 * is plugged in at onEnable (jobs.ts), not here.
 */
export default defineServices((ctx) => {
  const settings = ctx.services.get('settings');
  const workspace = ctx.services.get('workspace');
  const operate = ctx.services.get('operate');

  // The feature tasks this module runs agents for, so runners can block them.
  operate.registerRunTask({ id: 'code.fix', label: 'Fix runs', placeable: true, hint: 'issue fixes and PR repairs — worktree goal runs' });
  operate.registerRunTask({ id: 'code.implement', label: 'Implement runs', placeable: true, hint: 'proposal implementations — worktree goal runs' });
  operate.registerRunTask({ id: 'code.triage', label: 'Issue triage', placeable: false });
  operate.registerRunTask({ id: 'code.pr-review', label: 'PR reviews', placeable: false });
  operate.registerRunTask({ id: 'code.ci-analysis', label: 'CI analyses', placeable: false });
  operate.registerRunTask({ id: 'code.pipeline', label: 'Pipeline agents', placeable: false });

  // Adopt orphan repos into the oldest workspace — the legacy second half of
  // workspace's ensureDefault(), relocated to the repos owner (our migration
  // has just run, and workspace's table migrated before ours in topo order).
  ctx.db
    .prepare(
      `UPDATE repos SET workspace_id =
         (SELECT id FROM workspaces ORDER BY created_at LIMIT 1)
       WHERE workspace_id IS NULL`,
    )
    .run();
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO repo_workspaces (repo, workspace_id, created_at)
       SELECT full_name, workspace_id, ? FROM repos WHERE workspace_id IS NOT NULL`,
    )
    .run(Date.now());

  // Stores, in the legacy store/db.ts construction order.
  const triageStore = new TriageStore(ctx.db);
  const prReviewsStore = new PrReviewsStore(ctx.db);
  const githubAccountsStore = new GithubAccountsStore(ctx.db);
  const reposStore = new ReposStore(ctx.db, workspace);
  const issuesStore = new IssuesStore(ctx.db, triageStore, githubAccountsStore);
  const prsStore = new PrsStore(ctx.db, prReviewsStore, githubAccountsStore);
  const pipelinesStore = new PipelinesStore(ctx.db);

  const store = new CodeStore({
    repos: reposStore,
    issues: issuesStore,
    prs: prsStore,
    triage: triageStore,
    prReviews: prReviewsStore,
    pipelines: pipelinesStore,
    githubAccounts: githubAccountsStore,
    settings,
    workspaces: workspace,
    runs: operate.runsStore,
    // module-workspace registers below code in the dependency order, so the
    // reports store is always present when code is enabled.
    reports: ctx.services.get('reports'),
    notify: ctx.notify,
  });

  // GitHub accounts registry: each PAT is bound to purposes (fetch, runs,
  // pipelines, webhooks); consumers resolve a client per purpose and owner.
  // An unowned legacy token is intentionally never adopted.
  const ghAccounts = new GitHubAccounts(store);
  ghAccounts.migrateLegacyToken();
  const importActiveLocalGh = async (): Promise<boolean> => {
    const primaryAdmin = ctx.services.get('core').primaryAdminUsername();
    if (!primaryAdmin) return false;
    const localGh = await readActiveLocalGhAccount();
    if (!localGh) return false;
    try {
      const connected = await ghAccounts.add(
        localGh.token,
        ['fetch', 'runs', 'pipelines', 'webhooks'],
        primaryAdmin,
        'all',
      );
      ctx.log.info('connected active local gh account to primary admin', {
        githubLogin: connected.login,
        username: primaryAdmin,
      });
      ctx.broadcast({ t: 'repos.changed' });
      return true;
    } catch (err) {
      ctx.log.warn('could not connect active local gh account to primary admin', {
        expectedGithubLogin: localGh.login,
        username: primaryAdmin,
        err: String(err),
      });
      return false;
    }
  };

  const sync = new GitHubSync(
    store,
    async (repo, workspaceId, username) => {
      const { client } = await ghAccounts.verifiedClientFor('fetch', repo, { workspaceId, username });
      return client;
    },
    ctx.broadcast,
  );
  const prChecks = new PrChecks(
    store,
    (repo, username) => ghAccounts.clientFor('fetch', { repo, username }),
    ctx.broadcast,
  );
  // Every sync also refreshes CI snapshots for the repo's freshest open PRs.
  sync.onSynced = (repo, username) => prChecks.refreshOpenPrs(repo, username);

  const triage = new Triage(
    store,
    operate.orchestrator,
    operate.checkouts,
    (c) => ghAccounts.clientFor('pipelines', c),
    ctx.broadcast,
  );
  const prReviews = new PrReviews(
    store,
    operate.orchestrator,
    operate.checkouts,
    (c) => ghAccounts.clientFor('pipelines', c),
    // Merging is a write action: skip accounts that can only read the repo
    // rather than burning a failover round on a guaranteed 403.
    (repo, prNumber, method, c) =>
      ghAccounts.performForRepo('pipelines', repo, (client) => client.mergePr(repo, prNumber, method), {
        ...c,
        need: 'push',
      }),
    prChecks,
    ctx.broadcast,
  );
  const fixes = new Fixes(
    store,
    operate.orchestrator,
    (repo, username) =>
      ghAccounts.clientFor(
        'runs',
        repo
          ? { repo, ...(username === undefined ? {} : { username }) }
          : username === undefined
            ? undefined
            : { username },
      ),
    async (repo, username) =>
      (await ghAccounts.verifiedClientFor('runs', repo, { username })).client !== null,
    (repo, username) => ghAccounts.verifiedClientFor('runs', repo, { username, need: 'push' }),
    prChecks,
    ctx.broadcast,
  );
  const pipelines = new Pipelines(
    {
      store,
      orchestrator: operate.orchestrator,
      checkouts: operate.checkouts,
      github: (c) => ghAccounts.clientFor('pipelines', c),
      checks: prChecks,
      reviews: prReviews,
      // Reverse-direction soft dep: module-slop augments ServiceMap in ITS
      // contract, which code cannot import (slop dependsOn code) — so the key
      // is invisible to this compilation and the lookup goes through a cast.
      // The structural SlopGateService seam keeps the shape honest.
      slop: () =>
        ((ctx.services.tryGet.bind(ctx.services) as (key: string) => unknown)('slop') as
          | SlopGateService
          | undefined) ?? null,
    },
    ctx.broadcast,
  );

  const code = new CodeService(
    reposStore,
    issuesStore,
    prsStore,
    ghAccounts,
    sync,
    triage,
    prReviews,
    prChecks,
    fixes,
    pipelines,
    importActiveLocalGh,
  );
  ctx.services.register('code', code);
  // Host integration is opportunistic and must never delay the daemon boot.
  // The account page refreshes from repos.changed once validation completes.
  void code.importLocalGhAccount();
});
