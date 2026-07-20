import { defineClientRoutes, lazyView, type RouteProps } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { regex: /^\/refinement\/([\w-]+)$/, params: (m) => ({ id: m[1]! }) },
    permission: 'refine:read',
    // key={id} remounts the detail on refinement switch so no state bleeds.
    component: lazyView(async () => {
      const { default: RefinementView } = await import('./pages/RefinementView.js');
      return {
        default: ({ params }: RouteProps): JSX.Element => <RefinementView key={params.id} id={params.id!} />,
      };
    }),
  },
  {
    match: { exact: '/refinement' },
    permission: 'refine:read',
    component: lazyView(() => import('./pages/Refinements.js')),
  },
]);
