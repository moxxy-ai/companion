import { z } from 'zod';
import {
  addModule,
  defineRoutes,
  route,
  created,
  badRequest,
  documentStream,
  forbidden,
  HttpError,
  isModuleId,
  isRegistrySpec,
  listModuleArtifacts,
  ModuleAlreadyAddedError,
  notFound,
  removeModule,
  Reply,
  sessionCookie,
  clearSessionCookie,
} from '@moxxy/companion-core/server';
import { claimAuditActor, isLoopbackHost, paths, planRestart, restartDaemon } from '@moxxy/companion-services';
import { NAV_AUDIENCES, NAV_PERSPECTIVES, type Permission } from '@moxxy/companion-contracts';
import { AuthError } from './auth.js';
import type {
  AccountInfo,
  AclExplained,
  AclMap,
  AddModuleResponse,
  ApiTokenCapability,
  ApiTokenRecord,
  AuthState,
  CreateApiTokenResponse,
  ExternalModulesResponse,
  LoginResponse,
  MfaChallenge,
  MfaEnrollment,
  MfaRecoveryCodes,
  ProfileResponse,
  RemoveModuleResponse,
  RestartResponse,
  SessionInfo,
  SessionRecord,
} from '../contract/index.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
// Roles are instance data now, so membership is checked against the live grid
// in the handler rather than pinned to a compile-time enum.
const roleSchema = z.string().trim().min(2).max(40);

const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) });
const mfaCompleteSchema = z.object({
  mfaToken: z.string().min(16).max(200),
  code: z.string().trim().min(6).max(60),
});
const mfaCodeSchema = z.object({ code: z.string().trim().min(6).max(60) });
const setupSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'letters, digits, dots, dashes (2-40 chars)'),
  email: z.string().email().max(200),
  password: z.string().min(8).max(500),
  bootstrapToken: z.string().min(32).max(500),
});
const createUserSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'letters, digits, dots, dashes (2-40 chars)'),
  displayName: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(500),
  role: roleSchema,
});
const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(500).optional(),
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
});
const createRoleSchema = z.object({
  id: z.string().trim().min(2).max(40),
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  /** Clone the source's EFFECTIVE permissions as explicit grants. */
  from: roleSchema.optional(),
});
const adjustRoleSchema = z.object({
  mode: z.enum(['grant', 'revoke', 'reset']),
  permissions: z.array(z.string().trim().min(3).max(80)).min(1).max(200),
});
/**
 * A spec from the UI is deliberately narrower than what `npm pack` accepts.
 * The CLI keeps the full range because whoever runs it already has a shell on
 * the host; a browser does not, and the two extra powers are not small. A path
 * spec would make "add a module" mean "copy any directory the daemon can read
 * into the directory the daemon imports from", and a git spec is worse, because
 * npm builds those, running the repository's `prepare` script as the daemon
 * user before anything has been verified.
 */
const addModuleSchema = z.object({
  spec: z
    .string()
    .trim()
    .min(1)
    .max(214)
    .refine(isRegistrySpec, 'expected a registry package: name or @scope/name, optionally @version or @tag'),
  force: z.boolean().optional(),
});
const scopeEnum = z.enum(['workspace', 'global']);
const navigationPageOverrideSchema = z.object({
  perspective: z.enum(NAV_AUDIENCES),
  key: z.string().min(1).max(64),
  visible: z.boolean(),
});
const updateProfileSchema = z.object({
  notificationScope: scopeEnum.nullable().optional(),
  // Three presets × at most 200 module-owned entry keys. The server persists
  // these cosmetic deviations but never treats them as access control.
  navOverrides: z.array(navigationPageOverrideSchema).max(600).optional(),
  navPerspective: z.enum(NAV_PERSPECTIVES).optional(),
});
const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    email: z.string().email().max(200).optional(),
    currentPassword: z.string().min(1).max(500).optional(),
    newPassword: z.string().min(8).max(500).optional(),
  })
  .refine((b) => b.newPassword === undefined || b.currentPassword !== undefined, {
    message: 'currentPassword is required to set a new password',
    path: ['currentPassword'],
  });
const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string().trim().min(3).max(80)).min(1).max(200),
  expiresInDays: z.number().int().min(1).max(365),
});

