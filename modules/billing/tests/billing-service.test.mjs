import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { BillingService, BillingStore } from '../dist/api/index.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE billing_customers (workspace_id TEXT PRIMARY KEY, stripe_customer_id TEXT NOT NULL UNIQUE, email TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE billing_subscriptions (workspace_id TEXT PRIMARY KEY, stripe_subscription_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, price_id TEXT, current_period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  return { db, service: new BillingService(new BillingStore(db)) };
}

test('a workspace without rows is unsubscribed', () => {
  const { db, service } = fixture();
  assert.deepEqual(service.status('ws-empty'), { workspaceId: 'ws-empty', subscribed: false, customer: null, subscription: null });
  db.close();
});

test('persisted customer and subscription rows map to the contract', () => {
  const { db, service } = fixture();
  db.prepare(`INSERT INTO billing_customers VALUES (?, ?, ?, ?, ?)`).run('ws-1', 'cus_123', 'owner@example.test', 10, 20);
  db.prepare(`INSERT INTO billing_subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ws-1', 'sub_123', 'active', 'price_pro', 500, 1, 30, 40);
  assert.deepEqual(service.status('ws-1'), { workspaceId: 'ws-1', subscribed: true, customer: { workspaceId: 'ws-1', stripeCustomerId: 'cus_123', email: 'owner@example.test', createdAt: 10, updatedAt: 20 }, subscription: { workspaceId: 'ws-1', stripeSubscriptionId: 'sub_123', status: 'active', priceId: 'price_pro', currentPeriodEnd: 500, cancelAtPeriodEnd: true, createdAt: 30, updatedAt: 40 } });
  db.close();
});

test('billing rows are isolated between workspaces', () => {
  const { db, service } = fixture();
  db.prepare(`INSERT INTO billing_subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ws-a', 'sub_a', 'trialing', null, null, 0, 1, 1);
  assert.equal(service.status('ws-a').subscribed, true);
  assert.deepEqual(service.status('ws-b'), { workspaceId: 'ws-b', subscribed: false, customer: null, subscription: null });
  db.close();
});
