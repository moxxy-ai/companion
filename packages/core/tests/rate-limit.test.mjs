import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DynamicRouter, RateLimiter, route } from '../dist/server/index.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * The per-address budget for unauthenticated `/api` traffic. Before it, login
 * and the OIDC handshake were the only throttled routes and everything else
 * could be hammered for free.
 *
 * Driven through a real socket so the address the limiter keys on is the one
 * the router actually derives; the test peer is always 127.0.0.1.
 */
async function harness(t, { rateLimitPerMinute, user = null }) {
  const router = new DynamicRouter({ verify: () => user, require: () => {} }, log, () => {}, {
    rateLimitPerMinute,
  });
  router.mount('probe', [
    route({ method: 'GET', path: '/api/open', access: 'public', handler: () => ({ ok: true }) }),
  ]);
  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path = '/api/open') => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, retryAfter: res.headers.get('retry-after') };
  };
}

test('an anonymous caller is refused once it exceeds its budget', async (t) => {
  const call = await harness(t, { rateLimitPerMinute: 3 });

  for (let i = 0; i < 3; i++) assert.equal((await call()).status, 200, `request ${i + 1} is within budget`);
  const refused = await call();
  assert.equal(refused.status, 429);
  // A 429 without Retry-After tells a client nothing about when to come back.
  assert.ok(Number(refused.retryAfter) > 0, 'the refusal carries Retry-After');
});

test('an authenticated caller is not limited', async (t) => {
  // Accounts are revocable and the SPA polls; capping them would break
  // legitimate use to mitigate what session revocation already answers.
  const call = await harness(t, { rateLimitPerMinute: 2, user: { username: 'ada', role: 'admin' } });
  for (let i = 0; i < 6; i++) assert.equal((await call()).status, 200);
});

test('a zero budget disables the limiter', async (t) => {
  const call = await harness(t, { rateLimitPerMinute: 0 });
  for (let i = 0; i < 10; i++) assert.equal((await call()).status, 200);
});

test('an unmatched path is answered without spending the budget', async (t) => {
  // It reaches no handler and touches no database, so it is deliberately
  // outside the budget; keeping it out means a 404 flood cannot lock out a
  // legitimate caller sharing the address.
  const call = await harness(t, { rateLimitPerMinute: 2 });

  for (let i = 0; i < 5; i++) assert.equal((await call('/api/nothing-here')).status, 404);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
});

test('addresses hold separate budgets', () => {
  const limiter = new RateLimiter(2);
  const now = 1_000_000;
  assert.equal(limiter.check('10.0.0.1', now), 0);
  assert.equal(limiter.check('10.0.0.1', now), 0);
  assert.ok(limiter.check('10.0.0.1', now) > 0, 'the first address is spent');
  assert.equal(limiter.check('10.0.0.2', now), 0, 'the second address is untouched');
});

test('the window reopens once it has passed', () => {
  const limiter = new RateLimiter(1);
  const now = 1_000_000;
  assert.equal(limiter.check('10.0.0.1', now), 0);
  const wait = limiter.check('10.0.0.1', now);
  assert.equal(wait, 60, 'a full window remains when the budget is spent immediately');
  assert.ok(limiter.check('10.0.0.1', now + 59_000) > 0, 'still inside the window');
  assert.equal(limiter.check('10.0.0.1', now + 60_001), 0, 'a new window starts clean');
});

test('a disabled limiter reports itself disabled and never waits', () => {
  const limiter = new RateLimiter(0);
  assert.equal(limiter.enabled, false);
  for (let i = 0; i < 100; i++) assert.equal(limiter.check('10.0.0.1', 1_000_000), 0);
});
