import { defineManifest } from '@companion/core';

export default defineManifest({
  id: 'billing',
  title: 'Billing',
  version: '0.1.0',
  dependsOn: ['workspace'],
  required: false,
  permissions: ['billing:read', 'billing:manage'],
  messages: ['billing.changed'],
});
