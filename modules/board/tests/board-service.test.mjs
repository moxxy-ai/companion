import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { BoardService } from '../dist/api/board-service.js';
import { BoardStore } from '../dist/api/board-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE board_workers (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE board_tasks (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '', spec_id TEXT,
      attachments TEXT NOT NULL DEFAULT '[]', priority INTEGER NOT NULL, status TEXT NOT NULL, stage TEXT, created_by TEXT,
      first_worker TEXT, assigned_worker_id TEXT, run_id TEXT, branch TEXT,
      pr_number INTEGER, pr_url TEXT, review_risk TEXT, review_recommendation TEXT,
      attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE board_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE board_config (
      workspace_id TEXT PRIMARY KEY, auto_review INTEGER NOT NULL DEFAULT 1,
      reviewer_worker_id TEXT, auto_merge INTEGER NOT NULL DEFAULT 1,
      merge_method TEXT NOT NULL DEFAULT 'squash', merge_account_id TEXT,
      auto_fix_ci INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 3
    );
  `);
  const store = new BoardStore(db);
  const notifications = [];
  const repo = { workspace_id: 'ws-1', default_branch: 'main' };
  const code = {
    repos: { get: (name) => (name === 'owner/repo' ? repo : undefined) },
    prs: { get: () => ({ state: 'open', reviewDecision: null, checks: null }) },
    prReviews: { listForPr: () => [] },
    fixes: { discard: async () => undefined },
  };
  const makeService = () => new BoardService(
    store,
    code,
    { runsStore: { get: () => undefined } },
    { canAccessRepo: () => true },
    () => undefined,
    () => undefined,
    { emit: (notification) => notifications.push(notification) },
  );
  return { db, store, notifications, makeService };
}

function insertTask(store, overrides = {}) {
  const now = Date.now();
  store.insertTask({
    id: overrides.id ?? 'tsk-1',
    repo: 'owner/repo',
    title: 'Lifecycle test',
    description: '',
    acceptance: '',
    specId: null,
    attachments: [],
    priority: 2,
    status: 'ready',
    stage: 'build',
    createdBy: null,
    firstWorker: null,
    assignedWorkerId: null,
    runId: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    reviewRisk: null,
    reviewRecommendation: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  });
}

test('developer blocker is deduplicated across ticks and service restarts', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store);

  const first = makeService();
  await first.tick();
  await first.tick();
  first.dispose();
  assert.equal(notifications.length, 1);
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), true);

  const restarted = makeService();
  await restarted.tick();
  restarted.dispose();
  assert.equal(notifications.length, 1);
  db.close();
});

test('parking clears a blocker so requeue can notify for a new lifecycle', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store);

  const service = makeService();
  await service.tick();
  service.dispose();
  await service.moveTask('tsk-1', 'backlog');
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), false);
  await service.moveTask('tsk-1', 'ready');

  const restarted = makeService();
  await restarted.tick();
  restarted.dispose();
  assert.equal(notifications.length, 2);
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), true);
  db.close();
});

test('manual completion clears the reviewer blocker', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store, { status: 'in_review', stage: 'awaiting_review', prNumber: 14, prUrl: 'https://example.test/pr/14' });

  const service = makeService();
  await service.tick();
  service.dispose();
  assert.equal(notifications.length, 1);
  assert.equal(store.hasActiveBlocker('tsk-1', 'reviewer'), true);

  await service.moveTask('tsk-1', 'done');
  assert.equal(store.hasActiveBlocker('tsk-1', 'reviewer'), false);
  db.close();
});

test('deleting a blocked task removes its durable blocker state', async () => {
  const { db, store, makeService } = fixture();
  insertTask(store);

  const service = makeService();
  await service.tick();
  service.dispose();
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), true);

  await service.deleteTask('tsk-1');
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), false);
  assert.deepEqual(store.listEvents('tsk-1'), []);
  db.close();
});
