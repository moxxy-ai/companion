import { defineMigrations } from '@companion/core/server';

export default defineMigrations([
  {
    version: 1,
    name: 'refinement_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS refinements (
          id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL,
          title TEXT NOT NULL, story TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft', error TEXT,
          method_id TEXT, spec_ids TEXT NOT NULL DEFAULT '[]', doc_ids TEXT NOT NULL DEFAULT '[]',
          summary TEXT, run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_refinements_repo ON refinements(repo, updated_at);
        CREATE TABLE IF NOT EXISTS refine_items (
          id TEXT PRIMARY KEY, refinement_id TEXT NOT NULL, ord INTEGER NOT NULL,
          title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '',
          priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'proposed',
          task_id TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_refine_items_ref ON refine_items(refinement_id, ord);
        CREATE TABLE IF NOT EXISTS refine_methods (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS refine_methods;
        DROP TABLE IF EXISTS refine_items;
        DROP TABLE IF EXISTS refinements;
      `);
    },
  },
]);
