import type { InstalledModule } from '@companion/core/server';
import coreManifest from '@companion/module-core/manifest';
import workspaceManifest from '@companion/module-workspace/manifest';
import operateManifest from '@companion/module-operate/manifest';
import codeManifest from '@companion/module-code/manifest';
import planManifest from '@companion/module-plan/manifest';
import boardManifest from '@companion/module-board/manifest';
import refinementManifest from '@companion/module-refinement/manifest';
import automationsManifest from '@companion/module-automations/manifest';
import adminManifest from '@companion/module-admin/manifest';

// The contract slices open the shared unions (Permission / SpaServerMessage /
// ServiceMap / BusEvents) for this compilation — the registries stay
// exhaustively typed across exactly the installed set. Types are erased; the
// heavy /api code below stays behind lazy load() thunks.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
import '@companion/module-plan/contract';
import '@companion/module-board/contract';
import '@companion/module-refinement/contract';
import '@companion/module-automations/contract';
import '@companion/module-admin/contract';

/**
 * The static module registry — the ONLY place the daemon names its modules.
 * Manifests are cheap metafiles (id/title/dependsOn/required) imported
 * statically so the kernel can build the dependency graph and serve
 * GET /api/modules without loading any module's code; a module's /api barrel is
 * dynamic-imported only when it is enabled. Installing a new module = one entry
 * here (+ one in apps/web's CLIENT_LOADERS) + a rebuild.
 */
export const MODULES: readonly InstalledModule[] = [
  { manifest: coreManifest, load: () => import('@companion/module-core/api').then((m) => m.default) },
  { manifest: workspaceManifest, load: () => import('@companion/module-workspace/api').then((m) => m.default) },
  { manifest: operateManifest, load: () => import('@companion/module-operate/api').then((m) => m.default) },
  { manifest: codeManifest, load: () => import('@companion/module-code/api').then((m) => m.default) },
  { manifest: planManifest, load: () => import('@companion/module-plan/api').then((m) => m.default) },
  { manifest: boardManifest, load: () => import('@companion/module-board/api').then((m) => m.default) },
  { manifest: refinementManifest, load: () => import('@companion/module-refinement/api').then((m) => m.default) },
  { manifest: automationsManifest, load: () => import('@companion/module-automations/api').then((m) => m.default) },
  { manifest: adminManifest, load: () => import('@companion/module-admin/api').then((m) => m.default) },
];
