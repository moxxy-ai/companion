/**
 * `@moxxy/companion-core/server` — the runtime host (kernel + lifecycle state machine,
 * dynamic router, migration runner, service registry, event bus, RBAC grid) and
 * the server-side registrant API a module's `/api` slice is authored against.
 */
export * from './router.js';
export * from './client-address.js';
export * from './rate-limit.js';
export * from './metrics.js';
export * from './raw-router.js';
export * from './service-registry.js';
export * from './bus.js';
export * from './migration-runner.js';
export * from './module-config-store.js';
export * from './secret-store.js';
export * from './abi-bridge.js';
export * from './external-modules.js';
export * from './module-verify.js';
export * from './module-artifacts.js';
export * from './rbac-grid.js';
export * from './capabilities.js';
export * from './context.js';
export * from './ws-hub.js';
export * from './kernel.js';
