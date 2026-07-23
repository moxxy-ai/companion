import type { Database } from 'better-sqlite3';
import type { BillingCustomer, BillingSubscription, BillingSubscriptionState } from '../contract/index.js';
interface CustomerRow { workspace_id: string; stripe_customer_id: string; email: string | null; created_at: number; updated_at: number; }
interface SubscriptionRow { workspace_id: string; stripe_subscription_id: string; status: string; price_id: string | null; current_period_end: number | null; cancel_at_period_end: number; created_at: number; updated_at: number; }
export class BillingStore {
  constructor(private readonly db: Database) {}
  customer(workspaceId: string): BillingCustomer | null {
    const r = this.db.prepare(`SELECT * FROM billing_customers WHERE workspace_id = ?`).get(workspaceId) as CustomerRow | undefined;
    return r ? { workspaceId: r.workspace_id, stripeCustomerId: r.stripe_customer_id, email: r.email, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }
  subscription(workspaceId: string): BillingSubscription | null {
    const r = this.db.prepare(`SELECT * FROM billing_subscriptions WHERE workspace_id = ?`).get(workspaceId) as SubscriptionRow | undefined;
    return r ? { workspaceId: r.workspace_id, stripeSubscriptionId: r.stripe_subscription_id, status: r.status as BillingSubscriptionState, priceId: r.price_id, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: r.cancel_at_period_end === 1, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }
}
