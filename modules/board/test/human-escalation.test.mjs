import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BoardService } from '../dist/api/board-service.js';
import { BoardStore } from '../dist/api/board-store.js';
import migrations from '../dist/api/migrations.js';
import routes from '../dist/api/routes.js';

function migrate(db) {
  for (const migration of migrations) migration.up(db, { moduleId: 'board' });
}

function fixture(overrides = {}) {
  const db = new Database(':memory:');
  migrate(db);
  const store = new BoardStore(db);
  const now = Date.now();
  store.insertTask({
    id: 'tsk-test', repo: 'owner/repo', title: 'Exhausted task', description: 'Do the work', specId: null,
    priority: 2, status: 'failed', stage: null, assignedWorkerId: null, runId: null, branch: null,
    prNumber: null, prUrl: null, reviewRisk: null, reviewRecommendation: null, attempts: 3,
    lastError: 'automation failed', humanInstructions: null, createdAt: now, updatedAt: now,
    startedAt: now, finishedAt: null, ...overrides,
  });
  const code = {
    repos: { get: () => ({ default_branch: 'main', workspace_id: 'ws-1' }) },
    prs: { get: () => undefined },
    fixes: { discard: async () => undefined },
  };
  const service = new BoardService(
    store, code, {}, { canAccessRepo: () => true }, () => undefined, () => undefined, () => undefined,
  );
  return { db, store, service };
}

for (const expected of [
  { decision: 'retry', instructions: 'Use the integration fixture', status: 'ready', event: 'human_retry' },
  { decision: 'backlog', instructions: 'Wait for upstream', status: 'backlog', event: 'human_parked' },
  { decision: 'done', instructions: 'The current result is acceptable', status: 'done', event: 'human_done' },
]) {
  test(`resolveFailure supports ${expected.decision} and emits its audit event`, async (t) => {
    const { db, store, service } = fixture();
    t.after(() => { service.dispose(); db.close(); });
    const task = await service.resolveFailure('tsk-test', expected.decision, expected.instructions);
    assert.equal(task.status, expected.status);
    assert.equal(task.humanInstructions, expected.instructions);
    assert.equal(store.listEvents('tsk-test')[0]?.kind, expected.event);
    if (expected.decision === 'retry') {
      assert.equal(task.stage, 'build');
      assert.equal(task.attempts, 0);
      assert.equal(task.lastError, null);
    }
  });
}

test('retry rejects blank guidance and leaves the failed task untouched', async (t) => {
  const { db, store, service } = fixture();
  t.after(() => { service.dispose(); db.close(); });
  await assert.rejects(service.resolveFailure('tsk-test', 'retry', '   '), /what to do differently/);
  assert.equal(store.getTask('tsk-test')?.status, 'failed');
  assert.equal(store.listEvents('tsk-test').length, 0);
});

test('ordinary moves cannot bypass failed-task resolution', async (t) => {
  const { db, service } = fixture();
  t.after(() => { service.dispose(); db.close(); });
  for (const target of ['ready', 'backlog']) {
    await assert.rejects(service.moveTask('tsk-test', target), /maintainer review/);
  }
});

test('migration adds and persists human_instructions on an existing v1 schema', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrations[0].up(db, { moduleId: 'board' });
  assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('board_tasks') WHERE name = 'human_instructions'").get(), undefined);
  migrations[1].up(db, { moduleId: 'board' });
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('board_tasks') WHERE name = 'human_instructions'").get());
  // The migration is deliberately idempotent for databases repaired/replayed by operators.
  migrations[1].up(db, { moduleId: 'board' });
});

