import { defineClientRoutes, lazyView } from '@companion/core/client';
export const routes = defineClientRoutes([{ match: { exact: '/billing' }, permission: 'billing:read', component: lazyView(() => import('./pages/Billing.js')) }]);