export default defineRoutes((ctx) => {
  const auth = ctx.services.get('core');
  const roles = ctx.services.get('roles');
  const audit = ctx.services.get('audit');
  const settings = ctx.services.get('settings');
  const mfa = ctx.services.get('mfa');
  // The config states the canonical URL; the request states what the browser
  // actually spoke. Either one saying https earns `Secure`, so an operator who
  // never set COMPANION_PUBLIC_URL still gets the flag behind a TLS proxy, and
  // a request arriving over plain http cannot strip it from an https instance.
  const secureCookie = (secureConnection: boolean): boolean =>
    ctx.config.publicUrl?.startsWith('https://') === true || secureConnection;
  const browserSession = (
    session: { token: string; user: LoginResponse['user']; expiresAt: number },
    secureConnection: boolean,
  ): Reply =>
    new Reply(
      200,
      { user: session.user, expiresAt: session.expiresAt } satisfies LoginResponse,
      undefined,
      {
        'set-cookie': sessionCookie(session.token, session.expiresAt, secureCookie(secureConnection)),
        'cache-control': 'no-store',
      },
    );
  /** Serialises `add`: two of them would interleave a delete and a copy in one
   *  directory, and the loser would leave half a module on disk. */
  let adding = false;
  /** A user may only be given a role that exists; the schema cannot know the set. */
  const requireRole = (role: string | undefined): void => {
    if (role !== undefined && !ctx.rbac.hasRole(role)) throw badRequest(`unknown role: ${role}`);
  };
  const profileResponse = (username: string): ProfileResponse => ({
    profile: {
      notificationScope: settings.userNotificationScope(username),
      navOverrides: settings.userNavOverrides(username),
      navPerspective: settings.userNavPerspective(username),
    },
    defaults: { notificationScope: settings.notificationDefaultScope() },
  });

  return [
    // ---------- auth ----------
    route({
      method: 'GET',
      path: '/api/auth/state',
      access: 'public',
      handler: (): AuthState => ({
        setup: auth.setupNeeded(),
        authMode: ctx.config.authMode,
        version: ctx.appVersion,
        branding: { name: settings.get('branding.name') || null, logo: settings.get('branding.logo') || null },
        githubHost: ctx.config.github.host,
        providers: auth.providers(),
      }),
    }),
    route({
      method: 'POST',
      path: '/api/auth/local-session',
      access: 'public',
      handler: ({ secureConnection }): Reply => {
        // Defense in depth: config loading already refuses this combination,
        // but this route owns an admin-equivalent credential and rechecks both
        // halves at the point of issuance.
        if (ctx.config.authMode !== 'local' || !isLoopbackHost(ctx.config.host)) {
          throw new AuthError('local session bootstrap is disabled', 403);
        }
        return browserSession(auth.localSession(), secureConnection);
      },
    }),
    route({
      method: 'POST',
      path: '/api/auth/setup',
      access: 'public',
      body: setupSchema,
      handler: ({ body, secureConnection }): Reply => {
        // Before the attempt: a refused setup audits against the tried name too.
        claimAuditActor(body.username);
        const session = auth.setup(body.username, body.email, body.password, body.bootstrapToken);
        ctx.bus.emit('auth.setup.completed', { username: session.user.username });
        return browserSession(session, secureConnection);
      },
    }),
    route({
      method: 'POST',
      path: '/api/auth/login',
      access: 'public',
      body: loginSchema,
      handler: ({ body, clientAddress, secureConnection }): Reply => {
        if (ctx.config.authMode === 'sso') {
          throw new AuthError('password sign-in is disabled: this instance requires single sign-on', 403);
        }
        // The router cannot attribute a public route; claiming the attempted
        // identity up front records success AND refusal against a name instead
        // of `actor: null` (the audit gap every reviewer asks about first).
        claimAuditActor(body.username);
        const result = auth.login(body.username, body.password, clientAddress);
        // An MFA challenge is not a session: no cookie until the second step.
        return 'mfaRequired' in result
          ? new Reply(200, result satisfies MfaChallenge, undefined, { 'cache-control': 'no-store' })
          : browserSession(result, secureConnection);
      },
    }),
    route({
      method: 'POST',
      path: '/api/auth/mfa',
      access: 'public',
      body: mfaCompleteSchema,
      handler: ({ body, clientAddress, secureConnection }): Reply => {
        const session = auth.completeMfaLogin(body.mfaToken, body.code, clientAddress);
        // Only after success: the pending token is opaque, so a failed second
        // step has no name to claim without leaking which token maps to whom.
        claimAuditActor(session.user.username);
        return browserSession(session, secureConnection);
      },
    }),
    route({
      method: 'POST',
      path: '/api/auth/logout',
      access: 'any',
      handler: ({ token, secureConnection }): Reply => {
        if (token) auth.logout(token);
        return new Reply(200, { ok: true }, undefined, {
          'set-cookie': clearSessionCookie(secureCookie(secureConnection)),
          'cache-control': 'no-store',
        });
      },
    }),
    route({
      method: 'GET',
      path: '/api/auth/me',
      access: 'any',
      allowScopedToken: true,
      handler: ({ user }): SessionInfo => {
        if (!user) throw new AuthError('authentication required', 401);
        return auth.sessionInfo(user);
      },
    }),

    // ---------- managed API tokens ----------
    route({
      method: 'GET',
      path: '/api/tokens',
      access: 'tokens:manage',
      handler: ({ user }): { tokens: ApiTokenRecord[]; capabilities: ApiTokenCapability[] } => ({
        tokens: auth.listApiTokens(user!.username),
        capabilities: auth.apiTokenCapabilities(user!),
      }),
    }),
    route({
      method: 'POST',
      path: '/api/tokens',
      access: 'tokens:manage',
      body: createApiTokenSchema,
      handler: ({ body, user }): ReturnType<typeof created> => {
        const response: CreateApiTokenResponse = auth.createApiToken(user!, {
          ...body,
          permissions: body.permissions as Permission[],
        });
        ctx.broadcast({ t: 'tokens.changed' });
        return created(response);
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/tokens/:id',
      access: 'tokens:manage',
      handler: ({ params, user }) => {
        const token = auth.revokeOwnApiToken(user!.username, params.id);
        if (!token) throw notFound(`API token ${params.id} not found`);
        ctx.broadcast({ t: 'tokens.changed' });
        return { ok: true };
      },
    }),
    route({
      method: 'GET',
      path: '/api/admin/tokens',
      access: 'tokens:admin',
      handler: ({ query }): { tokens: ApiTokenRecord[]; total: number } => {
        const limitParam = query.get('limit');
        const offsetParam = query.get('offset');
        const requestedLimit = limitParam === null ? Number.NaN : Number(limitParam);
        const requestedOffset = offsetParam === null ? Number.NaN : Number(offsetParam);
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
          : 100;
        const offset = Number.isFinite(requestedOffset)
          ? Math.min(Math.max(Math.trunc(requestedOffset), 0), 1_000_000)
          : 0;
        return auth.listAllApiTokens({ limit, offset });
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/admin/tokens/:id',
      access: 'tokens:admin',
      handler: ({ params }) => {
        const token = auth.revokeApiToken(params.id);
        if (!token) throw notFound(`API token ${params.id} not found`);
        ctx.broadcast({ t: 'tokens.changed' });
        return { ok: true };
      },
    }),

    // ---------- user management (admin) ----------
    route({
      method: 'GET',
      path: '/api/users',
      access: 'users:manage',
      handler: ({ query }) => {
        const role = query.get('role');
        if (role !== null && !ctx.rbac.hasRole(role)) throw badRequest(`unknown role: ${role}`);
        const limitParam = query.get('limit');
        const limit = limitParam === null ? undefined : Number(limitParam);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw badRequest('limit must be a positive integer');
        }
        return auth.searchUsers({
          q: query.get('q') ?? undefined,
          role: role ?? undefined,
          limit,
          offset: Number(query.get('offset')) || undefined,
        });
      },
    }),
    route({
      method: 'POST',
      path: '/api/users',
      access: 'users:manage',
      body: createUserSchema,
      handler: ({ body }) => {
        requireRole(body.role);
        const user = auth.createUser(body);
        ctx.broadcast({ t: 'users.changed' });
        return created({ user });
      },
    }),
    route({
      method: 'PATCH',
      path: '/api/users/:username',
      access: 'users:manage',
      body: updateUserSchema,
      handler: ({ params, body, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
        requireRole(body.role);
        const updated = auth.updateUser(params.username, body, user);
        if (body.role !== undefined || body.disabled === true || body.password !== undefined) {
          ctx.broadcast({ t: 'tokens.changed' });
        }
        ctx.broadcast({ t: 'users.changed' });
        return { user: updated };
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/users/:username',
      access: 'users:manage',
      handler: ({ params, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
        auth.deleteUser(params.username, user);
        ctx.bus.emit('auth.user.deleted', { username: params.username });
        ctx.broadcast({ t: 'tokens.changed' });
        ctx.broadcast({ t: 'users.changed' });
        return { ok: true };
      },
    }),

    // ---------- audit trail ----------
    route({
      // Keyset-paged, newest first: `before` is the last id the caller saw.
      method: 'GET',
      path: '/api/audit',
      access: 'audit:read',
      handler: ({ query }) => {
        const num = (k: string): number | undefined => {
          const v = Number(query.get(k));
          return Number.isFinite(v) && query.get(k) !== null ? v : undefined;
        };
        const entries = audit.list({
          actor: query.get('actor') ?? undefined,
          module: query.get('module') ?? undefined,
          since: num('since'),
          until: num('until'),
          before: num('before'),
          limit: num('limit'),
        });
        return { entries, nextBefore: entries.length ? entries[entries.length - 1]!.id : null };
      },
    }),
    route({
      // The stream's own health, so a collector that quietly stopped accepting
      // batches is visible next to the trail rather than only in the log.
      method: 'GET',
      path: '/api/audit/forwarding',
      access: 'audit:read',
      handler: () => ctx.services.get('auditForwarder').state(),
    }),
    route({
      // Evidence an export consumer can act on: whether the retained trail is
      // still the one that was written. Not on the export itself, because a
      // reader wants the verdict without streaming the whole table.
      method: 'GET',
      path: '/api/audit/integrity',
      access: 'audit:read',
      handler: () => audit.verifyChain(),
    }),
    route({
      // "Get our data out" as one real NDJSON stream: one bounded DB page and
      // one response chunk at a time, with HTTP backpressure.
      method: 'GET',
      path: '/api/audit/export',
      access: 'audit:read',
      handler: ({ query }) => {
        const since = Number(query.get('since'));
        const entries = async function* (): AsyncGenerator<string> {
          let before: number | undefined;
          for (;;) {
            const page = audit.list({ since: Number.isFinite(since) ? since : undefined, before, limit: 1000 });
            if (!page.length) return;
            yield `${page.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
            before = page[page.length - 1]!.id;
          }
        };
        return documentStream(entries(), 'application/x-ndjson', 'companion-audit.ndjson');
      },
    }),

    // ---------- roles (instance-defined; modules only grant to the built-ins) ----------
    route({
      method: 'GET',
      path: '/api/roles',
      access: 'users:manage',
      handler: () => ({ roles: roles.list() }),
    }),
    route({
      method: 'GET',
      path: '/api/roles/:id',
      access: 'users:manage',
      handler: ({ params }) => ({ role: roles.detail(params.id) }),
    }),
    route({
      method: 'POST',
      path: '/api/roles',
      access: 'users:manage',
      body: createRoleSchema,
      handler: ({ body, user }) => {
        const role = roles.create(user!.username, body);
        ctx.broadcast({ t: 'roles.changed' });
        return created({ role });
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/roles/:id',
      access: 'users:manage',
      handler: ({ params, user }) => {
        roles.delete(user!.username, params.id);
        ctx.broadcast({ t: 'roles.changed' });
        return { ok: true };
      },
    }),
    route({
      // grant / revoke pin the answer for this role; reset drops the override so
      // the role falls back to whatever its modules grant.
      method: 'POST',
      path: '/api/roles/:id/permissions',
      access: 'users:manage',
      body: adjustRoleSchema,
      handler: ({ params, body, user }) => {
        const actor = user!.username;
        const apply = { grant: roles.grant, revoke: roles.revoke, reset: roles.reset }[body.mode];
        const role = apply.call(roles, actor, params.id, body.permissions);
        ctx.broadcast({ t: 'roles.changed' });
        return { role };
      },
    }),

    // ---------- ACL introspection (who may do what, and why) ----------
    route({
      // The grid as the kernel computes it right now: a disabled module's
      // permissions are absent, which is the whole point of asking the daemon
      // instead of reading acl.ts.
      method: 'GET',
      path: '/api/acl',
      access: 'users:manage',
      handler: (): AclMap => ({
        roles: ctx.rbac.roles().map((id) => ({ id, permissions: ctx.rbac.permissionsFor(id).sort() })),
        permissions: ctx.rbac
          .catalog()
          .map((p) => ({ ...p, grants: ctx.rbac.roles().filter((r) => ctx.rbac.has(r, p.id)) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    }),
    route({
      method: 'GET',
      path: '/api/acl/explain',
      access: 'users:manage',
      handler: ({ query }): AclExplained => {
        const subject = query.get('subject')?.trim();
        const permission = query.get('permission')?.trim();
        if (!subject || !permission) throw badRequest('subject and permission are required');
        // A subject is a role name, or a username whose CURRENT role is resolved
        // live: explaining against a stale role would be worse than not answering.
        const isRole = ctx.rbac.hasRole(subject);
        const role = isRole ? subject : auth.userRole(subject);
        if (!role) throw badRequest(`'${subject}' is neither a role nor a known user`);
        // Deliberately unvalidated against the union: answering "nothing
        // declares that" is the most useful reply to a typo.
        const explained = ctx.rbac.explain(role, permission as Permission);
        // The grid only knows ENABLED modules, so a permission belonging to a
        // disabled one looks identical to a typo. The catalog does know, and
        // "install slop" is a far better answer than "no such permission".
        const dormant = explained.owner
          ? null
          : ctx.modules.list().find((m) => m.permissions.includes(permission));
        return {
          ...explained,
          owner: explained.owner ?? dormant?.id ?? null,
          ownerEnabled: explained.owner !== null,
          ownerInstalled: explained.owner !== null || (dormant?.installed ?? false),
          username: isRole ? null : subject,
        };
      },
    }),

    // ---------- modules (runtime toggles; the SPA bootstraps from the list) ----------
    route({
      method: 'GET',
      path: '/api/modules',
      access: 'any',
      allowScopedToken: true,
      handler: () => ({ modules: ctx.modules.list() }),
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/enable',
      access: 'modules:manage',
      handler: async ({ params }) => {
        await ctx.modules.enable(params.id);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/disable',
      access: 'modules:manage',
      handler: async ({ params }) => {
        await ctx.modules.disable(params.id);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/uninstall',
      access: 'modules:manage',
      handler: async ({ params }) => {
        await ctx.modules.uninstall(params.id);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/install',
      access: 'modules:manage',
      body: z.object({ config: z.record(z.unknown()).optional() }),
      handler: async ({ params, body }) => {
        await ctx.modules.install(params.id, body.config);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'GET',
      path: '/api/modules/:id/config',
      access: 'modules:manage',
      handler: ({ params }) => ctx.modules.getConfig(params.id),
    }),

    // ---------- out-of-tree module artifacts (files on the host, not switches) ----------
    route({
      // What is in the modules directory, which is not what the kernel has
      // loaded: the scan runs once at boot, so `loaded: false` is a module
      // whose files are here and whose code is not running.
      method: 'GET',
      path: '/api/modules/external',
      access: 'modules:manage',
      handler: (): ExternalModulesResponse => {
        const root = paths.externalModules();
        const loaded = new Set(ctx.modules.list().filter((m) => m.external).map((m) => m.id));
        return {
          root,
          modules: listModuleArtifacts(root).map((a) => ({ ...a, loaded: loaded.has(a.id) })),
          supervisor: planRestart().supervisor,
        };
      },
    }),
    route({
      // Downloads code and puts it on the host, so it is its own permission and
      // it writes its own audit line: the router records the route pattern, and
      // for this one the operand is the whole point.
      method: 'POST',
      path: '/api/modules/add',
      access: 'modules:deploy',
      body: addModuleSchema,
      handler: async ({ body, user }): Promise<AddModuleResponse> => {
        if (adding) throw new HttpError(429, 'another module is being added; wait for that to finish');
        adding = true;
        try {
          const result = await addModule(body.spec, paths.externalModules(), body.force === true).catch(
            (err: unknown) => {
              // 409 so the caller can offer to replace without reading prose.
              if (err instanceof ModuleAlreadyAddedError) throw new HttpError(409, err.message);
              throw err;
            },
          );
          const p = result.provenance;
          ctx.audit.record({
            at: Date.now(),
            actor: user?.username ?? null,
            action: 'POST /api/modules/add',
            access: 'modules:deploy',
            status: 200,
            module: 'core',
            detail:
              `${result.id}: ${p.name}@${p.version} from '${p.spec}'` +
              `${p.registry ? ` via ${p.registry}` : ''} (${p.integrity ?? 'no integrity'})`,
          });
          // Nothing in the kernel changed, but the artifact list did.
          ctx.broadcast({ t: 'modules.changed' });
          return { id: result.id, replaced: result.replaced, notes: result.notes, provenance: p };
        } finally {
          adding = false;
        }
      },
    }),
    route({
      // `uninstall` plus deleting the files, which is the only version of the
      // verb that makes a module actually go away: uninstall alone leaves the
      // directory, so the next boot scans it back in as Available.
      method: 'POST',
      path: '/api/modules/:id/remove',
      access: 'modules:deploy',
      handler: async ({ params, user }): Promise<RemoveModuleResponse> => {
        const id = params.id;
        if (!isModuleId(id)) throw badRequest(`'${id}' is not a module id`);
        const known = ctx.modules.list().find((m) => m.id === id);
        if (known && !known.external) {
          throw forbidden(`'${id}' is compiled into this build, so its files are not Companion's to delete`);
        }
        // Migrations down and configuration wiped BEFORE the files go: deleting
        // first would leave tables whose down() can no longer be imported.
        if (known) await ctx.modules.uninstall(id);
        const removed = removeModule(id, paths.externalModules());
        // Nothing loaded, no files, no ledger row: there was no such module.
        // Files that arrived after boot ARE removable, which is the whole
        // reason this does not simply ask the kernel.
        if (!known && !removed.removed && !removed.provenance) throw notFound(`unknown module: ${id}`);
        // The catalog entry outlives the files otherwise, and installing it
        // would import a path that no longer exists.
        if (known) ctx.modules.forget(id);
        ctx.audit.record({
          at: Date.now(),
          actor: user?.username ?? null,
          action: 'POST /api/modules/:id/remove',
          access: 'modules:deploy',
          status: 200,
          module: 'core',
          detail: `${id}: deleted ${removed.dir}${removed.provenance ? ` (${removed.provenance.name}@${removed.provenance.version})` : ''}`,
        });
        ctx.broadcast({ t: 'modules.changed' });
        return { id, uninstalled: known !== undefined, deleted: removed.removed };
      },
    }),
    route({
      // The scan runs once at boot, so files on disk are not a loaded module.
      // Exits through the normal SIGTERM path (every onDisable runs, the
      // database closes); whether Companion comes back is `supervisor`'s
      // business, and an unsupervised daemon starts its own successor first.
      method: 'POST',
      path: '/api/modules/restart',
      access: 'modules:deploy',
      handler: ({ user }): RestartResponse => {
        ctx.log.warn(`restart requested by ${user?.username ?? 'unknown'}`);
        const plan = restartDaemon();
        return { supervisor: plan.supervisor, reexec: plan.reexec };
      },
    }),
    route({
      method: 'PUT',
      path: '/api/modules/:id/config',
      access: 'modules:manage',
      body: z.object({ config: z.record(z.unknown()) }),
      handler: ({ params, body }) => {
        ctx.modules.setConfig(params.id, body.config);
        return ctx.modules.getConfig(params.id);
      },
    }),

    // ---------- self-service account + profile (any signed-in user) ----------
    route({
      method: 'GET',
      path: '/api/profile',
      access: 'any',
      handler: ({ user }): ProfileResponse => {
        if (!user) throw new AuthError('authentication required', 401);
        return profileResponse(user.username);
      },
    }),
    route({
      method: 'PUT',
      path: '/api/profile',
      access: 'any',
      body: updateProfileSchema,
      handler: ({ user, body }): ProfileResponse => {
        if (!user) throw new AuthError('authentication required', 401);
        if ('notificationScope' in body) settings.setUserNotificationScope(user.username, body.notificationScope ?? null);
        if (body.navOverrides) settings.setUserNavOverrides(user.username, body.navOverrides);
        if (body.navPerspective) settings.setUserNavPerspective(user.username, body.navPerspective);
        return profileResponse(user.username);
      },
    }),
    route({
      method: 'GET',
      path: '/api/account',
      access: 'any',
      handler: ({ user }): { account: AccountInfo } => {
        if (!user) throw new AuthError('authentication required', 401);
        return { account: auth.ownAccount(user.username) };
      },
    }),
    route({
      method: 'PUT',
      path: '/api/account',
      access: 'any',
      body: updateAccountSchema,
      handler: ({ user, body }): { account: AccountInfo } => {
        if (!user) throw new AuthError('authentication required', 401);
        const account = auth.updateOwnAccount(user.username, body);
        if (body.newPassword !== undefined) ctx.broadcast({ t: 'tokens.changed' });
        ctx.broadcast({ t: 'users.changed' });
        return { account };
      },
    }),

    // ---------- session inventory (self-service; admin under /api/users) ----------
    route({
      method: 'GET',
      path: '/api/me/sessions',
      access: 'any',
      handler: ({ user, token }): { sessions: SessionRecord[] } => {
        if (!user) throw new AuthError('authentication required', 401);
        return { sessions: auth.listSessions(user.username, token) };
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/me/sessions/:id',
      access: 'any',
      handler: ({ user, params }) => {
        if (!user) throw new AuthError('authentication required', 401);
        // Revoking the session serving this request is allowed: it logs you out.
        if (!auth.revokeOwnSession(user.username, params.id)) throw notFound(`session ${params.id} not found`);
        return { ok: true };
      },
    }),
    route({
      method: 'GET',
      path: '/api/users/:username/sessions',
      access: 'users:manage',
      handler: ({ params, token }): { sessions: SessionRecord[] } => ({
        sessions: auth.listSessions(params.username, token),
      }),
    }),
    route({
      // Sessions are not broadcast state: the signed-out user simply 401s on
      // their next request, so no message accompanies this.
      method: 'DELETE',
      path: '/api/users/:username/sessions',
      access: 'users:manage',
      handler: ({ params }) => ({ ok: true, revoked: auth.revokeAllSessions(params.username) }),
    }),

    // ---------- MFA (self-service enrollment; admin reset lives with /api/users) ----------
    route({
      method: 'POST',
      path: '/api/mfa/enroll',
      access: 'any',
      handler: ({ user }): MfaEnrollment => {
        if (!user) throw new AuthError('authentication required', 401);
        return mfa.beginEnrollment(user.username, settings.get('branding.name') || 'Companion');
      },
    }),
    route({
      method: 'POST',
      path: '/api/mfa/confirm',
      access: 'any',
      body: mfaCodeSchema,
      handler: ({ user, body }): MfaRecoveryCodes => {
        if (!user) throw new AuthError('authentication required', 401);
        const recoveryCodes = mfa.confirmEnrollment(user.username, body.code);
        ctx.broadcast({ t: 'users.changed' });
        return { recoveryCodes };
      },
    }),
    route({
      method: 'POST',
      path: '/api/mfa/recovery-codes',
      access: 'any',
      body: mfaCodeSchema,
      handler: ({ user, body }): MfaRecoveryCodes => {
        if (!user) throw new AuthError('authentication required', 401);
        return { recoveryCodes: mfa.regenerateRecoveryCodes(user.username, body.code) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/mfa/disable',
      access: 'any',
      body: mfaCodeSchema,
      handler: ({ user, body }) => {
        if (!user) throw new AuthError('authentication required', 401);
        mfa.disable(user.username, body.code);
        ctx.broadcast({ t: 'users.changed' });
        return { ok: true };
      },
    }),
    route({
      // Support recovery for a lost authenticator: users:manage turns the second
      // factor off; the user signs in with their password and re-enrolls.
      method: 'DELETE',
      path: '/api/users/:username/mfa',
      access: 'users:manage',
      handler: ({ params }) => {
        const user = auth.resetUserMfa(params.username);
        ctx.broadcast({ t: 'users.changed' });
        return { user };
      },
    }),
  ];
});
