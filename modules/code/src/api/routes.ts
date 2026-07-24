import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { defineRoutes, route, created, accepted, notFound, badRequest, forbidden, HttpError } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { RunRecord } from '@companion/module-operate/contract';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import { log, paths } from '@companion/services';
import type { CommentRecord, PrFileChange, RepoPermission } from '../contract/index.js';
import { savePipelineSchema, saveStepDefinitionSchema } from './pipelines.js';
import { rowToRepo } from './repos-store.js';
import { TriageStore } from './triage-store.js';
import { PrReviewsStore } from './pr-reviews-store.js';
import { PipelinesStore } from './pipelines-store.js';
import { GitHubError } from './github-client.js';
import { gradeRepoPermissions } from './github-accounts.js';

// ---------- repos ----------

const addRepoSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workspaceId: z.string().min(1),
});
const moveSchema = z.object({ workspaceId: z.string().min(1), fromWorkspaceId: z.string().min(1) });

// ---------- issues ----------

const applyTriageSchema = z.object({ comment: z.boolean().default(true) });
const commentSchema = z.object({ body: z.string().min(1).max(64_000) });
const stateSchema = z.object({ state: z.enum(['open', 'closed']) });

// ---------- prs ----------

const mergeSchema = z.object({ method: z.enum(['merge', 'squash', 'rebase']).default('squash') });
/** Generous cap — a custom agent objective may carry pasted logs or specs. */
const prAgentSchema = z.object({ instructions: z.string().trim().min(8).max(16_000) });

// ---------- github accounts ----------

const purposesSchema = z.array(z.enum(['fetch', 'runs', 'pipelines', 'webhooks'])).min(1).max(4);
// Accept the pre-personal-account names during rolling/local upgrades. They
// only map the owner's own availability; a legacy `shared: true` flag is
// ignored and can never make the credential usable by another profile.
const scopeInputSchema = z.enum(['all', 'selected', 'shared', 'delegated']);
const workspaceIdsSchema = z.array(z.string()).max(200);

const addAccountSchema = z.object({
  token: z.string().min(10).max(500),
  purposes: purposesSchema,
  scope: scopeInputSchema.default('all'),
  workspaceIds: workspaceIdsSchema.default([]),
  shared: z.boolean().optional(),
});

const patchAccountSchema = z.object({
  purposes: purposesSchema.optional(),
  scope: scopeInputSchema.optional(),
  workspaceIds: workspaceIdsSchema.optional(),
});

// ---------- fix flow (runs) + onboarding ----------

const approvePrSchema = z.object({ title: z.string().optional(), body: z.string().optional() });
const ghTokenSchema = z.object({ token: z.string().min(10) });

// ---------- AI generation ----------

const genSchema = z.object({ instructions: z.string().min(8).max(4000) });

const skillDraftSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  content: z.string().min(20).max(64_000),
});

const STEP_SCHEMA_DOC = `A step is one of (JSON):
- { "kind": "checks-gate", "name": string, "onFailure": "halt"|"continue", "config": { "allowPending": boolean } } — fail while GitHub CI is red
- { "kind": "ai-review", "name": string, "onFailure": ..., "config": { "post": boolean, "failOn": "request_changes"|"high_risk"|"never" } } — built-in AI code review
- { "kind": "agent", "name": string, "onFailure": ..., "config": { "prompt": string } } — custom agent prompt; the agent replies with a pass/fail verdict
- { "kind": "label", "name": string, "onFailure": ..., "config": { "labels": string[] (1-8) } } — add labels to the PR
- { "kind": "comment", "name": string, "onFailure": ..., "config": { "body": string } } — post a comment (supports {{pr.title}} templates)`;

