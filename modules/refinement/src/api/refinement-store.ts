import type { Database } from 'better-sqlite3';
import { safeParse } from '@companion/services';
import type {
  RefineItemRecord,
  RefineMethodRecord,
  RefinementListEntry,
  RefinementRecord,
} from '../contract/index.js';
import type { TaskPriority } from '@companion/module-board/contract';

interface RefinementRow {
  id: string;
  repo: string;
  branch: string;
  title: string;
  story: string;
  status: string;
  error: string | null;
  method_id: string | null;
  spec_ids: string;
  doc_ids: string;
  summary: string | null;
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  refinement_id: string;
  ord: number;
  title: string;
  description: string;
  acceptance: string;
  priority: number;
  status: string;
  task_id: string | null;
  created_at: number;
}

interface MethodRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  instructions: string;
  created_at: number;
  updated_at: number;
}

function rowToRefinement(row: RefinementRow): RefinementRecord {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    title: row.title,
    story: row.story,
    status: row.status as RefinementRecord['status'],
    error: row.error,
    methodId: row.method_id,
    specIds: safeParse<string[]>(row.spec_ids, []),
    docIds: safeParse<string[]>(row.doc_ids, []),
    summary: row.summary,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToItem(row: ItemRow): RefineItemRecord {
  return {
    id: row.id,
    refinementId: row.refinement_id,
    ord: row.ord,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    priority: row.priority as TaskPriority,
    status: row.status as RefineItemRecord['status'],
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

function rowToMethod(row: MethodRow): RefineMethodRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    builtin: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Fields the service may patch on a refinement; undefined = leave unchanged. */
export interface RefinementPatch {
  title?: string;
  story?: string;
  branch?: string;
  status?: RefinementRecord['status'];
  error?: string | null;
  methodId?: string | null;
  specIds?: ReadonlyArray<string>;
  docIds?: ReadonlyArray<string>;
  summary?: string | null;
  runId?: string | null;
}

const PATCH_COLUMNS: ReadonlyArray<[keyof RefinementPatch, string]> = [
  ['title', 'title'],
  ['story', 'story'],
  ['branch', 'branch'],
  ['status', 'status'],
  ['error', 'error'],
  ['methodId', 'method_id'],
  ['specIds', 'spec_ids'],
  ['docIds', 'doc_ids'],
  ['summary', 'summary'],
  ['runId', 'run_id'],
];

/** Owner of the refinements / refine_items / refine_methods tables. */
export class RefinementStore {
  constructor(private readonly db: Database) {}

  // ---------- refinements -----------------------------------------------------------

  insert(r: RefinementRecord): void {
    this.db
      .prepare(
        `INSERT INTO refinements (
           id, repo, branch, title, story, status, error, method_id, spec_ids, doc_ids,
           summary, run_id, created_at, updated_at
         ) VALUES (
           @id, @repo, @branch, @title, @story, @status, @error, @methodId, @specIds, @docIds,
           @summary, @runId, @createdAt, @updatedAt
         )`,
      )
      .run({ ...r, specIds: JSON.stringify(r.specIds), docIds: JSON.stringify(r.docIds) });
  }

  update(id: string, patch: RefinementPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: Date.now() };
    for (const [key, column] of PATCH_COLUMNS) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = @${key}`);
        params[key] =
          key === 'specIds' || key === 'docIds' ? JSON.stringify(patch[key]) : patch[key];
      }
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE refinements SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`)
      .run(params);
  }

  get(id: string): RefinementRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM refinements WHERE id = ?`).get(id) as RefinementRow | undefined;
    return row ? rowToRefinement(row) : undefined;
  }

  /** Deletes the refinement AND its items. */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM refine_items WHERE refinement_id = ?`).run(id);
    this.db.prepare(`DELETE FROM refinements WHERE id = ?`).run(id);
  }

  /**
   * One workspace's refinements, newest activity first, with item tallies for
   * the list page. Workspace scoping goes through code's published `v_repos`
   * view — never a raw JOIN on its repos table.
   */
  listByWorkspace(workspaceId: string): RefinementListEntry[] {
    const rows = this.db
      .prepare(
        `SELECT f.*,
           (SELECT COUNT(*) FROM refine_items i WHERE i.refinement_id = f.id AND i.status = 'proposed') AS proposed_count,
           (SELECT COUNT(*) FROM refine_items i WHERE i.refinement_id = f.id AND i.status = 'imported') AS imported_count
         FROM refinements f JOIN v_repos r ON r.full_name = f.repo
         WHERE r.workspace_id = ?
         ORDER BY f.updated_at DESC`,
      )
      .all(workspaceId) as Array<RefinementRow & { proposed_count: number; imported_count: number }>;
    return rows.map((row) => ({
      ...rowToRefinement(row),
      proposedCount: row.proposed_count,
      importedCount: row.imported_count,
    }));
  }

  /** Boot sweep: a 'decomposing' refinement whose driver died dangles — fail it. */
  resetDangling(): number {
    const result = this.db
      .prepare(
        `UPDATE refinements SET status = 'failed', error = 'interrupted by daemon restart', updated_at = ?
         WHERE status = 'decomposing'`,
      )
      .run(Date.now());
    return result.changes;
  }

  // ---------- items -----------------------------------------------------------------

  /** A fresh decomposition replaces the un-acted-on proposals; imported/dismissed rows stay. */
  replaceProposed(refinementId: string, items: readonly RefineItemRecord[]): void {
    const del = this.db.prepare(`DELETE FROM refine_items WHERE refinement_id = ? AND status = 'proposed'`);
    const insert = this.db.prepare(
      `INSERT INTO refine_items (id, refinement_id, ord, title, description, acceptance, priority, status, task_id, created_at)
       VALUES (@id, @refinementId, @ord, @title, @description, @acceptance, @priority, @status, @taskId, @createdAt)`,
    );
    // One transaction: a mid-loop failure must not strand a half-replaced list.
    this.db.transaction(() => {
      del.run(refinementId);
      for (const item of items) insert.run(item);
    })();
  }

  listItems(refinementId: string): RefineItemRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM refine_items WHERE refinement_id = ? ORDER BY ord`)
      .all(refinementId) as ItemRow[];
    return rows.map(rowToItem);
  }

  getItem(id: string): RefineItemRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM refine_items WHERE id = ?`).get(id) as ItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  setItemStatus(id: string, status: RefineItemRecord['status'], taskId: string | null): void {
    this.db.prepare(`UPDATE refine_items SET status = ?, task_id = ? WHERE id = ?`).run(status, taskId, id);
  }

  // ---------- methods (user-defined; built-ins live in builtin-methods.ts) ----------

  insertMethod(m: RefineMethodRecord & { workspaceId: string }): void {
    this.db
      .prepare(
        `INSERT INTO refine_methods (id, workspace_id, name, description, instructions, created_at, updated_at)
         VALUES (@id, @workspaceId, @name, @description, @instructions, @createdAt, @updatedAt)`,
      )
      .run({
        id: m.id,
        workspaceId: m.workspaceId,
        name: m.name,
        description: m.description,
        instructions: m.instructions,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      });
  }

  updateMethod(id: string, fields: { name?: string; description?: string; instructions?: string }): void {
    const existing = this.getMethod(id);
    if (!existing) return;
    this.db
      .prepare(`UPDATE refine_methods SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?`)
      .run(
        fields.name ?? existing.name,
        fields.description ?? existing.description,
        fields.instructions ?? existing.instructions,
        Date.now(),
        id,
      );
  }

  deleteMethod(id: string): boolean {
    return this.db.prepare(`DELETE FROM refine_methods WHERE id = ?`).run(id).changes > 0;
  }

  getMethod(id: string): RefineMethodRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM refine_methods WHERE id = ?`).get(id) as MethodRow | undefined;
    return row ? rowToMethod(row) : undefined;
  }

  listMethods(workspaceId: string): RefineMethodRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM refine_methods WHERE workspace_id = ? ORDER BY created_at`)
      .all(workspaceId) as MethodRow[];
    return rows.map(rowToMethod);
  }
}
