---
name: companion-store-and-migrations
description: >-
  The SQLite persistence conventions in apps/companiond — the per-domain store
  class shape, idempotent additive migrations, snake_case Row + rowToX camelCase
  mappers, JSON-as-TEXT columns, upserts, indexes, bounded retention, and how
  stores wire into the Store facade. Use whenever you add a table, a column, a
  query, or a new store class.
---

# Store & migrations (better-sqlite3)

Persistence is synchronous `better-sqlite3`, WAL mode, one small class per
domain, all composed by the `Store` facade in `store/db.ts`. There is no ORM and
no query builder — hand-written prepared SQL, mapped to and from the contract's
camelCase DTOs.

## The store-class shape

```ts
import type Database from 'better-sqlite3';
import type { WidgetRecord } from '@companion/contract';

/** One-line statement of what this store owns. */
export class WidgetsStore {
  constructor(private readonly db: Database.Database) {}

  insert(w: WidgetRecord): void {
    this.db
      .prepare(
        `INSERT INTO widgets (id, workspace_id, name, tags, created_at)
         VALUES (@id, @workspaceId, @name, @tags, @createdAt)`,
      )
      .run({ ...w, tags: JSON.stringify(w.tags) });
  }

  get(id: string): WidgetRecord | null {
    const row = this.db.prepare(`SELECT * FROM widgets WHERE id = ?`).get(id) as WidgetRow | undefined;
    return row ? rowToWidget(row) : null;
  }

  list(workspaceId: string): WidgetRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM widgets WHERE workspace_id = ? ORDER BY created_at DESC`)
      .all(workspaceId) as WidgetRow[];
    return rows.map(rowToWidget);
  }
}

interface WidgetRow {
  id: string;
  workspace_id: string;
  name: string;
  tags: string; // JSON array
  created_at: number;
}

function rowToWidget(row: WidgetRow): WidgetRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
  };
}
```

Conventions shown above, all load-bearing:

- **Named params** (`@field`) bound from an object; positional `?` for simple
  reads. `better-sqlite3` is sync — no `await`.
- **`SELECT *` + a `Row` interface + a `rowToX` mapper.** SQL columns are
  `snake_case`; DTOs are `camelCase`. The mapper is the single translation point
  and where JSON columns are parsed. Cast the raw row `as XRow | undefined`.
- **JSON columns are TEXT.** Arrays/objects are `JSON.stringify`'d on write,
  `JSON.parse`'d in the mapper (`tags TEXT NOT NULL DEFAULT '[]'`).
- **Upserts** use `INSERT … ON CONFLICT(pk) DO UPDATE SET col = excluded.col`
  (see `SettingsStore.set`).
- **Timestamps** are epoch-ms integers (`Date.now()`), column `*_at INTEGER`.
- **Booleans** are `INTEGER NOT NULL DEFAULT 0`; map `!!row.flag` ⇄ `flag ? 1 : 0`.
- Keep the class thin — persistence only. Business logic lives in the service
  that calls it.

## Migrations — additive and idempotent, always

`store/migrations.ts` has a single `migrate(db)` that runs on every boot. There
is no down-migration and no version table; correctness comes from two rules:

1. **`CREATE TABLE IF NOT EXISTS`** for every table, with `CREATE INDEX IF NOT
   EXISTS` for its hot query paths (e.g. `idx_issues_state ON issues(repo, state)`).
2. **New column on an existing table = an additive `ALTER TABLE … ADD COLUMN`
   guarded so it's a no-op when already present** (wrap in try/catch or check
   `PRAGMA table_info`). Give it a `DEFAULT` so pre-existing rows are valid.

Never write a destructive or rewriting migration (no `DROP`, no `ALTER … DROP
COLUMN`, no data backfill that assumes a one-time run). A migration must be safe
to run against a fresh DB and against an install that's three versions behind,
every time the daemon starts.

## Wiring into the facade

In `store/db.ts`:

1. Add the DDL to `migrate()`.
2. `import { WidgetsStore } from './widgets.js'`.
3. Declare `public readonly widgets: WidgetsStore;`.
4. Construct it in the ctor: `this.widgets = new WidgetsStore(this.db);`.
   **Order matters** when a store depends on another (e.g. `issues` is built
   after `triage` + `githubAccounts` because it takes them). Construct
   dependencies first.

## What is a cache vs. a record of truth

- `runs`, `proposals`, `specs`, `docs`, `pipelines`, `notifications`, `users`,
  `sessions`, `settings`, `runners` — **records of truth**. The DB is authoritative.
- `issues`, `prs` — **a sync cache of GitHub**. Only `github/sync.ts` and applied
  actions write them. On boot, lifecycle rows stuck mid-flight are reconciled
  (`resetDangling()`, `orchestrator.recover()`), never the cache.

## Retention & size

Unbounded tables get a bound. `NotificationsStore.insert` deletes rows older
than 30 days on each insert. If a table grows per-event, add a similar sweep
rather than letting it grow forever.
