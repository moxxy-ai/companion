import '../contract/index.js';
import { defineClientModule } from '@moxxy/companion-sdk/client';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';

export { integrationsApi } from './api.js';
export { ProviderIcon, useProviderMarks } from './ProviderIcon.js';
export { useIntegrations } from './hooks/useIntegrations.js';
export {
  ReviewProviderSelect,
  decodeIntegrationTarget,
  encodeIntegrationTarget,
  reviewTargetOptions,
  useReviewTargets,
} from './review-targets.js';

export default defineClientModule({ manifest, nav, routes, slots });
