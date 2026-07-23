import { NavIcon, defineNav } from '@companion/core/client';
export const nav = defineNav([{ key: 'billing', label: 'Billing', hash: '#/billing', permission: 'billing:read', section: 'workspace', order: 90, icon: <NavIcon><path d="M4 7h16v10H4zM4 10h16M7 14h4" /></NavIcon> }]);
