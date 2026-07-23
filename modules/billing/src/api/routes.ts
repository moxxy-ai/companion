import { defineRoutes, route } from '@companion/core/server';
import '../contract/index.js';
export default defineRoutes((ctx) => {
  const billing = ctx.services.get('billing');
  const workspace = ctx.services.get('workspace');
  return [route({ method: 'GET', path: '/api/workspaces/:id/billing', access: 'billing:read', handler: ({ params, user }) => {
    workspace.requireAccessible(user, params.id);
    return billing.status(params.id);
  } })];
});
