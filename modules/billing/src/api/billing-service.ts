import type { BillingStatus } from '../contract/index.js';
import type { BillingStore } from './billing-store.js';
export class BillingService {
  constructor(private readonly store: BillingStore) {}
  status(workspaceId: string): BillingStatus {
    const customer = this.store.customer(workspaceId);
    const subscription = this.store.subscription(workspaceId);
    return { workspaceId, subscribed: subscription?.status === 'active' || subscription?.status === 'trialing', customer, subscription };
  }
}
