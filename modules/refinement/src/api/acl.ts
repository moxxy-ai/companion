import { defineAcl } from '@companion/core/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'refine:read', title: 'View product refinements' },
    { id: 'refine:manage', title: 'Create refinements, run decompositions and import tasks' },
  ],
  grants: {
    admin: '*',
    maintainer: ['refine:read', 'refine:manage'],
    business: ['refine:read'],
  },
});
