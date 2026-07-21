import { defineServices } from '@companion/core/server';
import type { AuthUser, SpaServerMessage } from '@companion/contracts';
import { paths } from '@companion/services';
import type { GithubTokenSource } from '../contract/index.js';
import { detectMoxxyCli, MIN_MOXXY_VERSION } from '../exec/cli.js';
import { healCredentialLinks, seedPermissionDenyRules } from '../exec/home.js';
import { Checkouts } from '../exec/checkouts.js';
import { OperateStore } from './operate-store.js';
import { Orchestrator } from './orchestrator.js';
import { WebhookTunnel } from './webhook-tunnel.js';
import { Skills } from './skills.js';
import { OperateService } from './operate-service.js';

/**
 * Construct the execution plane: moxxy-home hygiene, CLI detection, the narrow
 * store facade, the orchestrator (which owns the runner registry), the public
 * webhook tunnel and the skill library — then publish the bundle as `operate`.
 */
export default defineServices(async (ctx) => {
  // moxxy-home hygiene the legacy main() ran at boot.
  seedPermissionDenyRules();
  healCredentialLinks();

  const settings = ctx.services.get('settings');

  // One-time adoption of the pre-framework settings keys into module config
  // (via ctx.modules.setConfig — the kernel validates and encodes). Deleting the
  // legacy keys makes this run once ever.
  const legacySlots = settings.get('reservedRunnerSlots');
  const legacyTunnel = settings.get('webhookTunnel');
  if (legacySlots !== null || legacyTunnel !== null) {
    const patch: Record<string, unknown> = {};
    const n = Math.floor(Number(legacySlots));
    if (legacySlots !== null && Number.isFinite(n)) patch.reservedRunnerSlots = Math.min(64, Math.max(0, n));
    if (legacyTunnel !== null) patch.webhookTunnel = legacyTunnel === 'on';
    if (Object.keys(patch).length) ctx.modules.setConfig('operate', patch);
    settings.delete('reservedRunnerSlots');
    settings.delete('webhookTunnel');
  }

  // Git credentials: module-code plugs its account-aware resolver in at its
  // onEnable; until then (or with code disabled) the legacy settings key serves.
  const tokenSource: { current: GithubTokenSource } = {
    current: { tokenFor: () => settings.get('github_token') },
  };
  const githubTokenFor = async (repo: string): Promise<string | null> =>
    (await tokenSource.current.tokenFor(repo)) ?? settings.get('github_token');

  // run.changed fans out to browsers AND to the server bus, replacing the
  // legacy composition root's hard-coded proposals forward-ref: reacting
  // modules (plan) subscribe in their onEnable.
  const broadcast = (msg: SpaServerMessage): void => {
    ctx.broadcast(msg);
    if (msg.t === 'run.changed') ctx.bus.emit('run.changed', msg.run);
  };

  const moxxyCli = await detectMoxxyCli(paths.moxxyHome(), ctx.config.moxxyCliPath);
  if (!moxxyCli) {
    ctx.log.warn(
      `moxxy CLI not found on PATH — install it with: npm i -g @moxxy/cli  (>= ${MIN_MOXXY_VERSION}). ` +
        'companiond starts anyway; runs will fail until moxxy is installed.',
    );
  } else if (!moxxyCli.compatible) {
    ctx.log.warn(`installed moxxy ${moxxyCli.version} is older than ${MIN_MOXXY_VERSION}; upgrade with: npm i -g @moxxy/cli`);
  } else {
    ctx.log.info(`moxxy ${moxxyCli.version} at ${moxxyCli.path}`);
  }

  // Per-repo resolution, so delegated accounts / repo pins govern clones too.
  const checkouts = new Checkouts(githubTokenFor);
  const store = new OperateStore(ctx.db, settings);
  const orchestrator = new Orchestrator(store, ctx.config, checkouts, moxxyCli, broadcast, githubTokenFor, ctx.moduleConfig);
  const webhookTunnel = new WebhookTunnel(() => ctx.moduleConfig.get('webhookTunnel') === true, ctx.config.port);
  const skills = new Skills();

  // Run visibility gates on repo→workspace access; resolve workspace lazily so
  // the live instance is always used (operate dependsOn workspace).
  const canAccessRepo = (user: AuthUser, repo: string): boolean =>
    ctx.services.get('workspace').canAccessRepo(user, repo);

  ctx.services.register(
    'operate',
    new OperateService(
      orchestrator,
      orchestrator.runners,
      checkouts,
      moxxyCli,
      webhookTunnel,
      skills,
      store.runs,
      tokenSource,
      canAccessRepo,
    ),
  );
});
