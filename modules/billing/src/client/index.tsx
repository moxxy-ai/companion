import { defineClientModule } from '@companion/core/client';
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';
export { billingApi } from './api.js';
export { useBilling } from './hooks/useBilling.js';
export default defineClientModule({ manifest, nav, routes });
