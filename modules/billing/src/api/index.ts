import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
export { BillingService } from './billing-service.js';
export { BillingStore } from './billing-store.js';
export default defineApiModule({ manifest, acl, migrations, registerServices, routes });
