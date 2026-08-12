import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepoScopeResolver, createStepOutputScopeResolver } from '../dist/api/ws-scope.js';

test('raw pipeline stdout is visible only to the run owner', () => {
  const resolve = createStepOutputScopeResolver();
  const scope = resolve({
    t: 'pipelineStep.output',
    repo: 'private/repo',
    runId: 'plr-1',
    ownerId: 'alice',
    stepIndex: 0,
    sequence: 1,
    chunk: 'private source\n',
  });

  assert.equal(scope('alice'), true);
  assert.equal(scope('bob'), false);
  assert.equal(resolve({ t: 'pipelineRuns.changed', repo: 'private/repo' }), null);
});

test('PR status patches require both PR permission and workspace access', () => {
  const roles = new Map([
    ['alice', 'maintainer'],
    ['bob', 'maintainer'],
    ['bea', 'business'],
  ]);
  const ctx = {
    services: {
      get: (id) => {
        if (id === 'core') return { activeUserRole: (username) => roles.get(username) ?? null };
        if (id === 'workspace') return { canAccessRepo: (user) => user.username !== 'bob' };
        throw new Error(`unexpected service ${id}`);
      },
    },
    rbac: { allows: (user, permission) => permission === 'prs:read' && user.role !== 'business' },
  };
  const resolve = createRepoScopeResolver(ctx);
  const scope = resolve({
    t: 'prStatus.changed',
    repo: 'private/repo',
    number: 42,
    status: {
      checks: { state: 'passing', total: 2, passed: 2, failed: 0, pending: 0, fetchedAt: 1 },
      reviewDecision: 'approved',
      mergeable: true,
      mergeStateStatus: 'clean',
    },
  });

  assert.equal(scope('alice'), true);
  assert.equal(scope('bob'), false);
  assert.equal(scope('bea'), false);
  // The sibling repository signals go through the same gate; this one needs
  // pipelines:read, which the stub grants to nobody.
  assert.equal(resolve({ t: 'pipelineRuns.changed', repo: 'private/repo' })('alice'), false);
});
