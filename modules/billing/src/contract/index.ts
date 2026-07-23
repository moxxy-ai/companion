import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import type { BillingService } from '../api/billing-service.js';

declare module '@companion/contracts' {
  interface PermissionRegistry { 'billing:read': true; 'billing:manage': true; }
  interface ServerMessageRegistry { 'billing.changed': { workspaceId: string }; }
  interface ServiceMap { billing: BillingService; }
}
export interface BillingCustomer { readonly workspaceId: string; readonly stripeCustomerId: string; readonly email: string | null; readonly createdAt: number; readonly updatedAt: number; }
export type BillingSubscriptionState = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
export interface BillingSubscription { readonly workspaceId: string; readonly stripeSubscriptionId: string; readonly status: BillingSubscriptionState; readonly priceId: string | null; readonly currentPeriodEnd: number | null; readonly cancelAtPeriodEnd: boolean; readonly createdAt: number; readonly updatedAt: number; }
export interface BillingStatus { readonly workspaceId: string; readonly subscribed: boolean; readonly customer: BillingCustomer | null; readonly subscription: BillingSubscription | null; }
