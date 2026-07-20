import { z } from 'zod';
import { accepted, badRequest, created, defineRoutes, notFound, route } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { RefineMethodRecord } from '../contract/index.js';
import '../contract/index.js';

const createSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z.string().max(200).optional(),
  title: z.string().trim().min(3).max(200),
  story: z.string().trim().min(8).max(32_000),
});

const updateSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  story: z.string().trim().min(8).max(32_000).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
});

const decomposeSchema = z.object({
  methodId: z.string().min(1),
  specIds: z.array(z.string()).max(5).default([]),
  docIds: z.array(z.string()).max(5).default([]),
});

const importSchema = z.object({
  queue: z.boolean().default(false),
});

const saveMethodSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(300).default(''),
  instructions: z.string().trim().min(8).max(8_000),
});

const patchMethodSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().max(300).optional(),
  instructions: z.string().trim().min(8).max(8_000).optional(),
});

export default defineRoutes((ctx) => {
  const refinement = ctx.services.get('refinement');
  const workspace = ctx.services.get('workspace');

  /** A refinement in a workspace the caller can't reach reads as "not found". */
  const requireRefinement = (user: AuthUser | null, id: string) => {
    const detail = refinement.get(id);
    if (!detail || !user || !workspace.canAccessRepo(user, detail.refinement.repo)) {
      throw notFound('refinement not found');
    }
    return detail;
  };

  // A private workspace the caller isn't in reads as "not found" — the house
  // convention (existence is not leaked).
  const requireWorkspace = (user: AuthUser | null, id: string): void => {
    workspace.requireAccessible(user, id);
  };

  // Custom methods are workspace-owned: mutating one you can't reach reads as
  // "not found". Built-in ids fall through — the service rejects those edits
  // with the clearer built-in message.
  const requireMethodAccess = (user: AuthUser | null, id: string): void => {
    if (id.startsWith('builtin-')) return;
    const method = refinement.customMethod(id);
    if (!method || !user || method.workspaceId === null || !workspace.canAccessWorkspace(user, method.workspaceId)) {
      throw notFound('method not found');
    }
  };

  return [
    route({
      method: 'GET',
      path: '/api/workspaces/:id/refinements',
      access: 'refine:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { refinements: refinement.listByWorkspace(params.id) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/refinements',
      access: 'refine:manage',
      body: createSchema,
      handler: ({ body, user }) => {
        if (!user || !workspace.canAccessRepo(user, body.repo)) throw notFound(`repo ${body.repo} not connected`);
        try {
          return created({ refinement: refinement.create(body) });
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'GET',
      path: '/api/refinements/:id',
      access: 'refine:read',
      handler: ({ params, user }) => requireRefinement(user, params.id),
    }),

    route({
      method: 'PUT',
      path: '/api/refinements/:id',
      access: 'refine:manage',
      body: updateSchema,
      handler: ({ params, body, user }) => {
        requireRefinement(user, params.id);
        try {
          return { refinement: refinement.update(params.id, body) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/refinements/:id',
      access: 'refine:manage',
      handler: ({ params, user }) => {
        requireRefinement(user, params.id);
        refinement.remove(params.id);
        return { ok: true };
      },
    }),

    // Validation (unknown/foreign method, already running) surfaces as a 400;
    // only the minutes-long agent phase is fire-and-forget — its transitions
    // stream over WS (refinement.changed) and a failure lands as status 'failed'.
    route({
      method: 'POST',
      path: '/api/refinements/:id/decompose',
      access: 'refine:manage',
      body: decomposeSchema,
      handler: ({ params, body, user }) => {
        requireRefinement(user, params.id);
        let method: RefineMethodRecord;
        try {
          method = refinement.startDecompose(params.id, body);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        void refinement.runDecompose(params.id, method).catch(() => undefined);
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'GET',
      path: '/api/refinements/:id/context-options',
      access: 'refine:read',
      handler: ({ params, user }) => {
        requireRefinement(user, params.id);
        return refinement.contextOptions(params.id);
      },
    }),

    route({
      method: 'POST',
      path: '/api/refinements/:id/items/:itemId/import',
      access: 'refine:manage',
      body: importSchema,
      handler: ({ params, body, user }) => {
        requireRefinement(user, params.id);
        try {
          return { item: refinement.importItem(params.id, params.itemId, user?.username ?? null, body.queue) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/refinements/:id/items/:itemId/dismiss',
      access: 'refine:manage',
      handler: ({ params, user }) => {
        requireRefinement(user, params.id);
        try {
          return { item: refinement.dismissItem(params.id, params.itemId) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/refinements/:id/import-all',
      access: 'refine:manage',
      body: importSchema,
      handler: ({ params, body, user }) => {
        requireRefinement(user, params.id);
        try {
          return { imported: refinement.importAll(params.id, user?.username ?? null, body.queue) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/refine-methods',
      access: 'refine:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { methods: refinement.methods(params.id) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/refine-methods',
      access: 'refine:manage',
      body: saveMethodSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        return created({ method: refinement.saveMethod(params.id, body) });
      },
    }),

    route({
      method: 'PUT',
      path: '/api/refine-methods/:id',
      access: 'refine:manage',
      body: patchMethodSchema,
      handler: ({ params, body, user }) => {
        requireMethodAccess(user, params.id);
        try {
          return { method: refinement.updateMethod(params.id, body) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/refine-methods/:id',
      access: 'refine:manage',
      handler: ({ params, user }) => {
        requireMethodAccess(user, params.id);
        try {
          refinement.deleteMethod(params.id);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        return { ok: true };
      },
    }),
  ];
});
