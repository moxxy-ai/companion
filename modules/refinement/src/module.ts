import { defineManifest } from '@companion/core';

/**
 * module-refinement — product refinement: a user writes an epic, picks a
 * decomposition method, and a read-only agent (in a worktree at a chosen
 * branch) enriches and splits it into concrete tasks the user reviews and
 * imports into the Task Board. The agent only proposes; the human imports.
 */
export default defineManifest({
  id: 'refinement',
  title: 'Product Refinement',
  version: '0.1.0',
  // Hard deps: refinements live on repos (code), the decomposition agent runs
  // through operate (orchestrator + worktrees), context comes from plan
  // (specs/docs), imported tasks land on the board, and everything scopes
  // through workspaces.
  dependsOn: ['core', 'workspace', 'code', 'operate', 'plan', 'board'],
  required: false,
  permissions: ['refine:read', 'refine:manage'],
  messages: ['refinement.changed'],
});
