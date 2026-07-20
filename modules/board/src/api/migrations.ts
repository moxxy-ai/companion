import { defineMigrations } from '@companion/core/server';

export default defineMigrations([
  {
    version: 1,
    name: 'board_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS board_workers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'developer',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS board_tasks (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          spec_id TEXT,
          priority INTEGER NOT NULL DEFAULT 2,
          status TEXT NOT NULL DEFAULT 'backlog',
          stage TEXT,
          assigned_worker_id TEXT,
          run_id TEXT,
          branch TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          review_risk TEXT,
          review_recommendation TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_board_tasks_status ON board_tasks(status, priority, created_at);
        CREATE INDEX IF NOT EXISTS idx_board_tasks_run ON board_tasks(run_id);
        CREATE TABLE IF NOT EXISTS board_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_board_events_task ON board_events(task_id, at);
        CREATE TABLE IF NOT EXISTS board_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          auto_review INTEGER NOT NULL DEFAULT 1,
          reviewer_worker_id TEXT,
          auto_merge INTEGER NOT NULL DEFAULT 1,
          merge_method TEXT NOT NULL DEFAULT 'squash',
          auto_fix_ci INTEGER NOT NULL DEFAULT 1,
          max_attempts INTEGER NOT NULL DEFAULT 3
        );
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS board_config;
        DROP TABLE IF EXISTS board_events;
        DROP TABLE IF EXISTS board_tasks;
        DROP TABLE IF EXISTS board_workers;
      `);
    },
  },
  {
    version: 2,
    name: 'board_merge_account',
    up: (db) => {
      db.exec(`ALTER TABLE board_config ADD COLUMN merge_account_id TEXT`);
    },
    down: (db) => {
      db.exec(`ALTER TABLE board_config DROP COLUMN merge_account_id`);
    },
  },
  {
    version: 3,
    name: 'board_task_provenance',
    up: (db) => {
      db.exec(`
        ALTER TABLE board_tasks ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';
        ALTER TABLE board_tasks ADD COLUMN created_by TEXT;
        ALTER TABLE board_tasks ADD COLUMN first_worker TEXT;
      `);
    },
    down: (db) => {
      db.exec(`
        ALTER TABLE board_tasks DROP COLUMN acceptance;
        ALTER TABLE board_tasks DROP COLUMN created_by;
        ALTER TABLE board_tasks DROP COLUMN first_worker;
      `);
    },
  },
  {
    version: 4,
    name: 'board_workspace_scope',
    up: (db) => {
      // Workers gain a workspace; config becomes one row PER workspace. Rows
      // predating the scoping carry '' until boot adoption assigns them to the
      // first workspace (board-service.adoptUnscoped).
      db.exec(`
        ALTER TABLE board_workers ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
        CREATE TABLE board_config_ws (
          workspace_id TEXT PRIMARY KEY,
          auto_review INTEGER NOT NULL DEFAULT 1,
          reviewer_worker_id TEXT,
          auto_merge INTEGER NOT NULL DEFAULT 1,
          merge_method TEXT NOT NULL DEFAULT 'squash',
          merge_account_id TEXT,
          auto_fix_ci INTEGER NOT NULL DEFAULT 1,
          max_attempts INTEGER NOT NULL DEFAULT 3
        );
        INSERT INTO board_config_ws (workspace_id, auto_review, reviewer_worker_id, auto_merge, merge_method, merge_account_id, auto_fix_ci, max_attempts)
          SELECT '', auto_review, reviewer_worker_id, auto_merge, merge_method, merge_account_id, auto_fix_ci, max_attempts FROM board_config;
        DROP TABLE board_config;
        ALTER TABLE board_config_ws RENAME TO board_config;
      `);
    },
    down: (db) => {
      db.exec(`
        ALTER TABLE board_workers DROP COLUMN workspace_id;
        CREATE TABLE board_config_v1 (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          auto_review INTEGER NOT NULL DEFAULT 1,
          reviewer_worker_id TEXT,
          auto_merge INTEGER NOT NULL DEFAULT 1,
          merge_method TEXT NOT NULL DEFAULT 'squash',
          merge_account_id TEXT,
          auto_fix_ci INTEGER NOT NULL DEFAULT 1,
          max_attempts INTEGER NOT NULL DEFAULT 3
        );
        INSERT INTO board_config_v1 (id, auto_review, reviewer_worker_id, auto_merge, merge_method, merge_account_id, auto_fix_ci, max_attempts)
          SELECT 1, auto_review, reviewer_worker_id, auto_merge, merge_method, merge_account_id, auto_fix_ci, max_attempts FROM board_config LIMIT 1;
        DROP TABLE board_config;
        ALTER TABLE board_config_v1 RENAME TO board_config;
      `);
    },
  },
  {
    version: 5,
    name: 'board_task_attachments',
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(board_tasks)`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'attachments')) {
        db.exec(`ALTER TABLE board_tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`);
      }
    },
    // SQLite cannot safely remove a column while preserving installations that
    // may already contain task data. Module teardown drops the table in v1.
    down: () => undefined,
  },
]);
