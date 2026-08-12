import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRepoScopeResolver, repoScopedMessageTypes } from '../dist/api/ws-scope.js';

/**
 * Repository names are broadcast state. The hub sends any message no resolver
 * claims to every authenticated socket, so an unclaimed `{ repo }` signal tells
 * a viewer with no access to a private workspace which repositories are in it
 * and when they change: exactly the boundary canAccessRepo draws for REST.
 */

const here = dirname(fileURLToPath(import.meta.url));

function ctx({ role = 'maintainer', allows = () => true, canAccessRepo = () => true } = {}) {
  return {
    rbac: { allows },
    services: {
      get: (id) =>
        ({
          core: { activeUserRole: () => role },
          workspace: { canAccessRepo },
        })[id],
    },
  };
}

test('a repository signal is withheld from someone who cannot reach the repository', () => {
  const seen = [];
  const resolve = createRepoScopeResolver(
    ctx({
      canAccessRepo: (user, repo) => {
        seen.push([user.username, repo]);
        return repo !== 'acme/private';
      },
    }),
  );

  const scope = resolve({ t: 'issues.changed', repo: 'acme/private' });
  assert.ok(scope, 'the message is claimed rather than broadcast');
  assert.equal(scope('outsider'), false);
  assert.deepEqual(seen, [['outsider', 'acme/private']]);
  assert.equal(resolve({ t: 'issues.changed', repo: 'acme/open' })('member'), true);
});

test('the read permission for each signal matches the route that returns the same thing', () => {
  const asked = [];
  const resolve = createRepoScopeResolver(ctx({ allows: (_u, p) => void asked.push(p) ?? true }));

  for (const [type, expected] of [
    ['issues.changed', 'issues:read'],
    ['triage.changed', 'issues:read'],
    ['prs.changed', 'prs:read'],
    ['prStatus.changed', 'prs:read'],
    ['pipelineRuns.changed', 'pipelines:read'],
  ]) {
    asked.length = 0;
    resolve({ t: type, repo: 'acme/app' })('ann');
    assert.deepEqual(asked, [expected], `${type} is gated on ${expected}`);
  }
});

test('a disabled or deleted account sees nothing', () => {
  // activeUserRole answers null once the account is gone; a socket that outlives
  // it must not keep receiving repository state.
  const resolve = createRepoScopeResolver(ctx({ role: null }));
  assert.equal(resolve({ t: 'prs.changed', repo: 'acme/app' })('ghost'), false);
});

test('messages this module does not scope are passed on rather than claimed', () => {
  const resolve = createRepoScopeResolver(ctx());
  // Content-free invalidation signals: the refetch they trigger is RBAC-gated,
  // so claiming them would buy nothing and cost every list view its liveness.
  assert.equal(resolve({ t: 'repos.changed' }), null);
  assert.equal(resolve({ t: 'pipelines.changed' }), null);
  // Another module's message must fall through to that module's resolver.
  assert.equal(resolve({ t: 'run.changed', run: {} }), null);
});

test('every declared message carrying a repo is claimed', () => {
  // Reads the contract rather than a list kept here: adding a `{ repo }` message
  // and forgetting to scope it is the regression this guards, and a hand-copied
  // list would be updated by the same commit that forgot.
  const contract = readFileSync(join(here, '../src/contract/index.ts'), 'utf8');
  const registry = /interface ServerMessageRegistry\s*\{([\s\S]*?)\n  \}/.exec(contract);
  assert.ok(registry, 'the contract declares a ServerMessageRegistry');

  const declared = [...registry[1].matchAll(/'([^']+)':\s*(\{[\s\S]*?\}|Record<never, never>);/g)];
  assert.ok(declared.length >= 8, `parsed ${declared.length} message types`);

  const carryingRepo = declared.filter(([, , payload]) => /\breadonly repo:\s*string/.test(payload)).map(([, t]) => t);
  assert.ok(carryingRepo.length > 0, 'the parser actually finds repo-carrying messages');

  const claimed = new Set(repoScopedMessageTypes);
  // pipelineStep.output also carries a repo but is owner-scoped, which is
  // strictly tighter, so it is claimed by its own resolver instead.
  const unclaimed = carryingRepo.filter((t) => !claimed.has(t) && t !== 'pipelineStep.output');
  assert.deepEqual(unclaimed, [], `these broadcast a repository name to every socket: ${unclaimed.join(', ')}`);
});
