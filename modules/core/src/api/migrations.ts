import { defineMigrations } from '@moxxy/companion-core/server';

/**
 * v1 = idempotent adopt of today's live shape (users/sessions/settings). Running
 * it against an existing DB is a no-op (`IF NOT EXISTS` + try/catch ALTER);
 * against a fresh DB it produces the current schema. `down` drops the tables
 * (uninstall) — but module-core is required and cannot be disabled/uninstalled.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'core_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          username      TEXT PRIMARY KEY,
          email         TEXT NOT NULL DEFAULT '',
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL,
          disabled      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          username   TEXT NOT NULL,
          role       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      for (const ddl of [`ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS settings;`);
    },
  },
  {
    version: 2,
    name: 'custom_roles',
    // Roles become instance data. The three built-ins are seeded so an existing
    // install is unchanged: with no override rows the fold reproduces exactly
    // the module-granted grid it had before.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS roles (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          builtin     INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL
        );
        -- Append-only. Only RBAC changes land here for now, so it stays tiny;
        -- the audit module (game plan P6.2) owns retention and export when it
        -- takes over this table.
        CREATE TABLE IF NOT EXISTS audit_log (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     INTEGER NOT NULL,
          actor  TEXT NOT NULL,
          action TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
        CREATE TABLE IF NOT EXISTS role_permissions (
          role_id    TEXT NOT NULL,
          permission TEXT NOT NULL,
          mode       TEXT NOT NULL CHECK (mode IN ('grant', 'revoke')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (role_id, permission)
        );
      `);
      const now = Date.now();
      const seed = db.prepare(
        `INSERT INTO roles (id, title, description, builtin, created_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      seed.run('admin', 'Administrator', 'Full control of the instance.', now);
      seed.run('maintainer', 'Maintainer', 'Runs the day-to-day engineering work.', now);
      seed.run('business', 'Business', 'Read-mostly access for non-engineering stakeholders.', now);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS audit_log; DROP TABLE IF EXISTS role_permissions; DROP TABLE IF EXISTS roles;`);
    },
  },
  {
    version: 3,
    name: 'audit_route_columns',
    // v2's audit_log only described RBAC edits. The router now records every
    // mutating request, which needs the route, the permission it demanded and
    // the status the caller got, so an auditor can answer "who changed what,
    // and was it allowed" without joining anything.
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE audit_log ADD COLUMN access TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE audit_log ADD COLUMN status INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE audit_log ADD COLUMN module TEXT`,
        `ALTER TABLE audit_log ADD COLUMN detail TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at)`);
    },
    down: (db) => {
      // SQLite cannot drop a column on older builds and the data is the point;
      // dropping the index is the only reversible half.
      db.exec(`DROP INDEX IF EXISTS idx_audit_actor`);
    },
  },
  {
    version: 4,
    name: 'audit_nullable_actor',
    /**
     * `actor` was NOT NULL while the contract has always said `string | null`,
     * "null only for a public route (setup, a rejected login)". So exactly the
     * events an auditor cares most about, a refused sign-in above all, hit a
     * constraint and were dropped. The sink swallows its own failures by design,
     * which is right for the request and wrong for the trail: the instance kept
     * serving and quietly recorded nothing.
     *
     * SQLite cannot relax NOT NULL in place, so the table is rebuilt. That is
     * not additive, which is the house rule, and the rule loses here: the
     * alternative is a sentinel actor, and an audit table that cannot tell "no
     * actor" from a user literally called that is worse than a rebuild.
     */
    up: (db) => {
      const nullable = (db.prepare(`PRAGMA table_info(audit_log)`).all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === 'actor')?.notnull === 0;
      if (nullable) return;
      db.exec(`
        CREATE TABLE audit_log_v4 (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     INTEGER NOT NULL,
          actor  TEXT,
          action TEXT NOT NULL,
          access TEXT NOT NULL DEFAULT '',
          status INTEGER NOT NULL DEFAULT 0,
          module TEXT,
          detail TEXT
        );
        INSERT INTO audit_log_v4 (id, at, actor, action, access, status, module, detail)
          SELECT id, at, actor, action, access, status, module, detail FROM audit_log;
        DROP TABLE audit_log;
        ALTER TABLE audit_log_v4 RENAME TO audit_log;
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at);
      `);
    },
    down: () => {
      // Deliberately a no-op: going back would have to drop every row whose
      // actor is null, which is data loss to satisfy a constraint that was the
      // bug in the first place.
    },
  },
  {
    version: 5,
    name: 'delegated_session_access',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN access TEXT NOT NULL DEFAULT 'full'`);
      } catch {
        // column already exists
      }
    },
    down: () => {
      // Additive by design; older daemons ignore the extra column.
    },
  },
  {
    version: 6,
    name: 'managed_api_tokens',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_tokens (
          id           TEXT PRIMARY KEY,
          token_hash   TEXT NOT NULL UNIQUE,
          username     TEXT NOT NULL,
          name         TEXT NOT NULL,
          permissions  TEXT NOT NULL DEFAULT '[]',
          created_at   INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL,
          last_used_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (username, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_api_tokens_expiry ON api_tokens (expires_at);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS api_tokens`);
    },
  },
  {
    version: 7,
    name: 'users_email_unique',
    /**
     * One account per email. A dirty database may already hold duplicates, and
     * the migration must not fail it: duplicates are resolved deterministically
     * by keeping the email on the OLDEST row (created_at, then rowid) and
     * blanking it on the later ones. Blank, not NULL, because the column is
     * NOT NULL and '' is the existing "no email" sentinel, which is also why
     * the unique index is partial.
     */
    up: (db) => {
      db.exec(`
        UPDATE users SET email = ''
        WHERE email != ''
          AND EXISTS (
            SELECT 1 FROM users other
            WHERE other.email = users.email
              AND (other.created_at < users.created_at
                   OR (other.created_at = users.created_at AND other.rowid < users.rowid))
          );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email != '';
      `);
    },
    down: (db) => {
      // The blanked duplicates are gone for good; dropping the index is the
      // only reversible half.
      db.exec(`DROP INDEX IF EXISTS idx_users_email`);
    },
  },
  {
    version: 8,
    name: 'sessions_indexes',
    // deleteForUser and pruneExpired both scan; give each its index.
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (username);
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_sessions_user; DROP INDEX IF EXISTS idx_sessions_expiry;`);
    },
  },
  {
    version: 9,
    name: 'totp_mfa',
    // The enabled flag lives on the user row; the TOTP secret itself lives in
    // the module secret store (encrypted at rest), never in this table.
    up: (db) => {
      try {
        db.exec(`ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0`);
      } catch {
        // column already exists
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
          username   TEXT NOT NULL,
          code_hash  TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (username, code_hash)
        );
      `);
    },
    down: (db) => {
      // The users column stays (SQLite cannot drop it on older builds and the
      // flag is inert without the module code); the codes table is droppable.
      db.exec(`DROP TABLE IF EXISTS mfa_recovery_codes`);
    },
  },
  {
    version: 10,
    name: 'session_inventory',
    // Sessions become listable and individually revocable, so each row needs a
    // public id (the token hash must never leave the server) and an activity
    // timestamp for the idle timeout. Both additive; existing rows get an id.
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE sessions ADD COLUMN id TEXT`,
        `ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      db.exec(`
        UPDATE sessions SET id = 'ses-' || lower(hex(randomblob(6))) WHERE id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id ON sessions (id);
      `);
    },
    down: (db) => {
      // Additive columns stay; the index is the reversible half.
      db.exec(`DROP INDEX IF EXISTS idx_sessions_id`);
    },
  },
  {
    version: 11,
    name: 'audit_request_origin',
    // Who did what FROM WHERE: the router records the trust-proxy-derived
    // client address and the User-Agent with every mutation. Both nullable;
    // rows written outside a request (jobs) leave them empty.
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE audit_log ADD COLUMN ip TEXT`,
        `ALTER TABLE audit_log ADD COLUMN agent TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
    },
    down: () => {
      // Additive columns stay: the audit trail is append-only and dropping
      // origin data from historical rows would itself be an audit event.
    },
  },
  {
    version: 12,
    name: 'audit_hash_chain',
    // Append-only was a convention the application could break without leaving
    // a mark. Each row now carries a digest over its own fields AND the digest
    // before it, so editing or removing an entry inside the retained window
    // breaks every link after it. Nullable: rows written before this migration
    // have no digest and the chain simply begins at the first one that does.
    up: (db) => {
      try {
        db.exec(`ALTER TABLE audit_log ADD COLUMN hash TEXT`);
      } catch {
        // column already exists
      }
    },
    down: () => {
      // Additive; dropping the evidence is not a rollback anyone wants.
    },
  },
]);
