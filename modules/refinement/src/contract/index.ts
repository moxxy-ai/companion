// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages) are visible in this compilation.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-code/contract';
import '@companion/module-operate/contract';
import '@companion/module-plan/contract';
import '@companion/module-board/contract';
import type { TaskPriority } from '@companion/module-board/contract';
import type { RefinementService } from '../api/refinement-service.js';

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'refine:read': true;
    'refine:manage': true;
  }
  interface ServerMessageRegistry {
    'refinement.changed': Record<never, never>;
  }
  interface ServiceMap {
    refinement: RefinementService;
  }
}

/**
 * A refinement: an epic/big story a read-only agent (in a worktree at the
 * chosen branch) enriches and decomposes into board-ready task proposals.
 */
export interface RefinementRecord {
  readonly id: string;              // `ref-<uuid12>`
  readonly repo: string;            // owner/name
  /** Branch the decomposition agent reads. */
  readonly branch: string;
  readonly title: string;
  /** The epic, markdown. */
  readonly story: string;
  readonly status: 'draft' | 'decomposing' | 'ready' | 'failed';
  readonly error: string | null;
  /** Last method used. */
  readonly methodId: string | null;
  readonly specIds: ReadonlyArray<string>;
  readonly docIds: ReadonlyArray<string>;
  /** Agent's enriched overview. */
  readonly summary: string | null;
  /** Last decompose run. */
  readonly runId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** List-page view: the record plus its item tallies. */
export interface RefinementListEntry extends RefinementRecord {
  readonly proposedCount: number;
  readonly importedCount: number;
}

/** One proposed task of a refinement — imported into the board on approval. */
export interface RefineItemRecord {
  readonly id: string;              // `ri-<uuid12>`
  readonly refinementId: string;
  /** Agent's build order. */
  readonly ord: number;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly priority: TaskPriority;
  readonly status: 'proposed' | 'imported' | 'dismissed';
  /** Board task once imported. */
  readonly taskId: string | null;
  readonly createdAt: number;
}

/** A decomposition method — built-in or user-defined per workspace. */
export interface RefineMethodRecord {
  readonly id: string;              // 'builtin-…' or `rm-<uuid12>`
  /** null = built-in. */
  readonly workspaceId: string | null;
  readonly name: string;
  readonly description: string;
  /** How to decompose, fed verbatim to the agent. */
  readonly instructions: string;
  readonly builtin: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Spec/doc picker options for a refinement's repo+workspace. */
export interface RefineContextOptions {
  readonly specs: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly docs: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}
