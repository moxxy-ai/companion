import { defineServices } from '@companion/core/server';
import { BillingService } from './billing-service.js';
import { BillingStore } from './billing-store.js';
export default defineServices((ctx) => { ctx.services.register('billing', new BillingService(new BillingStore(ctx.db))); });
