/**
 * `@moxxy/companion-sdk` — everything a Companion module is authored against.
 *
 * This package is a **curated façade**, not a re-export of the workspace. The
 * distinction is the point: `@moxxy/companion-core/server` also exports the kernel,
 * the dynamic router, the migration runner and the service registry, which are
 * the host's own machinery. A module that reached for them would be coupled to
 * an implementation that has to stay free to change. So the surface here is an
 * explicit list, and `scripts/sdk-surface.mjs` fails the build when it drifts
 * from the committed snapshot: widening a permanent ABI should be a decision
 * someone made, not a line that slipped into a barrel.
 *
 * Entry points:
 *   `.`         this file — the metafile a module's `module.ts` is written with
 *   `/server`   the `/api` slice: routes, services, migrations, acl, jobs
 *   `/client`   the `/client` slice: nav, routes, slots, onboarding, hooks
 *   `/ui`       the component library the client slice renders with
 *   `/agents`   the agent-run types, for modules that compose runs
 *
 * ## The one import that is NOT from here
 *
 * A module's `contract/` slice augments the open registries:
 *
 * ```ts
 * declare module '@moxxy/companion-contracts' {
 *   interface PermissionRegistry { 'widgets:manage': true }
 * }
 * ```
 *
 * That specifier cannot be replaced by an SDK one. TypeScript binds declaration
 * merging to the module that DECLARES the interface; augmenting a package that
 * merely re-exports it silently creates a second, unrelated interface (measured:
 * TS2820, the augmented key is rejected as not assignable). Hiding the real
 * target behind a façade would produce an ABI whose permissions quietly fail to
 * register, which is worse than one extra package name. So `@moxxy/companion-contracts`
 * is part of the public ABI and a module depends on both.
 */

/**
 * This package's own version, and the ABI generation an out-of-tree module
 * declares as `moxxy.abi` in its package.json. The daemon refuses a module built
 * against a different generation at boot, which is where a mismatch is cheap.
 */
export const SDK_VERSION = '0.10.0'; // keep in step with package.json (checked by pnpm sdk:surface)
export const ABI_GENERATION = '0.x';

export { defineManifest } from '@moxxy/companion-core';
export type { ModuleManifest, ModuleId } from '@moxxy/companion-core';
export type {
  ModuleConfigField,
  ModuleConfigFieldKind,
  ModuleConfigValue,
  ModuleConfigAccessor,
  ModuleConfigState,
} from '@moxxy/companion-core';

/**
 * The open registries are NOT re-exported here, deliberately.
 *
 * They are what a module augments, and an augmentation binds to the package that
 * declares the interface. Re-exporting them would put a second copy of
 * `PermissionRegistry` in this package's published declarations, so a module
 * that augmented `@moxxy/companion-contracts` and read `Permission` from here
 * would be augmenting one interface and reading another. Measured: TS2820, the
 * augmented key rejected as not assignable.
 *
 * So one package owns them end to end. Import AND augment them from
 * `@moxxy/companion-contracts`:
 *
 * ```ts
 * import type { Permission, ServiceMap } from '@moxxy/companion-contracts';
 * declare module '@moxxy/companion-contracts' {
 *   interface PermissionRegistry { 'widgets:manage': true }
 * }
 * ```
 */

export { BUILTIN_ROLES, isBuiltinRole } from '@moxxy/companion-types';
export type { Role, BuiltinRole } from '@moxxy/companion-types';
