import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BoardService } from '../dist/api/board-service.js';
import { BoardStore } from '../dist/api/board-store.js';
import migrations from '../dist/api/migrations.js';

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

test('saved guidance is included in the next fresh-worker objective', (t) => {
  const { db, service } = fixture({ status: 'ready', humanInstructions: 'Start with the race-condition regression test.' });
  t.after(() => { service.dispose(); db.close(); });
  const objective = service.buildObjective(service.store.getTask('tsk-test'), 'main');
  assert.match(objective, /Human review and next-step guidance/);
  assert.match(objective, /Start with the race-condition regression test\./);
  assert.match(objective, /authoritative/);
});
