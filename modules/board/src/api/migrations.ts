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
    name: 'board_human_escalation',
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(board_tasks)`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'human_instructions')) {
        db.exec(`ALTER TABLE board_tasks ADD COLUMN human_instructions TEXT`);
      }
    },
    down: () => {
      // Additive compatibility column: intentionally retained on module downgrade.
    },
  },
]);
