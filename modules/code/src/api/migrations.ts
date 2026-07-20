import { defineMigrations } from '@companion/core/server';

/**
 * v1 = idempotent adopt of today's live code-domain shape: repos + the
 * issues/PRs sync cache, triage + AI review verdicts, the GitHub account
 * registry (and its workspace delegation side table), and pipelines (+ the
 * step library and run history). Running it against an existing DB is a no-op
 * (`IF NOT EXISTS` + try/catch ALTER); against a fresh DB it produces the
 * current schema.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'code_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          full_name      TEXT PRIMARY KEY,
          owner          TEXT NOT NULL,
          name           TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT 'main',
          private        INTEGER NOT NULL DEFAULT 0,
          clone_ready    INTEGER NOT NULL DEFAULT 0,
          last_sync_at   INTEGER,
          auto_triage    INTEGER NOT NULL DEFAULT 0,
          digest_enabled INTEGER NOT NULL DEFAULT 0,
          stale_enabled  INTEGER NOT NULL DEFAULT 0,
          webhook_secret TEXT
        );

        CREATE TABLE IF NOT EXISTS issues (
          repo       TEXT NOT NULL,
          number     INTEGER NOT NULL,
          title      TEXT NOT NULL,
          body       TEXT NOT NULL DEFAULT '',
          state      TEXT NOT NULL,
          labels     TEXT NOT NULL DEFAULT '[]',
          author     TEXT NOT NULL DEFAULT '',
          assignees  TEXT NOT NULL DEFAULT '[]',
          comments   INTEGER NOT NULL DEFAULT 0,
          url        TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (repo, number)
        );
        CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(repo, state);

        CREATE TABLE IF NOT EXISTS prs (
          repo       TEXT NOT NULL,
          number     INTEGER NOT NULL,
          title      TEXT NOT NULL,
          state      TEXT NOT NULL,
          head_ref   TEXT NOT NULL DEFAULT '',
          author     TEXT NOT NULL DEFAULT '',
          url        TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (repo, number)
        );

        CREATE TABLE IF NOT EXISTS triage_results (
          id           TEXT PRIMARY KEY,
          repo         TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          run_id       TEXT NOT NULL,
          status       TEXT NOT NULL,
          verdict      TEXT,
          error        TEXT,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_triage_issue ON triage_results(repo, issue_number);

        CREATE TABLE IF NOT EXISTS pr_reviews (
          id         TEXT PRIMARY KEY,
          repo       TEXT NOT NULL,
          pr_number  INTEGER NOT NULL,
          run_id     TEXT NOT NULL,
          status     TEXT NOT NULL,
          verdict    TEXT,
          error      TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pr_reviews ON pr_reviews(repo, pr_number);

        CREATE TABLE IF NOT EXISTS github_accounts (
          id         TEXT PRIMARY KEY,
          login      TEXT NOT NULL,
          token      TEXT NOT NULL,
          purposes   TEXT NOT NULL DEFAULT '[]',
          scope      TEXT NOT NULL DEFAULT 'shared',
          owner_id   TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS github_account_workspaces (
          account_id   TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          PRIMARY KEY (account_id, workspace_id)
        );

        CREATE TABLE IF NOT EXISTS pipelines (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name         TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          steps        TEXT NOT NULL DEFAULT '[]',
          auto_run     INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS step_definitions (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name         TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          step         TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id            TEXT PRIMARY KEY,
          pipeline_id   TEXT NOT NULL,
          pipeline_name TEXT NOT NULL,
          repo          TEXT NOT NULL,
          pr_number     INTEGER NOT NULL,
          status        TEXT NOT NULL,
          trigger       TEXT NOT NULL,
          steps         TEXT NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL,
          finished_at   INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pr ON pipeline_runs(repo, pr_number);
      `);
      // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
      for (const ddl of [
        `ALTER TABLE prs ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE prs ADD COLUMN base_ref TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE prs ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE prs ADD COLUMN head_sha TEXT`,
        `ALTER TABLE prs ADD COLUMN checks TEXT`,
        `ALTER TABLE prs ADD COLUMN closed_at INTEGER`,
        `ALTER TABLE issues ADD COLUMN closed_at INTEGER`,
        `ALTER TABLE repos ADD COLUMN pr_gate INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE repos ADD COLUMN workspace_id TEXT`,
        `ALTER TABLE repos ADD COLUMN github_account_id TEXT`,
        `ALTER TABLE prs ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`,
        `ALTER TABLE prs ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]'`,
        `ALTER TABLE prs ADD COLUMN comments INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE prs ADD COLUMN review_decision TEXT`,
        `ALTER TABLE pipelines ADD COLUMN type TEXT NOT NULL DEFAULT 'pr'`,
        `ALTER TABLE pipeline_runs ADD COLUMN target TEXT NOT NULL DEFAULT 'pr'`,
        `ALTER TABLE repos ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE repos ADD COLUMN runner_id TEXT`,
        `ALTER TABLE github_accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'`,
        `ALTER TABLE github_accounts ADD COLUMN owner_id TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      // The owner-published read view: other modules JOIN this to scope by
      // workspace instead of touching the repos table directly.
      db.exec(`CREATE VIEW IF NOT EXISTS v_repos AS SELECT full_name, workspace_id FROM repos`);
    },
    down: (db) => {
      db.exec(
        `DROP VIEW IF EXISTS v_repos;
         DROP TABLE IF EXISTS pipeline_runs; DROP TABLE IF EXISTS step_definitions; DROP TABLE IF EXISTS pipelines;
         DROP TABLE IF EXISTS github_account_workspaces; DROP TABLE IF EXISTS github_accounts;
         DROP TABLE IF EXISTS pr_reviews; DROP TABLE IF EXISTS triage_results;
         DROP TABLE IF EXISTS prs; DROP TABLE IF EXISTS issues; DROP TABLE IF EXISTS repos;`,
      );
    },
  },
  {
    version: 2,
    name: 'code_pr_mergeable',
    up: (db) => {
      db.exec(`ALTER TABLE prs ADD COLUMN mergeable INTEGER`);
    },
    down: (db) => {
      db.exec(`ALTER TABLE prs DROP COLUMN mergeable`);
    },
  },
]);
