import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { loadDaemonConfig, paths } from './config.js';
import { detectMoxxyCli, MIN_MOXXY_VERSION } from './moxxy/cli.js';
import { healCredentialLinks, seedPermissionDenyRules } from './moxxy/home.js';
import { Auth } from './auth/auth.js';
import { Orchestrator } from './runs/orchestrator.js';
import { Fixes } from './runs/fixes.js';
import { Store } from './store/db.js';
import { SpaHub } from './http/spa-ws.js';
import { startHttpServer } from './http/server.js';
import { GitHubClient } from './github/client.js';
import { GitHubAccounts } from './github/accounts.js';
import { GitHubSync } from './github/sync.js';
import { Checkouts } from './git/checkouts.js';
import { Triage } from './triage/triage.js';
import { PrReviews } from './prs/reviews.js';
import { PrChecks } from './prs/checks.js';
import { Proposals } from './proposals/proposals.js';
import { Pipelines } from './pipelines/pipelines.js';
import { Automations } from './automations/automations.js';
import { Skills } from './skills/skills.js';

async function main(): Promise<void> {
  const config = loadDaemonConfig();
  seedPermissionDenyRules();
  healCredentialLinks();
  log.info(`accounts: ${config.users.map((u) => `${u.username} (${u.role})`).join(', ')}`);
  log.info(`default agent model: ${config.defaultModel}`);

  const moxxyCli = await detectMoxxyCli(paths.moxxyHome(), config.moxxyCliPath);
  if (!moxxyCli) {
    log.warn(
      `moxxy CLI not found on PATH — install it with: npm i -g @moxxy/cli  (>= ${MIN_MOXXY_VERSION}). ` +
        'companiond starts anyway; runs will fail until moxxy is installed.',
    );
  } else if (!moxxyCli.compatible) {
    log.warn(`installed moxxy ${moxxyCli.version} is older than ${MIN_MOXXY_VERSION}; upgrade with: npm i -g @moxxy/cli`);
  } else {
    log.info(`moxxy ${moxxyCli.version} at ${moxxyCli.path}`);
  }

  const store = new Store();
  const auth = new Auth(store);
  // Legacy .env accounts seed an EMPTY user store once; afterwards the Users
  // module owns accounts. A clean install with no .env runs SPA onboarding.
  auth.seedFromEnv(config.users);
  if (auth.setupNeeded()) {
    log.info('no accounts yet — first-boot onboarding is waiting in the browser');
  }
  const hub = new SpaHub((token) => auth.verify(token));
  // Wrapped so domain modules can react to run lifecycle broadcasts
  // (an implement run reaching review flips its proposal to review too).
  let proposalsRef: Proposals | null = null;
  const broadcast: typeof hub.broadcast = (msg) => {
    hub.broadcast(msg);
    if (msg.t === 'run.changed' && msg.run.status === 'review') {
      proposalsRef?.onRunReview(msg.run.id);
    }
  };

  // GitHub accounts registry: each PAT is bound to purposes (fetch, runs,
  // pipelines, webhooks); consumers resolve a client per purpose. The legacy
  // single settings-table token migrates into the registry on first boot.
  const ghAccounts = new GitHubAccounts(store);
  ghAccounts.migrateLegacyToken();
  const github = (): GitHubClient | null => ghAccounts.clientFor('fetch');
  const setGithubToken = async (token: string): Promise<{ login: string }> => {
    // Onboarding path: the first token gets every purpose; rebinding happens
    // in Settings → GitHub accounts.
    const account = await ghAccounts.add(token, ['fetch', 'runs', 'pipelines', 'webhooks']);
    store.setSetting('github_token', token);
    broadcast({ t: 'repos.changed' });
    return { login: account.login };
  };

  const checkouts = new Checkouts(() => ghAccounts.tokenFor('runs') ?? store.getSetting('github_token'));
  const orchestrator = new Orchestrator(store, config, moxxyCli?.path ?? 'moxxy', broadcast);
  orchestrator.recover();
  const dangling = store.resetDanglingProposalAnalyses();
  if (dangling > 0) log.info(`reset ${dangling} proposal(s) stuck in 'analyzing' from previous daemon life`);
  const sync = new GitHubSync(store, () => ghAccounts.clientFor('fetch'), broadcast);
  const prChecks = new PrChecks(store, () => ghAccounts.clientFor('fetch'), broadcast);
  // Every sync also refreshes CI snapshots for the repo's freshest open PRs.
  sync.onSynced = (repo) => prChecks.refreshOpenPrs(repo);
  sync.start();
  const triage = new Triage(store, orchestrator, checkouts, (ctx) => ghAccounts.clientFor('pipelines', ctx), broadcast);
  const prReviews = new PrReviews(store, orchestrator, checkouts, (ctx) => ghAccounts.clientFor('pipelines', ctx), prChecks, broadcast);
  const fixes = new Fixes(store, orchestrator, checkouts, () => ghAccounts.clientFor('runs'), broadcast);
  const proposals = new Proposals(store, orchestrator, fixes, checkouts, broadcast);
  proposalsRef = proposals;
  const pipelines = new Pipelines(
    { store, orchestrator, checkouts, github: (ctx) => ghAccounts.clientFor('pipelines', ctx), checks: prChecks, reviews: prReviews },
    broadcast,
  );
  const automations = new Automations(
    store,
    orchestrator,
    triage,
    prReviews,
    pipelines,
    sync,
    checkouts,
    broadcast,
  );
  automations.start();
  const skills = new Skills();

  // Serve the built SPA when present (production); dev uses Vite + proxy.
  const here = dirname(fileURLToPath(import.meta.url));
  const builtSpa = join(here, '..', '..', 'web', 'dist');
  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    deps: {
      config,
      auth,
      broadcast,
      orchestrator,
      moxxyCli,
      store,
      github,
      githubUser: () => ghAccounts.loginFor('fetch'),
      githubAccounts: ghAccounts,
      setGithubToken,
      sync,
      checkouts,
      triage,
      prReviews,
      prChecks,
      fixes,
      proposals,
      pipelines,
      automations,
      skills,
    },
    hub,
    staticDir: existsSync(join(builtSpa, 'index.html')) ? builtSpa : undefined,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down…');
    const force = setTimeout(() => process.exit(0), 6_000);
    force.unref();
    sync.stop();
    automations.stop();
    await orchestrator.shutdown();
    hub.close();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error('fatal boot error', err);
  process.exit(1);
});
