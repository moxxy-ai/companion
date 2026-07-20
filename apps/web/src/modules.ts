import type { ClientLoader } from '@companion/core/client';

/**
 * The static client-module registry — the ONLY place the SPA names its
 * modules. The ModulesProvider fetches GET /api/modules and dynamic-imports
 * ONLY the enabled modules' `/client` chunks (Vite code-splits one per module;
 * a disabled module's JS is never fetched). Installing a new module = one entry
 * here (+ one in apps/api/src/modules.ts) + a rebuild.
 */
export const CLIENT_LOADERS: Readonly<Record<string, ClientLoader>> = {
  core: () => import('@companion/module-core/client'),
  workspace: () => import('@companion/module-workspace/client'),
  operate: () => import('@companion/module-operate/client'),
  code: () => import('@companion/module-code/client'),
  plan: () => import('@companion/module-plan/client'),
  board: () => import('@companion/module-board/client'),
  refinement: () => import('@companion/module-refinement/client'),
  automations: () => import('@companion/module-automations/client'),
  admin: () => import('@companion/module-admin/client'),
};
