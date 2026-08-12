import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isLoopbackHost, isTrustedLocalHttpRequest, loadDaemonConfig } from '../dist/index.js';

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'companion-config-'));
  const previous = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previous;
    delete process.env.COMPANION_AUTH_MODE;
    delete process.env.COMPANION_HOST;
    rmSync(home, { recursive: true, force: true });
  }
}

test('password auth is the daemon default', () => {
  withHome(() => assert.equal(loadDaemonConfig().authMode, 'password'));
});

test('sso auth mode is accepted from the environment and needs no loopback bind', () => {
  withHome(() => {
    process.env.COMPANION_AUTH_MODE = 'sso';
    process.env.COMPANION_HOST = '0.0.0.0';
    assert.equal(loadDaemonConfig().authMode, 'sso');
    process.env.COMPANION_AUTH_MODE = 'nonsense';
    assert.throws(() => loadDaemonConfig(), /expected local, password or sso/);
  });
});

test('trusted local auth accepts loopback and rejects a network bind', () => {
  withHome((home) => {
    writeFileSync(join(home, 'companiond.json'), JSON.stringify({ authMode: 'local', host: '127.0.0.1' }));
    assert.equal(loadDaemonConfig().authMode, 'local');
    process.env.COMPANION_HOST = '0.0.0.0';
    assert.throws(() => loadDaemonConfig(), /requires a loopback bind/);
  });
});

/**
 * Seed credentials arrive through the environment, and every process the daemon
 * spawns (git, agent runs) inherits that environment. They must survive exactly
 * long enough to reach `users` and no longer.
 */
test('seed passwords reach users and then leave the environment', () => {
  withHome(() => {
    process.env.COMPANION_ADMIN_USER = 'ada';
    process.env.COMPANION_ADMIN_PASSWORD = 'seed-admin-pw';
    process.env.COMPANION_MAINTAINER_USER = 'mel';
    process.env.COMPANION_MAINTAINER_PASSWORD = 'seed-maintainer-pw';
    process.env.COMPANION_BUSINESS_USER = 'bea';
    process.env.COMPANION_BUSINESS_PASSWORD = 'seed-business-pw';
    try {
      const config = loadDaemonConfig();

      assert.deepEqual(
        config.users.map((u) => [u.username, u.password, u.role]),
        [
          ['ada', 'seed-admin-pw', 'admin'],
          ['mel', 'seed-maintainer-pw', 'maintainer'],
          ['bea', 'seed-business-pw', 'business'],
        ],
      );
      for (const key of [
        'COMPANION_ADMIN_PASSWORD',
        'COMPANION_MAINTAINER_PASSWORD',
        'COMPANION_BUSINESS_PASSWORD',
      ]) {
        assert.equal(process.env[key], undefined, `${key} is gone from the environment`);
      }
      // Usernames are not credentials and stay: the CLI reads them to tell an
      // operator which account was seeded.
      assert.equal(process.env.COMPANION_ADMIN_USER, 'ada');
    } finally {
      for (const key of [
        'COMPANION_ADMIN_USER',
        'COMPANION_ADMIN_PASSWORD',
        'COMPANION_MAINTAINER_USER',
        'COMPANION_MAINTAINER_PASSWORD',
        'COMPANION_BUSINESS_USER',
        'COMPANION_BUSINESS_PASSWORD',
      ]) {
        delete process.env[key];
      }
    }
  });
});

test('the anonymous request budget reads 0 as a value, not an absence', () => {
  withHome(() => {
    try {
      assert.equal(loadDaemonConfig().rateLimitPerMinute, undefined, 'unset leaves the router default');
      process.env.COMPANION_RATE_LIMIT = '0';
      assert.equal(loadDaemonConfig().rateLimitPerMinute, 0, '0 turns the budget off rather than reading as unset');
      process.env.COMPANION_RATE_LIMIT = '60';
      assert.equal(loadDaemonConfig().rateLimitPerMinute, 60);
      // Falling back silently would hand an operator a budget they did not choose.
      process.env.COMPANION_RATE_LIMIT = 'lots';
      assert.throws(() => loadDaemonConfig(), /expected a non-negative whole number/);
      process.env.COMPANION_RATE_LIMIT = '-1';
      assert.throws(() => loadDaemonConfig(), /expected a non-negative whole number/);
    } finally {
      delete process.env.COMPANION_RATE_LIMIT;
    }
  });
});

test('only explicit loopback bind names qualify', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.10'), false);
});

test('local HTTP admission rejects DNS rebinding and cross-site browser requests', () => {
  assert.equal(isTrustedLocalHttpRequest({ host: '127.0.0.1:8901' }), true);
  assert.equal(
    isTrustedLocalHttpRequest({
      host: 'localhost:8901',
      origin: 'http://localhost:5173',
      secFetchSite: 'same-site',
    }),
    true,
  );
  assert.equal(
    isTrustedLocalHttpRequest({ host: '[::1]:8901', origin: 'http://[::1]:8901', secFetchSite: 'same-origin' }),
    true,
  );
  assert.equal(isTrustedLocalHttpRequest({ host: 'rebind.example:8901', origin: 'https://rebind.example' }), false);
  assert.equal(isTrustedLocalHttpRequest({ host: 'localhost:8901', origin: 'https://evil.example' }), false);
  assert.equal(
    isTrustedLocalHttpRequest({
      host: 'localhost:8901',
      origin: 'http://localhost:8901',
      secFetchSite: 'cross-site',
    }),
    false,
  );
  assert.equal(isTrustedLocalHttpRequest({ host: 'localhost:8901', origin: 'null' }), false);
  assert.equal(isTrustedLocalHttpRequest({}), false);
});
