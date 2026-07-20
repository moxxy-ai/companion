import { defineJobs } from '@companion/core/server';

/**
 * Boot recovery: a refinement stuck in 'decomposing' lost its one-shot driver
 * with the previous daemon life — flip it to 'failed' so the UI never spins
 * forever on a run that no longer exists.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const dangling = ctx.services.get('refinement').resetDangling();
    if (dangling > 0) {
      ctx.log.info(`marked ${dangling} refinement(s) stuck in 'decomposing' as failed from previous daemon life`);
    }
  },
});