/** The last fenced JSON block (or the widest brace span) in an agent reply. */
function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const raw = fences.length > 0 ? fences[fences.length - 1]![1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

function scratchCwd(): string {
  const dir = paths.scratch();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The code domain's HTTP surface: repos + the GitHub account registry, the
 * issues/PRs boards (repo- and workspace-scoped), triage + AI reviews + CI
 * checks, pipelines + the step library (+ AI generation of both), and the
 * fix-flow routes on a run (diff / approve-pr / discard) that operate's carve
 * deliberately left out. The repo automation/webhook/briefing routes stay with
 * the automations domain (not yet carved).
 */
export default defineRoutes((ctx) => {
  const code = ctx.services.get('code');
  const operate = ctx.services.get('operate');
  const workspace = ctx.services.get('workspace');
  const settings = ctx.services.get('settings');

  // Read-side lookups the service bundle doesn't re-expose (results/history by
  // id). Store classes are stateless wrappers over ctx.db, so these instances
  // read exactly what the services write.
  const triageStore = new TriageStore(ctx.db);
  const prReviewsStore = new PrReviewsStore(ctx.db);
  const pipelinesStore = new PipelinesStore(ctx.db);
  // Reports are workspace-owned; module-workspace registers the store below us.
  const reports = ctx.services.get('reports');

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

  const requireIssue = (user: AuthUser | null, owner: string, name: string, number: string) => {
    const fullName = `${owner}/${name}`;
    const issue = code.issues.get(fullName, Number(number));
    if (!issue || !user || !workspace.canAccessRepo(user, fullName)) {
      throw notFound(`issue ${fullName}#${number} not found`);
    }
    return { fullName, issue };
  };

  const requirePr = (user: AuthUser | null, owner: string, name: string, number: string) => {
    const fullName = `${owner}/${name}`;
    const pr = code.prs.get(fullName, Number(number));
    if (!pr || !user || !workspace.canAccessRepo(user, fullName)) {
      throw notFound(`PR ${fullName}#${number} not found`);
    }
    return { fullName, pr };
  };

  /** Cache membership is not authorization. Before returning cached GitHub
   * data, prove that one of the caller's own accounts can still see the repo. */
  const requirePersonalRepoAccess = async (user: AuthUser | null, fullName: string, workspaceId?: string): Promise<void> => {
    if (!user) throw forbidden('sign in first');
    const { client } = await code.githubAccounts.verifiedClientFor('fetch', fullName, {
      username: user.username,
      workspaceId,
    });
    if (!client) {
      throw forbidden(`your connected GitHub accounts cannot access ${fullName}`);
    }
  };

  /**
   * The permission the caller's own accounts hold on each repo of a workspace.
   * One probe per repo (TTL-cached alongside credential resolution), so every
   * consumer — pickers, the board, automations — gates on the same graded truth
   * instead of re-deriving "can I?" per action.
   */
  const repoPermissions = async (user: AuthUser, workspaceId: string): Promise<Map<string, RepoPermission>> => {
    const rows = code.repos.listByWorkspace(workspaceId);
    const graded = await Promise.all(
      rows.map(async (row) => {
        const permission = await code.githubAccounts.permissionFor('fetch', row.full_name, {
          username: user.username,
          workspaceId,
        });
        return permission ? ([row.full_name, permission] as const) : null;
      }),
    );
    return new Map(graded.filter((entry): entry is readonly [string, RepoPermission] => entry !== null));
  };

  const accessibleRepoNames = async (user: AuthUser, workspaceId: string): Promise<string[]> => [
    ...(await repoPermissions(user, workspaceId)).keys(),
  ];

  // Access gate for the workspace feeds: a private workspace the user isn't in
  // reads as "not found" — same helper as module-workspace's routes.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord =>
    workspace.requireAccessible(user, id);
  const requirePipeline = (user: AuthUser | null, id: string) => {
    const pipeline = pipelinesStore.get(id);
    if (!pipeline || !user || !workspace.canAccessWorkspace(user, pipeline.workspaceId)) {
      throw notFound(`pipeline ${id} not found`);
    }
    return pipeline;
  };

  const requirePipelineForRepo = (user: AuthUser | null, id: string, repo: string) => {
    const pipeline = requirePipeline(user, id);
    if (!code.repos.inWorkspace(repo, pipeline.workspaceId)) {
      throw notFound(`pipeline ${id} not found`);
    }
    return pipeline;
  };

  const requireStepDefinition = (user: AuthUser | null, id: string) => {
    const definition = pipelinesStore.getStepDefinition(id);
    if (!definition || !user || !workspace.canAccessWorkspace(user, definition.workspaceId)) {
      throw notFound(`step definition ${id} not found`);
    }
    return definition;
  };

  const requirePipelineRun = async (user: AuthUser | null, id: string) => {
    const run = pipelinesStore.getRun(id);
    if (!run || !user || !workspace.canAccessRepo(user, run.repo)) {
      throw notFound(`pipeline run ${id} not found`);
    }
    await requirePersonalRepoAccess(user, run.repo);
    return run;
  };

  const requireTriage = async (user: AuthUser | null, id: string) => {
    const result = triageStore.get(id);
    if (!result || !user || !workspace.canAccessRepo(user, result.repo)) {
      throw notFound(`triage ${id} not found`);
    }
    await requirePersonalRepoAccess(user, result.repo);
    return result;
  };

  const requirePrReview = async (user: AuthUser | null, id: string) => {
    const review = prReviewsStore.get(id);
    if (!review || !user || !workspace.canAccessRepo(user, review.repo)) {
      throw notFound(`PR review ${id} not found`);
    }
    await requirePersonalRepoAccess(user, review.repo);
    return review;
  };

  const requireAccessibleWorkspaceIds = (user: AuthUser | null, ids: readonly string[]): void => {
    if (!user || ids.some((id) => !workspace.canAccessWorkspace(user, id))) {
      throw notFound('workspace not found');
    }
  };

  // Every GitHub account is personal and manageable only by its owner.
  const requireManageable = (user: AuthUser | null, id: string) => {
    const row = code.githubAccounts.row(id);
    if (!row) throw notFound(`GitHub account ${id} not found`);
    if (!user || row.ownerId !== user.username) {
      throw notFound(`GitHub account ${id} not found`);
    }
    return row;
  };

  // Run visibility for the fix-flow routes: the single owner of this security
  // rule is the operate service (OperateService.canSeeRun) — delegate to it.
  const requireRunAccess = (user: AuthUser | null, id: string): RunRecord => operate.requireRunAccess(user, id);

  /** Agents auto-discover moxxy-home skills; tell the generator what exists. */
  const skillsNote = (): string => {
    const names = operate.skills.list().map((sk) => sk.name);
    return names.length > 0
      ? `\nAgents auto-discover these skills — an "agent" step prompt can apply one by mentioning its name: ${names.join(', ')}.\n`
      : '';
  };

  const oneShot = async (title: string, prompt: string): Promise<string> => {
    const { finalMessage } = await operate.orchestrator.runOneShot({
      kind: 'analysis',
      title,
      cwd: scratchCwd(),
      prompt,
      timeoutMs: 4 * 60_000,
    });
    if (!finalMessage?.trim()) throw badRequest('the generation run produced no output — try again');
    return finalMessage;
  };

  return [
    // ---------- repos ------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/repos',
      access: 'repos:read',
      handler: async ({ user }) => {
        const accessible = workspace.accessibleIds(user!);
        const rows = code.repos.listAccessible([...accessible]);
        return {
          repos: await Promise.all(
            rows.map(async (row) => {
              const permission = await code.githubAccounts.permissionFor('fetch', row.full_name, {
                username: user!.username,
              });
              return {
                ...rowToRepo(row),
                githubAccessible: permission !== null,
                githubPermission: permission,
                openIssues: permission ? code.issues.list(row.full_name, 'open').length : 0,
              };
            }),
          ),
        };
      },
    }),

    /** Existing remote branches for searchable branch pickers. */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/branches',
      access: 'repos:read',
      handler: async ({ params, query, user }) => {
        const { fullName, row } = requireRepo(user, params.owner, params.name);
        const workspaceId = query.get('workspaceId') ?? '';
        if (!workspaceId || !workspace.canAccessWorkspace(user!, workspaceId) || !code.repos.inWorkspace(fullName, workspaceId)) {
          throw notFound(`repo ${fullName} not connected`);
        }
        const { client, tried } = await code.githubAccounts.verifiedClientFor('fetch', fullName, {
          workspaceId,
          username: user?.username ?? null,
        });
        if (!client) {
          throw badRequest(
            tried.length > 0
              ? `none of the connected GitHub accounts (${tried.join(', ')}) can list branches for ${fullName}`
              : 'GitHub is not configured (connect an account first)',
          );
        }
        try {
          const branches = await client.branches(fullName);
          return {
            branches: branches.map((branch) => ({ name: branch.name, protected: branch.protected })),
            defaultBranch: row.default_branch,
          };
        } catch (err) {
          if (err instanceof GitHubError && [401, 403, 404].includes(err.status)) {
            throw badRequest(`the selected GitHub account cannot list branches for ${fullName}`);
          }
          throw err;
        }
      },
    }),

    /** The add-repo picker feed: repos the reachable GitHub accounts can see. */
    route({
      method: 'GET',
      path: '/api/github/repo-candidates',
      access: 'repos:manage',
      handler: async ({ query, user }) => {
        const workspaceId = query.get('workspaceId') ?? '';
        const ws = workspace.get(workspaceId);
        if (!ws) throw badRequest('workspaceId is required');
        if (!workspace.canAccess(user!, ws)) throw forbidden('you cannot add repos to that workspace');
        return { candidates: await code.githubAccounts.repoCandidates(workspaceId) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos',
      access: 'repos:manage',
      body: addRepoSchema,
      handler: async ({ body, user }) => {
        const ws = workspace.get(body.workspaceId);
        if (!ws) throw badRequest(`workspace ${body.workspaceId} not found`);
        if (!workspace.canAccess(user!, ws)) {
          throw forbidden('you cannot add repos to that workspace');
        }
        // Resolve WITH the target workspace (the repo row doesn't exist yet)
        // across only the invoking user's eligible personal accounts.
        const { row: account, tried } = await code.githubAccounts.verifiedRowFor('fetch', body.fullName, {
          workspaceId: body.workspaceId,
          username: user?.username ?? null,
        });
        if (!account) {
          throw badRequest(
            tried.length > 0
              ? `none of your connected GitHub accounts (${tried.join(', ')}) can access ${body.fullName} — ask the repository owner to grant your account access`
              : 'connect one of your GitHub accounts first',
          );
        }
        let meta;
        try {
          meta = await code.githubAccounts.clientOf(account).repo(body.fullName);
        } catch (err) {
          if (err instanceof GitHubError && [401, 403, 404].includes(err.status)) {
            throw badRequest(
              `GitHub account '${account.login || account.id}' cannot access ${body.fullName} — check the repository name, or connect an account that has access`,
            );
          }
          throw err;
        }
        const existing = code.repos.get(meta.full_name);
        if (code.repos.inWorkspace(meta.full_name, body.workspaceId)) {
          throw new HttpError(409, `${meta.full_name} is already connected to this workspace`);
        }
        code.repos.upsert({
          fullName: meta.full_name,
          owner: meta.owner.login,
          name: meta.name,
          defaultBranch: meta.default_branch,
          private: meta.private,
          workspaceId: body.workspaceId,
        });
        // Clone + first sync in the background; the UI follows repos.changed.
        void (async () => {
          try {
            if (!existing?.clone_ready) {
              // Provision with the exact credential verified above. Ambient
              // request identity must not make the clone pick another account.
              await operate.checkouts.clone(meta.full_name, account.token);
              code.repos.setCloneReady(meta.full_name, true);
            }
            await code.sync.syncRepo(meta.full_name, body.workspaceId, user!.username);
          } catch (err) {
            log.warn('repo provisioning failed', { repo: meta.full_name, err: String(err) });
          }
        })();
        ctx.broadcast({ t: 'repos.changed' });
        return created({
          repo: {
            ...rowToRepo(code.repos.getInWorkspace(meta.full_name, body.workspaceId)!),
            githubAccessible: true,
            githubPermission: gradeRepoPermissions(meta.permissions),
          },
        });
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/repos/:owner/:name',
      access: 'repos:manage',
      handler: ({ params, query, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const workspaceId = query.get('workspaceId');
        if (!workspaceId || !workspace.canAccessWorkspace(user!, workspaceId)) {
          throw forbidden('no access to that workspace');
        }
        if (!code.repos.inWorkspace(fullName, workspaceId)) throw notFound(`repo ${fullName} not connected`);
        code.repos.removeFromWorkspace(fullName, workspaceId);
        ctx.broadcast({ t: 'repos.changed' });
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/workspace',
      access: 'repos:manage',
      body: moveSchema,
      handler: ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const target = workspace.get(body.workspaceId);
        if (!target) throw badRequest(`workspace ${body.workspaceId} not found`);
        if (!workspace.canAccess(user!, target)) {
          throw forbidden('you cannot move this repo into that workspace');
        }
        if (!workspace.canAccessWorkspace(user!, body.fromWorkspaceId)) {
          throw forbidden('you cannot move this repo out of that workspace');
        }
        if (!code.repos.inWorkspace(fullName, body.fromWorkspaceId)) {
          throw notFound(`repo ${fullName} not connected`);
        }
        code.repos.moveWorkspace(fullName, body.fromWorkspaceId, body.workspaceId);
        ctx.broadcast({ t: 'repos.changed' });
        return { repo: rowToRepo(code.repos.getInWorkspace(fullName, body.workspaceId)!) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/sync',
      access: 'repos:manage',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        return code.sync.syncRepo(fullName, undefined, user!.username);
      },
    }),

    /** Pin (or clear) the runner this repo's agent work prefers. */
    route({
      method: 'PATCH',
      path: '/api/repos/:owner/:name/runner',
      access: 'repos:manage',
      body: z.object({ runnerId: z.string().max(60).nullable() }),
      handler: ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const runner = body.runnerId ? operate.runners.get(body.runnerId) : null;
        if (body.runnerId && (!runner || (runner.ownerId !== null && runner.ownerId !== user?.username))) {
          throw notFound(`unknown runner: ${body.runnerId}`);
        }
        code.repos.setRunner(fullName, body.runnerId);
        ctx.broadcast({ t: 'repos.changed' });
        return { repo: rowToRepo(code.repos.get(fullName)!) };
      },
    }),

    /**
     * Which of MY accounts can act on this repo, and what each may do there.
     * Personal by construction: the list is the caller's own accounts, so it
     * discloses nothing about anyone else's credentials.
     */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/accounts',
      access: 'repos:read',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        return { accounts: await code.githubAccounts.accountsForRepo(fullName, user!.username) };
      },
    }),

    /** Bind one of my accounts to this repo (null clears it back to automatic). */
    route({
      method: 'PUT',
      path: '/api/repos/:owner/:name/account',
      access: 'repos:read',
      body: z.object({ accountId: z.string().max(60).nullable() }),
      handler: async ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        try {
          code.githubAccounts.bind(fullName, user!.username, body.accountId);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        ctx.broadcast({ t: 'repos.changed' });
        return { accounts: await code.githubAccounts.accountsForRepo(fullName, user!.username) };
      },
    }),

    /** Kick a platform pipeline against this repo (no issue/PR payload). */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/pipelines/:pipelineId/run',
      access: 'pipelines:run',
      handler: ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const pipeline = requirePipelineForRepo(user, params.pipelineId, fullName);
        if (pipeline.type !== 'platform') {
          throw badRequest(`"${pipeline.name}" is a ${pipeline.type} pipeline — run it from a ${pipeline.type}`);
        }
        const run = code.pipelines.start(params.pipelineId, fullName, 0, 'manual', user!.username);
        return created({ run });
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues',
      access: 'issues:read',
      handler: async ({ params, query, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        const state = query.get('state');
        return {
          issues: code.issues.list(fullName, state === 'open' || state === 'closed' ? state : undefined),
        };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs',
      access: 'prs:read',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        return { prs: code.prs.list(fullName) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/triage',
      access: 'issues:read',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        return { results: triageStore.list(fullName) };
      },
    }),

    // ---------- issues -----------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues/:number',
      access: 'issues:read',
      handler: async ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        await requirePersonalRepoAccess(user, fullName);
        return { issue, triage: triageStore.latest(fullName, issue.number) ?? null };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/triage',
      access: 'issues:act',
      handler: ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        // Long-running; kick it and let the UI follow triage.changed.
        void code.triage
          .triageIssue(fullName, issue.number, user!.username)
          .catch((err) => log.warn('triage failed', { fullName, number: issue.number, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/fix',
      access: 'issues:act',
      handler: async ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const run = await code.fixes.startFix(fullName, issue.number, user?.username ?? null);
        return created({ run });
      },
    }),

    /** Live conversation from GitHub (read-through, newest last). */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues/:number/comments',
      access: 'issues:read',
      handler: async ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const { client } = await code.githubAccounts.verifiedClientFor('fetch', fullName, { username: user!.username });
        if (!client) throw forbidden(`your connected GitHub accounts cannot access ${fullName}`);
        const raw = await client.issueComments(fullName, issue.number);
        const comments: CommentRecord[] = raw.map((c) => ({
          author: c.user?.login ?? 'unknown',
          body: c.body,
          createdAt: Date.parse(c.created_at),
        }));
        return { comments };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/comment',
      access: 'issues:act',
      body: commentSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const { result } = await code.githubAccounts.performForRepo(
          'pipelines',
          fullName,
          (client) => client.comment(fullName, issue.number, body.body),
          { username: user!.username },
        );
        if (!result) throw badRequest(`your connected GitHub accounts cannot update ${fullName}`);
        return { url: result.html_url };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/state',
      access: 'issues:act',
      body: stateSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const { client } = await code.githubAccounts.performForRepo(
          'pipelines',
          fullName,
          (candidate) => candidate.updateIssueState(fullName, issue.number, body.state),
          { username: user!.username },
        );
        if (!client) throw badRequest(`your connected GitHub accounts cannot update ${fullName}`);
        void code.sync.syncRepo(fullName, undefined, user!.username).catch(() => undefined);
        ctx.broadcast({ t: 'issues.changed', repo: fullName });
        return { ok: true };
      },
    }),

    /** Kick an issue-type pipeline against this issue. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/pipelines/:pipelineId/run',
      access: 'pipelines:run',
      handler: ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const pipeline = requirePipelineForRepo(user, params.pipelineId, fullName);
        if (pipeline.type !== 'issue') throw badRequest(`"${pipeline.name}" is a ${pipeline.type} pipeline`);
        const run = code.pipelines.start(params.pipelineId, fullName, issue.number, 'manual', user!.username);
        return created({ run });
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues/:number/pipeline-runs',
      access: 'issues:read',
      handler: async ({ params, user }) => {
        const { fullName } = requireIssue(user, params.owner, params.name, params.number);
        await requirePersonalRepoAccess(user, fullName);
        return { runs: pipelinesStore.listRunsForIssue(fullName, Number(params.number)) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/triage/:id/apply',
      access: 'issues:act',
      body: applyTriageSchema,
      handler: async ({ params, query, body, user }) => {
        await requireTriage(user, params.id);
        const { repo, number } = await code.triage.apply(params.id, {
          comment: body.comment,
          accountId: query.get('account') ?? undefined,
          userId: user!.username,
        });
        await code.sync.syncIssue(repo, number, user!.username);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/triage/:id/dismiss',
      access: 'issues:act',
      handler: async ({ params, user }) => {
        await requireTriage(user, params.id);
        code.triage.dismiss(params.id);
        return { ok: true };
      },
    }),

    // ---------- prs --------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number',
      access: 'prs:read',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        await requirePersonalRepoAccess(user, fullName);
        return {
          pr,
          review: prReviewsStore.latest(fullName, pr.number) ?? null,
          pipelineRuns: pipelinesStore.listRunsForPr(fullName, pr.number),
          ciAnalysis: reports.latestFor(fullName, pr.number, 'ci-analysis'),
        };
      },
    }),

    /** PR conversation (GitHub's issues API serves PR numbers too). */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/comments',
      access: 'prs:read',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        const { client } = await code.githubAccounts.verifiedClientFor('fetch', fullName, { username: user!.username });
        if (!client) throw forbidden(`your connected GitHub accounts cannot access ${fullName}`);
        const raw = await client.issueComments(fullName, pr.number);
        const comments: CommentRecord[] = raw.map((c) => ({
          author: c.user?.login ?? 'unknown',
          body: c.body,
          createdAt: Date.parse(c.created_at),
        }));
        return { comments };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/comment',
      access: 'prs:act',
      body: commentSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        const { result } = await code.githubAccounts.performForRepo(
          'pipelines',
          fullName,
          (client) => client.comment(fullName, pr.number, body.body),
          { username: user!.username },
        );
        if (!result) throw badRequest(`your connected GitHub accounts cannot update ${fullName}`);
        return { url: result.html_url };
      },
    }),

    /** Agent post-mortem of the PR's failing pipelines (async; report lands as ci-analysis). */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/checks/analyze',
      access: 'prs:act',
      handler: ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        void code.prReviews
          .analyzeFailedChecks(fullName, pr.number, user!.username)
          .catch((err) => log.warn('CI analysis failed', { fullName, number: pr.number, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    /** Repair agent: works ON the PR branch until the failing checks pass. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/fix-checks',
      access: 'prs:act',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        try {
          return { run: await code.fixes.startCheckFix(fullName, pr.number, user?.username ?? null) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Resolution agent: implements what human reviewers asked for, on the PR branch. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/address-reviews',
      access: 'prs:act',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        try {
          return { run: await code.fixes.startReviewFix(fullName, pr.number, user?.username ?? null) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Conflict agent: merges the fresh base into the PR branch and resolves. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/resolve-conflicts',
      access: 'prs:act',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        try {
          return { run: await code.fixes.startConflictResolve(fullName, pr.number, user?.username ?? null) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Free-form agent: works ON the PR branch with a user-written objective. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/agent',
      access: 'prs:act',
      body: prAgentSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        try {
          return { run: await code.fixes.startCustomPrRun(fullName, pr.number, body.instructions, user?.username ?? null) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Fresh CI pipeline status straight from GitHub (also updates the snapshot). */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/checks',
      access: 'prs:read',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        return { checks: await code.prChecks.fetchSummary(fullName, pr.number, user!.username) };
      },
    }),

    /**
     * Changed files via the paginated files API — powers the changed-files view.
     * Unlike the single `.diff` payload this doesn't 406 on large PRs.
     */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/files',
      access: 'prs:read',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        const { client } = await code.githubAccounts.verifiedClientFor('fetch', fullName, { username: user!.username });
        if (!client) throw forbidden(`your connected GitHub accounts cannot access ${fullName}`);
        const { files, truncated } = await client.prFiles(fullName, pr.number);
        const mapped: PrFileChange[] = files.map((f) => ({
          filename: f.filename,
          previousFilename: f.previous_filename ?? null,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        }));
        return { files: mapped, truncated };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/analyze',
      access: 'prs:act',
      handler: ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        void code.prReviews
          .analyzePr(fullName, pr.number, user!.username)
          .catch((err) => log.warn('pr analysis failed', { fullName, number: pr.number, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/merge',
      access: 'prs:act',
      body: mergeSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        try {
          await code.prReviews.merge(fullName, pr.number, body.method, user!.username);
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        // Recalculate state from GitHub before returning so the UI updates now.
        await code.sync.syncPr(fullName, pr.number, user!.username);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/close',
      access: 'prs:act',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        await code.prReviews.close(fullName, pr.number, user!.username);
        await code.sync.syncPr(fullName, pr.number, user!.username);
        return { ok: true };
      },
    }),

    /** Kick a user-defined pipeline against this PR. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/pipelines/:pipelineId/run',
      access: 'pipelines:run',
      handler: ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        const pipeline = requirePipelineForRepo(user, params.pipelineId, fullName);
        if (pipeline.type !== 'pr') throw badRequest(`"${pipeline.name}" is a ${pipeline.type} pipeline`);
        const run = code.pipelines.start(params.pipelineId, fullName, pr.number, 'manual', user!.username);
        return created({ run });
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/pipeline-runs',
      access: 'prs:read',
      handler: async ({ params, user }) => {
        const { fullName, pr } = requirePr(user, params.owner, params.name, params.number);
        await requirePersonalRepoAccess(user, fullName);
        return { runs: pipelinesStore.listRunsForPr(fullName, pr.number) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/pr-reviews/:id/apply',
      access: 'prs:act',
      handler: async ({ params, query, user }) => {
        await requirePrReview(user, params.id);
        const { repo, number } = await code.prReviews.apply(
          params.id,
          query.get('account') ?? undefined,
          user!.username,
        );
        await code.sync.syncPr(repo, number, user!.username);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/pr-reviews/:id/dismiss',
      access: 'prs:act',
      handler: async ({ params, user }) => {
        await requirePrReview(user, params.id);
        code.prReviews.dismiss(params.id);
        return { ok: true };
      },
    }),

    // ---------- GitHub accounts --------------------------------------------------
    // The caller sees only their own sanitized account records.

    route({
      // Sanitized list (no tokens) of the caller's own accounts.
      method: 'GET',
      path: '/api/github/accounts',
      access: 'repos:read',
      handler: ({ user }) => {
        return {
          accounts: code.githubAccounts.list().filter((a) => a.ownerId === user?.username),
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/github/accounts',
      access: 'github:connect',
      body: addAccountSchema,
      handler: async ({ body, user }) => {
        const scope = body.scope === 'delegated' || body.scope === 'selected' ? 'selected' : 'all';
        if (scope === 'selected' && body.workspaceIds.length === 0) {
          throw badRequest('a workspace-selected account needs at least one workspace');
        }
        if (scope === 'selected') requireAccessibleWorkspaceIds(user, body.workspaceIds);
        const account = await code.githubAccounts.add(
          body.token,
          body.purposes,
          user!.username,
          scope,
          scope === 'selected' ? body.workspaceIds : [],
        );
        ctx.broadcast({ t: 'repos.changed' });
        return created({ account });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/github/accounts/:id',
      access: 'github:connect',
      body: patchAccountSchema,
      handler: ({ params, body, user }) => {
        const account = requireManageable(user, params.id);
        const nextScope =
          body.scope === undefined
            ? account.scope
            : body.scope === 'delegated' || body.scope === 'selected'
              ? 'selected'
              : 'all';
        const nextWorkspaceIds = body.workspaceIds ?? account.workspaceIds;
        if (nextScope === 'selected' && nextWorkspaceIds.length === 0) {
          throw badRequest('a workspace-selected account needs at least one workspace');
        }
        if (nextScope === 'selected') requireAccessibleWorkspaceIds(user, nextWorkspaceIds);
        return {
          account: code.githubAccounts.update(params.id, {
            ...(body.purposes === undefined ? {} : { purposes: body.purposes }),
            ...(body.scope === undefined ? {} : { scope: nextScope }),
            ...(body.workspaceIds === undefined ? {} : { workspaceIds: body.workspaceIds }),
          }),
        };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/github/accounts/:id',
      access: 'github:connect',
      handler: ({ params, user }) => {
        requireManageable(user, params.id);
        code.githubAccounts.remove(params.id);
        ctx.broadcast({ t: 'repos.changed' });
        return { ok: true };
      },
    }),

    // ---------- pipelines + step library (by id) ----------------------------------

    route({
      method: 'PUT',
      path: '/api/pipelines/:id',
      access: 'pipelines:manage',
      body: savePipelineSchema,
      handler: ({ params, body, user }) => {
        requirePipeline(user, params.id);
        return { pipeline: code.pipelines.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/pipelines/:id',
      access: 'pipelines:manage',
      handler: ({ params, user }) => {
        requirePipeline(user, params.id);
        code.pipelines.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/step-definitions/:id',
      access: 'pipelines:manage',
      body: saveStepDefinitionSchema,
      handler: ({ params, body, user }) => {
        requireStepDefinition(user, params.id);
        return { stepDefinition: code.pipelines.updateStepDefinition(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/step-definitions/:id',
      access: 'pipelines:manage',
      handler: ({ params, user }) => {
        requireStepDefinition(user, params.id);
        code.pipelines.removeStepDefinition(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/pipeline-runs/:id',
      access: 'pipelines:read',
      handler: async ({ params, user }) => ({ run: await requirePipelineRun(user, params.id) }),
    }),

    // ---------- workspace area feeds (code-owned cross-domain reads) --------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/repos',
      access: 'repos:read',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        const rows = code.repos.listByWorkspace(params.id);
        const permissions = await repoPermissions(user!, params.id);
        return {
          repos: rows.map((row) => {
            const permission = permissions.get(row.full_name) ?? null;
            return {
              ...rowToRepo(row),
              githubAccessible: permission !== null,
              githubPermission: permission,
              openIssues: permission ? code.issues.list(row.full_name, 'open').length : 0,
            };
          }),
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/sync',
      access: 'repos:read',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        return code.sync.syncWorkspace(params.id, user!.username);
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/issues',
      access: 'issues:read',
      handler: async ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        const accessibleRepos = await accessibleRepoNames(user!, params.id);
        const myLogins = code.githubAccounts.list().filter((account) => account.ownerId === user!.username).map((account) => account.login);
        const state = query.get('state');
        return code.issues.listWorkspacePaged(
          params.id,
          state === 'open' || state === 'closed' ? state : undefined,
          {
            q: query.get('q') ?? undefined,
            repo: query.get('repo') ?? undefined,
            author: query.get('author') ?? undefined,
            assignee: query.get('assignee') ?? undefined,
            label: query.get('label') ?? undefined,
            triage: pick(query.get('triage'), ['pending', 'applied', 'dismissed'] as const),
            limit: Number(query.get('limit')) || undefined,
            offset: Number(query.get('offset')) || undefined,
            accessibleRepos,
            myLogins,
          },
        );
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/prs',
      access: 'prs:read',
      handler: async ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        const accessibleRepos = await accessibleRepoNames(user!, params.id);
        const myLogins = code.githubAccounts.list().filter((account) => account.ownerId === user!.username).map((account) => account.login);
        const state = query.get('state');
        const page = code.prs.listWorkspacePaged(
          params.id,
          state === 'open' || state === 'merged' || state === 'closed' ? state : undefined,
          {
            q: query.get('q') ?? undefined,
            repo: query.get('repo') ?? undefined,
            author: query.get('author') ?? undefined,
            assignee: query.get('assignee') ?? undefined,
            decision: pick(query.get('decision'), ['approved', 'changes_requested', 'none'] as const),
            review: pick(query.get('review'), ['pending', 'applied', 'dismissed'] as const),
            draft: pick(query.get('draft'), ['hide', 'only'] as const),
            limit: Number(query.get('limit')) || undefined,
            offset: Number(query.get('offset')) || undefined,
            accessibleRepos,
            myLogins,
          },
        );
        // Warm missing/stale check snapshots for exactly the page being viewed;
        // each landing snapshot broadcasts prs.changed so the list fills in live.
        code.prChecks.preloadWorkspace(params.id, page.prs, user!.username);
        return page;
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/pipelines',
      access: 'pipelines:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return {
          pipelines: code.pipelines.list(params.id),
          stepDefinitions: code.pipelines.listStepDefinitions(params.id),
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/pipelines',
      access: 'pipelines:manage',
      body: savePipelineSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        return created({ pipeline: code.pipelines.create(params.id, body) });
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/step-definitions',
      access: 'pipelines:manage',
      body: saveStepDefinitionSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        return created({ stepDefinition: code.pipelines.createStepDefinition(params.id, body) });
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/pipeline-runs',
      access: 'pipelines:read',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        const accessible = new Set(await accessibleRepoNames(user!, params.id));
        return { runs: pipelinesStore.listWorkspaceRuns(params.id).filter((run) => accessible.has(run.repo)) };
      },
    }),

    // ---------- AI generation (skills, custom steps, pipelines) -------------------
    // A bounded companion runner (one-shot agent turn) drafts skills, custom
    // steps, and pipelines from plain-language instructions. Drafts are
    // validated against the same zod schemas as manual input; skills come back
    // for review in the editor, steps/pipelines are created (never auto-run)
    // and opened for editing.

    route({
      method: 'POST',
      path: '/api/skills/generate',
      access: 'skills:manage',
      body: genSchema,
      handler: async ({ body, user }) => {
        const reply = await oneShot(
          'Generate skill',
          `You are drafting an agent skill for Companion — a markdown file injected into every agent run (triage, code review, fixes) to teach conventions or domain knowledge. Do not modify any files.

The maintainer wants: ${body.instructions}

Reply with ONLY a fenced json block:
\`\`\`json
{ "name": "<kebab-case-slug>", "content": "<the full markdown skill: when to use it, then concrete instructions>" }
\`\`\``,
        );
        try {
          return { draft: skillDraftSchema.parse(extractJson(reply)) };
        } catch {
          throw badRequest('the agent reply was not a valid skill draft — try rephrasing');
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/step-definitions/generate',
      access: 'pipelines:manage',
      body: genSchema,
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        const reply = await oneShot(
          'Generate custom step',
          `You are drafting one reusable pipeline step for Companion's PR pipelines. Do not modify any files.

${STEP_SCHEMA_DOC}
${skillsNote()}
The maintainer wants: ${body.instructions}

Reply with ONLY a fenced json block matching:
\`\`\`json
{ "name": "<step library name>", "description": "<one line>", "step": <one step object as documented> }
\`\`\``,
        );
        let draft;
        try {
          draft = saveStepDefinitionSchema.parse(extractJson(reply));
        } catch {
          throw badRequest('the agent reply was not a valid step definition — try rephrasing');
        }
        return created({ stepDefinition: code.pipelines.createStepDefinition(params.id, draft) });
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/pipelines/generate',
      access: 'pipelines:manage',
      body: genSchema,
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        const reply = await oneShot(
          'Generate pipeline',
          `You are drafting a pipeline for Companion: an ordered set of steps with a type that decides its payload. Types: "pr" (runs against pull requests; all step kinds allowed), "issue" (runs against issues; only agent/label/comment steps), "platform" (runs against the repo itself; agent steps only). Pick the type that fits the request. Do not modify any files.

${STEP_SCHEMA_DOC}
${skillsNote()}
The maintainer wants: ${body.instructions}

Reply with ONLY a fenced json block matching:
\`\`\`json
{ "type": "pr" | "issue" | "platform", "name": "<pipeline name>", "description": "<one line>", "steps": [ { "type": "inline", "step": <step object> }, ... ] }
\`\`\``,
        );
        let draft;
        try {
          // Generated pipelines never auto-run — a human flips that on after review.
          draft = savePipelineSchema.parse({ ...(extractJson(reply) as object), autoRunOnPrOpen: false });
        } catch {
          throw badRequest('the agent reply was not a valid pipeline — try rephrasing');
        }
        return created({ pipeline: code.pipelines.create(params.id, draft) });
      },
    }),

    // ---------- fix flow on a run (operate's carve left these to code) ------------

    route({
      method: 'GET',
      path: '/api/runs/:id/diff',
      access: 'runs:read',
      handler: ({ params, user }) => {
        requireRunAccess(user, params.id);
        return code.fixes.diff(params.id);
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/approve-pr',
      access: 'runs:act',
      body: approvePrSchema,
      handler: ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        return code.fixes.approve(params.id, body, user!.username);
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/discard',
      access: 'runs:act',
      handler: async ({ params, user }) => {
        requireRunAccess(user, params.id);
        await code.fixes.discard(params.id);
        return { ok: true };
      },
    }),

    // ---------- onboarding: the single-PAT setup path ------------------------------

    route({
      method: 'POST',
      path: '/api/settings/github',
      access: 'settings:manage',
      body: ghTokenSchema,
      handler: async ({ body, user }) => {
        // Onboarding path: the first token gets every purpose; rebinding happens
        // in Settings → GitHub accounts (mirrors the legacy setGithubToken).
        const account = await code.githubAccounts.add(
          body.token,
          ['fetch', 'runs', 'pipelines', 'webhooks'],
          user!.username,
          'all',
          [],
        );
        settings.delete('github_token');
        ctx.broadcast({ t: 'repos.changed' });
        return { login: account.login };
      },
    }),
  ];
});

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}