test('manage-protected API route resolves a visible failed task', async (t) => {
  const { db, store, service } = fixture();
  t.after(() => { service.dispose(); db.close(); });
  const route = routes({
    services: {
      get: (id) => {
        if (id === 'board') return service;
        if (id === 'workspace') return { canAccessRepo: () => true };
        throw new Error(`unexpected service ${id}`);
      },
    },
  }).find((candidate) => candidate.path === '/api/board/tasks/:id/resolve-failure');
  assert.ok(route);
  assert.equal(route.method, 'POST');
  assert.equal(route.access, 'board:manage');
  const result = await route.run(
    { id: 'tsk-test' },
    new URLSearchParams(),
    { decision: 'retry', instructions: 'Follow the API-provided guidance' },
    { username: 'maintainer' },
    null,
  );
  assert.equal(result.task.status, 'ready');
  assert.equal(store.listEvents('tsk-test')[0]?.kind, 'human_retry');
});

test('manage-protected API route rejects blank retry guidance', async (t) => {
  const { db, service } = fixture();
  t.after(() => { service.dispose(); db.close(); });
  const route = routes({
    services: {
      get: (id) => id === 'board' ? service : { canAccessRepo: () => true },
    },
  }).find((candidate) => candidate.path === '/api/board/tasks/:id/resolve-failure');
  await assert.rejects(
    route.run(
      { id: 'tsk-test' }, new URLSearchParams(), { decision: 'retry', instructions: '   ' },
      { username: 'maintainer' }, null,
    ),
    (error) => error.status === 400 && /what to do differently/.test(error.message),
  );
});

test('retry preserves fix_ci and passes guidance to the CI-fix worker', async (t) => {
  let received;
  const guidance = 'Reproduce the Linux-only check failure before changing the implementation.';
  const { db, store, service } = fixture({ stage: 'fix_ci', prNumber: 13 });
  t.after(() => { service.dispose(); db.close(); });
  service.code.fixes.startCheckFix = async (...args) => {
    received = args;
    return { id: 'run-checks', branch: 'companion/pr-13' };
  };
  store.insertWorker({ id: 'wkr-dev', name: 'Developer', role: 'developer', enabled: true, createdAt: Date.now() });

  const retried = await service.resolveFailure('tsk-test', 'retry', guidance);
  assert.equal(retried.stage, 'fix_ci');
  await service.tick();
  assert.deepEqual(received, ['owner/repo', 13, guidance]);
  assert.equal(store.getTask('tsk-test')?.runId, 'run-checks');
});

test('decision events retain the complete accepted guidance', async (t) => {
  const { db, store, service } = fixture();
  t.after(() => { service.dispose(); db.close(); });
  const guidance = 'x'.repeat(10_000);
  await service.resolveFailure('tsk-test', 'retry', guidance);
  assert.equal(store.listEvents('tsk-test')[0]?.detail, guidance);
});

test('existing-PR retry passes guidance to the review-fix worker', async (t) => {
  let received;
  const { db, store, service } = fixture({
    status: 'ready', stage: 'address_review', prNumber: 13,
    humanInstructions: 'Use the maintainer reproduction steps even without GitHub comments.',
  });
  t.after(() => { service.dispose(); db.close(); });
  service.code.fixes.startReviewFix = async (...args) => {
    received = args;
    return { id: 'run-review', branch: 'companion/pr-13' };
  };
  store.insertWorker({ id: 'wkr-dev', name: 'Developer', role: 'developer', enabled: true, createdAt: Date.now() });
  await service.tick();
  assert.deepEqual(received, [
    'owner/repo', 13, 'Use the maintainer reproduction steps even without GitHub comments.',
  ]);
  assert.equal(store.getTask('tsk-test')?.runId, 'run-review');
});

test('saved guidance is included in the next fresh-worker objective', (t) => {
  const { db, service } = fixture({ status: 'ready', humanInstructions: 'Start with the race-condition regression test.' });
  t.after(() => { service.dispose(); db.close(); });
  const objective = service.buildObjective(service.store.getTask('tsk-test'), 'main');
  assert.match(objective, /Human review and next-step guidance/);
  assert.match(objective, /Start with the race-condition regression test\./);
  assert.match(objective, /authoritative/);
});
