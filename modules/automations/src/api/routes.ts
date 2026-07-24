import { z } from 'zod';
import { badRequest, defineRoutes, route, notFound } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import '../contract/index.js';

const automationSchema = z.object({
  autoTriage: z.boolean().optional(),
  digest: z.boolean().optional(),
  staleSweep: z.boolean().optional(),
  prGate: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
});

const webhookSchema = z.object({ accountId: z.string().min(1).max(60) });

const messageSchema = z.object({
  text: z.string().min(1).max(32_000),
  /** Repo the conversation currently focuses on (the panel's scope select). */
  repo: z.string().max(200).optional(),
});

const askSchema = z.object({
  requestId: z.string(),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().optional(),
    text: z.string().optional(),
  }),
});

/** A UI directive AI Help emits into the caller's own browser. */
const uiSchema = z
  .object({
    hash: z
      .string()
      .max(300)
      .regex(/^#\//, 'hash must start with #/')
      .optional(),
    intent: z.enum(['new-workspace', 'connect-repo', 'connect-github']).optional(),
  })
  .refine((v) => v.hash || v.intent, 'provide a hash to navigate or an intent to open');

/**
 * The reactor domain's HTTP surface: the per-repo automation switches and
 * webhook receiver, the instance-wide delivery tunnel, the run-now actions
 * (digest, stale sweep), the workspace briefing cadence, and AI Help. Every
 * AI Help route is 'any' (each signed-in role gets an assistant) and resolves
 * the CALLER's own conversation run — there is no way to address another
 * user's assistant. Action authority comes from the scoped token the
 * assistant service mints, which carries the caller's own role.
 */
export default defineRoutes((ctx) => {
  const { automations, assistant } = ctx.services.get('automations');
  const operate = ctx.services.get('operate');
  const code = ctx.services.get('code');
  const workspace = ctx.services.get('workspace');

  // Resolve a repo and enforce its workspace's access rule — a repo in a
  // private workspace the user isn't in reads as "not connected".
  const requireRepo = (user: AuthUser | null, owner: string, name: string) => {
    const fullName = `${owner}/${name}`;
    const row = code.repos.get(fullName);
    if (!row || !user || !workspace.canAccessRepo(user, fullName)) {
      throw notFound(`repo ${fullName} not connected`);
    }
    return { fullName, row };
  };

  // Access gate: a private workspace the user isn't in reads as "not found" —
  // membership is hidden, so its existence is too.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord =>
    workspace.requireAccessible(user, id);

  const requirePersonalRepoAccess = async (user: AuthUser | null, fullName: string): Promise<void> => {
    const { client } = await code.githubAccounts.verifiedClientFor('fetch', fullName, {
      username: user?.username ?? null,
    });
    if (!client) throw badRequest(`your connected GitHub accounts cannot access ${fullName}`);
  };

  return [
    // ---------- per-repo automation switches + webhook receiver -------------------

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/automation',
      access: 'automations:manage',
      body: automationSchema,
      handler: async ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        const ownerId = code.repos.automationOwner(fullName);
        if (ownerId && ownerId !== user!.username) {
          throw badRequest('these automations are managed by another Companion profile');
        }
        if (body.autoTriage !== undefined) code.repos.setAutomation(fullName, 'auto_triage', body.autoTriage);
        if (body.digest !== undefined) code.repos.setAutomation(fullName, 'digest_enabled', body.digest);
        if (body.staleSweep !== undefined) code.repos.setAutomation(fullName, 'stale_enabled', body.staleSweep);
        if (body.prGate !== undefined) code.repos.setAutomation(fullName, 'pr_gate', body.prGate);
        if (body.autoMerge !== undefined) code.repos.setAutomation(fullName, 'auto_merge', body.autoMerge);
        const row = code.repos.get(fullName)!;
        const anyEnabled =
          row.auto_triage === 1 ||
          row.digest_enabled === 1 ||
          row.stale_enabled === 1 ||
          row.pr_gate === 1 ||
          row.auto_merge === 1;
        code.repos.setAutomationOwner(fullName, anyEnabled ? user!.username : null);
        ctx.broadcast({ t: 'repos.changed' });
        return { repo: code.repos.getRecord(fullName)! };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      body: webhookSchema,
      handler: async ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const account = code.githubAccounts.row(body.accountId);
        if (!account || account.ownerId !== user!.username || !account.purposes.includes('webhooks')) {
          throw badRequest('choose one of your GitHub accounts enabled for webhooks');
        }
        // Registering a webhook is an admin-level repository action; without
        // that grade GitHub answers 404 and the failure reads as "missing repo".
        const { client } = await code.githubAccounts.verifiedClientFor('webhooks', fullName, {
          accountId: account.id,
          username: user!.username,
          need: 'admin',
        });
        if (!client) {
          throw badRequest(`${account.login} needs admin access to ${fullName} to register a webhook`);
        }
        try {
          return automations.ensureWebhook(fullName, user!.username, account.id, account.login);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        try {
          automations.disableWebhook(fullName, user!.username);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        return { ok: true };
      },
    }),

    /** Read-only info: unlike the POST, never (re-)enables the receiver. */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const registration = code.repos.getWebhookRegistration(fullName);
        const accountLogin = registration?.accountId && registration.ownerId === user!.username
          ? (code.githubAccounts.row(registration.accountId)?.login ?? null)
          : null;
        return { webhook: automations.webhookInfo(fullName, user!.username, accountLogin) };
      },
    }),

    /** Instance-wide public webhook delivery over moxxy's proxy relay. */
    route({
      method: 'GET',
      path: '/api/webhooks/tunnel',
      access: 'automations:manage',
      handler: () => operate.webhookTunnel.state(),
    }),

    route({
      method: 'POST',
      path: '/api/webhooks/tunnel/retry',
      access: 'settings:manage',
      handler: async () => {
        if (!operate.webhookTunnel.enabled()) throw badRequest('enable public webhook delivery first');
        await operate.webhookTunnel
          .start()
          .catch((err) => ctx.log.warn('manual webhook tunnel retry failed', { err: String(err) }));
        return operate.webhookTunnel.state();
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/digest-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        // Kick off and return: the run takes minutes and must not hold the
        // request open. Progress streams via runs.changed/reports.changed.
        automations.startDigest(fullName, user!.username);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/stale-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        automations.runStaleSweep(fullName);
        return { ok: true };
      },
    }),

    // ---------- workspace briefing ----------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/briefing',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { cadence: automations.briefingCadence(params.id) };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/briefing',
      access: 'automations:manage',
      body: z.object({ cadence: z.enum(['off', 'daily', 'weekly']) }),
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        automations.setBriefingCadence(params.id, body.cadence);
        return { cadence: body.cadence };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/briefing-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        await automations.runBriefing(params.id);
        return { ok: true };
      },
    }),

    // ---------- AI Help ------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/assistant',
      access: 'any',
      handler: ({ user }) => assistant.info(user!),
    }),

    route({
      method: 'POST',
      path: '/api/assistant/session',
      access: 'any',
      handler: async ({ user }) => {
        const run = await assistant.ensureRun(user!);
        return { run, pendingAsks: assistant.info(user!).pendingAsks };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/message',
      access: 'any',
      body: messageSchema,
      handler: async ({ user, body }) => assistant.send(user!, body.text, body.repo),
    }),

    route({
      method: 'GET',
      path: '/api/assistant/history',
      access: 'any',
      handler: async ({ user, query }) => {
        const beforeRaw = query.get('before');
        const before = beforeRaw === null ? null : Number(beforeRaw);
        const limit = Math.min(Number(query.get('limit')) || 300, 1000);
        return assistant.history(user!, Number.isFinite(before as number) ? before : null, limit);
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/ask',
      access: 'any',
      body: askSchema,
      handler: async ({ user, body }) => {
        await assistant.respondAsk(user!, body.requestId, body.response);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/abort',
      access: 'any',
      handler: async ({ user }) => {
        await assistant.abort(user!);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/reset',
      access: 'any',
      handler: async ({ user }) => {
        await assistant.reset(user!);
        return { ok: true };
      },
    }),

    // AI Help drives the caller's own browser: navigate to a page or open a
    // create/connect form. Pushed only to this user's sockets — never another's.
    route({
      method: 'POST',
      path: '/api/assistant/ui',
      access: 'any',
      body: uiSchema,
      handler: ({ user, body }) => {
        ctx.pushToUser(user!.username, { t: 'client.intent', hash: body.hash, intent: body.intent });
        return { ok: true };
      },
    }),
  ];
});
