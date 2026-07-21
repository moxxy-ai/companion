import type Database from 'better-sqlite3';
import { RunsStore } from './runs-store.js';
import { RunQueueStore } from './run-queue-store.js';
import { RunnersStore } from './runners-store.js';

interface RepoLiteRow {
  full_name: string;
  workspace_id: string | null;
  runner_id: string | null;
}

/**
 * The execution plane's view of persistence — a same-shape stand-in for the
 * legacy Store facade so the orchestrator/registry bodies move verbatim. Repos
 * reads are raw SQL against the code-owned table, guarded: when module-code is
 * absent the table may not exist and every read degrades to "no repo info".
 */
export class OperateStore {
  readonly runs: RunsStore;
  readonly runQueue: RunQueueStore;
  readonly runners: RunnersStore;

  constructor(
    private readonly db: Database.Database,
    readonly settings: { get(key: string): string | null; set(key: string, value: string): void },
  ) {
    this.runs = new RunsStore(db);
    this.runQueue = new RunQueueStore(db);
    this.runners = new RunnersStore(db);
  }

  readonly repos = {
    get: (fullName: string): RepoLiteRow | undefined => {
      try {
        return this.db
          .prepare(`SELECT full_name, workspace_id, runner_id FROM repos WHERE full_name = ?`)
          .get(fullName) as RepoLiteRow | undefined;
      } catch {
        return undefined;
      }
    },
    list: (): RepoLiteRow[] => {
      try {
        return this.db.prepare(`SELECT full_name, workspace_id, runner_id FROM repos`).all() as RepoLiteRow[];
      } catch {
        return [];
      }
    },
    setRunner: (fullName: string, runnerId: string | null): void => {
      try {
        this.db.prepare(`UPDATE repos SET runner_id = ? WHERE full_name = ?`).run(runnerId, fullName);
      } catch {
        // repos absent
      }
    },
  };
}
