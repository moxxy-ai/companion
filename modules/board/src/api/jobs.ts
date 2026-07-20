import { defineJobs } from '@companion/core/server';

let unsubscribe: (() => void) | null = null;

/**
 * The board's run-lifecycle seam and heartbeat. run.changed drives the fast
 * path (a worker's run landing in review → push + PR; a dead run → retry);
 * the periodic tick is the safety net that also advances the review/merge
 * cycle, which has no server-bus signal of its own (PR/check state arrives
 * via the GitHub sync cache).
 */
export default defineJobs({
  onEnable: (ctx) => {
    const board = ctx.services.get('board');
    unsubscribe = ctx.bus.on('run.changed', (run) => board.onRunChanged(run));
  },
  onDisable: (ctx) => {
    unsubscribe?.();
    unsubscribe = null;
    ctx.services.tryGet('board')?.dispose();
  },
  postActivate: (ctx) => {
    const board = ctx.services.get('board');
    // Rows created before workspace scoping adopt into the first workspace.
    const first = ctx.services.get('workspace').list()[0];
    if (first) board.adoptUnscoped(first.id);
    // Boot recovery: reconcile tasks against run rows (operate's recover()
    // has already marked orphaned runs interrupted) and restart dispatch.
    board.kick();
  },
  jobs: [
    {
      id: 'board.tick',
      everyMs: 45_000,
      run: (ctx) => ctx.services.get('board').kick(),
    },
  ],
});
