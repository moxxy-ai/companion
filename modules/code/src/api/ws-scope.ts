import type { AuthUser, Permission, SpaServerMessage } from '@moxxy/companion-contracts';
import type { ModuleContext, ScopeResolver } from '@moxxy/companion-sdk/server';

/**
 * Who may see a pipeline step's live output.
 *
 * `pipelineStep.output` carries the raw stdout of a command run inside a private
 * repository's checkout, which can name files, print environment detail, or
 * quote source. The synchronous WS scope cannot perform the personal GitHub
 * credential check used by REST, so raw chunks go only to the run owner. Other
 * maintainers read the same bounded, scrubbed tail through the authenticated
 * log route.
 *
 * Registered in onEnable, so disabling this module removes the claim with it.
 */
export function createStepOutputScopeResolver(): ScopeResolver {
  return (msg) => {
    if (msg.t !== 'pipelineStep.output') return null;
    return (username: string): boolean => username === msg.ownerId;
  };
}

/**
 * Every message this module emits that names a repository, and the read
 * permission the REST route returning the same thing requires.
 *
 * A repository name is not a content-free signal. `full_name` is the one field
 * that says a private workspace contains `acme/secret-acquisition`, and the hub
 * broadcasts anything no resolver claims, so leaving these unclaimed told every
 * authenticated socket which repositories exist and when they change. That is
 * precisely the boundary `canAccessRepo` draws for the REST routes.
 */
const REPO_SCOPED: Readonly<Record<string, Permission>> = {
  'issues.changed': 'issues:read',
  'triage.changed': 'issues:read',
  'prs.changed': 'prs:read',
  'prStatus.changed': 'prs:read',
  'pipelineRuns.changed': 'pipelines:read',
};

/** The messages above, all carrying `repo`; narrowed once so the scope can read it. */
function repoOf(msg: SpaServerMessage): { repo: string; permission: Permission } | null {
  const permission = REPO_SCOPED[msg.t];
  if (!permission) return null;
  const repo = (msg as { repo?: unknown }).repo;
  return typeof repo === 'string' ? { repo, permission } : null;
}

/**
 * Repository-scoped signals follow the same permission + workspace boundary as
 * the route that would otherwise return them.
 */
export function createRepoScopeResolver(ctx: ModuleContext): ScopeResolver {
  return (msg) => {
    const scoped = repoOf(msg);
    if (!scoped) return null;
    return (username: string): boolean => {
      const role = ctx.services.get('core').activeUserRole(username);
      if (!role) return false;
      const user: AuthUser = { username, displayName: username, role };
      return (
        ctx.rbac.allows(user, scoped.permission) &&
        ctx.services.get('workspace').canAccessRepo(user, scoped.repo)
      );
    };
  };
}

/** The message types `createRepoScopeResolver` claims, for the contract-coverage test. */
export const repoScopedMessageTypes: readonly string[] = Object.keys(REPO_SCOPED);
