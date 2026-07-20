import { defineServices } from '@companion/core/server';
import { RefinementStore } from './refinement-store.js';
import { RefinementService } from './refinement-service.js';

/**
 * Construct the refinement domain: the store over the refinement tables and
 * the service that runs read-only decomposition agents and imports approved
 * items into the board. All deps are hard (see the manifest) and resolved
 * through the registry in topo order.
 */
export default defineServices((ctx) => {
  const store = new RefinementStore(ctx.db);
  const operate = ctx.services.get('operate');
  ctx.services.register(
    'refinement',
    new RefinementService(
      store,
      ctx.services.get('plan'),
      ctx.services.get('board'),
      ctx.services.get('code'),
      operate.orchestrator,
      operate.checkouts,
      ctx.broadcast,
    ),
  );
});
