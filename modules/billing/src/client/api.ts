import { request } from '@companion/core/client';
import type { BillingStatus } from '../contract/index.js';
export const billingApi = { status: (workspaceId: string) => request<BillingStatus>(`/api/workspaces/${workspaceId}/billing`) };
