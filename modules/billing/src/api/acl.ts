import { defineAcl } from '@companion/core/server';
import '../contract/index.js';
export default defineAcl({ permissions: [
  { id: 'billing:read', title: 'View workspace billing status' },
  { id: 'billing:manage', title: 'Manage workspace billing' },
], grants: { admin: '*', maintainer: ['billing:read', 'billing:manage'], business: ['billing:read'] } });
