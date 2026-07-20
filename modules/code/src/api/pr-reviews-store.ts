import type Database from 'better-sqlite3';
import { safeParse } from '@companion/services';
import type { PrReviewResult, PrReviewVerdict } from '../contract/index.js';

/** AI PR review verdicts; the latest row per PR wins. */
export class PrReviewsStore {
  constructor(private readonly db: Database.Database) {}

  insert(r: PrReviewResult): void {
    this.db
      .prepare(
        `INSERT INTO pr_reviews (id, repo, pr_number, run_id, status, verdict, error, created_at)
         VALUES (@id, @repo, @prNumber, @runId, @status, @verdict, @error, @createdAt)`,
      )
      .run({ ...r, verdict: r.verdict ? JSON.stringify(r.verdict) : null });
  }

  update(id: string, status: PrReviewResult['status']): void {
    this.db.prepare(`UPDATE pr_reviews SET status = ? WHERE id = ?`).run(status, id);
  }

  get(id: string): PrReviewResult | undefined {
    const row = this.db.prepare(`SELECT * FROM pr_reviews WHERE id = ?`).get(id) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  /** Every review of a PR, newest first — the task/PR detail review history. */
  listForPr(repo: string, prNumber: number, limit = 20): PrReviewResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC LIMIT ?`)
      .all(repo, prNumber, limit) as PrReviewRow[];
    return rows.map(prReviewRowToResult);
  }

  latest(repo: string, prNumber: number): PrReviewResult | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC LIMIT 1`)
      .get(repo, prNumber) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  latestByNumber(repo: string): Map<number, LatestReviewSignal> {
    const rows = this.db
      .prepare(
        `SELECT pr_number, status, verdict FROM pr_reviews t1 WHERE repo = ?
         AND created_at = (SELECT MAX(created_at) FROM pr_reviews t2 WHERE t2.repo = t1.repo AND t2.pr_number = t1.pr_number)`,
      )
      .all(repo) as Array<{ pr_number: number; status: PrReviewResult['status']; verdict: string | null }>;
    return new Map(rows.map((r) => [r.pr_number, toSignal(r.status, r.verdict)]));
  }
}

/** The slice of the latest AI review that PR list rows carry. */
export interface LatestReviewSignal {
  readonly status: PrReviewResult['status'];
  readonly risk: NonNullable<PrReviewResult['verdict']>['risk'] | null;
}

export function reviewSignal(review: PrReviewResult | undefined): LatestReviewSignal | null {
  if (!review) return null;
  return { status: review.status, risk: review.verdict?.risk ?? null };
}

function toSignal(status: PrReviewResult['status'], verdict: string | null): LatestReviewSignal {
  const parsed = verdict ? safeParse<PrReviewVerdict | null>(verdict, null) : null;
  return { status, risk: parsed?.risk ?? null };
}

interface PrReviewRow {
  id: string;
  repo: string;
  pr_number: number;
  run_id: string;
  status: PrReviewResult['status'];
  verdict: string | null;
  error: string | null;
  created_at: number;
}

function prReviewRowToResult(row: PrReviewRow): PrReviewResult {
  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.pr_number,
    runId: row.run_id,
    status: row.status,
    verdict: row.verdict ? safeParse<PrReviewVerdict | null>(row.verdict, null) : null,
    error: row.error,
    createdAt: row.created_at,
  };
}
