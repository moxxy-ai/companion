import { defineMigrations } from '@companion/core/server';
export default defineMigrations([{ version: 1, name: 'billing_init', up: (db) => db.exec(`
  CREATE TABLE IF NOT EXISTS billing_customers (workspace_id TEXT PRIMARY KEY, stripe_customer_id TEXT NOT NULL UNIQUE, email TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS billing_subscriptions (workspace_id TEXT PRIMARY KEY, stripe_subscription_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, price_id TEXT, current_period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS billing_stripe_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER);
  CREATE INDEX IF NOT EXISTS idx_billing_stripe_events_received ON billing_stripe_events(received_at);
`), down: (db) => db.exec(`
  DROP INDEX IF EXISTS idx_billing_stripe_events_received;
  DROP TABLE IF EXISTS billing_stripe_events;
  DROP TABLE IF EXISTS billing_subscriptions;
  DROP TABLE IF EXISTS billing_customers;
`) }]);
