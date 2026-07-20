import { defineClientModule } from '@companion/core/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-refinement's web surface: one Refinement entry
 * in the Plan sidebar group (plan owns the section; it is a hard dependency)
 * plus the list/detail routes.
 */

export { refinementApi } from './api.js';
export { useRefinements } from './hooks/useRefinements.js';
export { useRefinement } from './hooks/useRefinement.js';

export default defineClientModule({ manifest, nav, routes });
