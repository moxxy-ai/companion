import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { SqliteSecretStore } from '@moxxy/companion-core/server';
import { rotateSecretKey } from '../dist/rotate-key.js';

/**
 * Rotation is the escape hatch for a key change that would otherwise be
 * unrecoverable. The assertions deliberately go through the REAL
 * SqliteSecretStore rather than the command's own crypto: what matters is that
 * the daemon can read the rows afterwards, not that rotate agrees with itself.
 */

/** An unreachable address, so the running check answers "stopped" without a server. */
const STOPPED = 'http://127.0.0.1:9';

const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-rotate-'));
  const previous = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previous;
    delete process.env.COMPANION_SECRET_KEY;
    delete process.env.COMPANION_SECRET_KEY_FILE;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function openDb(dir) {
  const db = new Database(join(dir, 'companion.db'));
  db.exec(
    `CREATE TABLE IF NOT EXISTS module_config (
       module_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
       PRIMARY KEY (module_id, key))`,
  );
  return db;
}

/** Seed secrets the way the daemon writes them, plus one ordinary config row. */
function seed(dir, key = OLD_KEY) {
  const db = openDb(dir);
  const store = new SqliteSecretStore(db, () => true, key);
  store.set('notify', 'smtpPassword', 'hunter2');
  store.set('jira', 'apiToken', 'jira-token-value');
  db.prepare(`INSERT INTO module_config (module_id, key, value, updated_at) VALUES (?,?,?,?)`)
    .run('code', 'defaultBranch', JSON.stringify('main'), 0);
  db.close();
  writeFileSync(join(dir, 'secret-key'), `${key.toString('base64url')}\n`, { mode: 0o600 });
}

function readWith(dir, key, moduleId, configKey) {
  const db = new Database(join(dir, 'companion.db'), { readOnly: true });
  try {
    return new SqliteSecretStore(db, () => true, key).get(moduleId, configKey);
  } finally {
    db.close();
  }
}

test('secrets survive rotation and the old key stops working', async (t) => {
  const dir = home(t);
  seed(dir);

  await rotateSecretKey(dir, STOPPED, { newKey: NEW_KEY.toString('base64url') });

  assert.equal(readWith(dir, NEW_KEY, 'notify', 'smtpPassword'), 'hunter2');
  assert.equal(readWith(dir, NEW_KEY, 'jira', 'apiToken'), 'jira-token-value');
  // The point of rotating: the retired key no longer opens the database.
  assert.throws(() => readWith(dir, OLD_KEY, 'notify', 'smtpPassword'), /could not be decrypted/);
});

test('the new key lands in the key file and the old one is kept aside', async (t) => {
  const dir = home(t);
  seed(dir);

  await rotateSecretKey(dir, STOPPED, { newKey: NEW_KEY.toString('base64url') });

  assert.equal(readFileSync(join(dir, 'secret-key'), 'utf8').trim(), NEW_KEY.toString('base64url'));
  const kept = readdirSync(dir).filter((f) => f.startsWith('secret-key.pre-rotate-'));
  assert.equal(kept.length, 1, 'exactly one retired key is kept');
  assert.equal(readFileSync(join(dir, kept[0]), 'utf8').trim(), OLD_KEY.toString('base64url'));
});

test('a generated key is used when none is supplied', async (t) => {
  const dir = home(t);
  seed(dir);

  await rotateSecretKey(dir, STOPPED);

  const written = Buffer.from(readFileSync(join(dir, 'secret-key'), 'utf8').trim(), 'base64url');
  assert.equal(written.byteLength, 32);
  assert.notDeepEqual(written, OLD_KEY);
  assert.equal(readWith(dir, written, 'notify', 'smtpPassword'), 'hunter2');
});

test('ordinary config rows are left exactly as they were', async (t) => {
  const dir = home(t);
  seed(dir);

  await rotateSecretKey(dir, STOPPED, { newKey: NEW_KEY.toString('base64url') });

  const db = new Database(join(dir, 'companion.db'), { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT value FROM module_config WHERE module_id = 'code' AND key = 'defaultBranch'`)
      .get();
    assert.equal(row.value, JSON.stringify('main'));
  } finally {
    db.close();
  }
});

test('a wrong current key changes nothing at all', async (t) => {
  const dir = home(t);
  seed(dir);
  // The operator restored the wrong secret-key file next to a live database.
  writeFileSync(join(dir, 'secret-key'), `${Buffer.alloc(32, 9).toString('base64url')}\n`, { mode: 0o600 });

  await assert.rejects(
    () => rotateSecretKey(dir, STOPPED, { newKey: NEW_KEY.toString('base64url') }),
    /could not be decrypted with the current key/,
  );

  // Refusing is only useful if it refuses BEFORE writing: the real key must
  // still open every row, and no half-rotated state may be left behind.
  assert.equal(readWith(dir, OLD_KEY, 'notify', 'smtpPassword'), 'hunter2');
  assert.equal(readWith(dir, OLD_KEY, 'jira', 'apiToken'), 'jira-token-value');
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('secret-key.pre-rotate-')).length, 0);
});

test('an environment-held key refuses to rotate without an explicit replacement', async (t) => {
  const dir = home(t);
  seed(dir);
  rmSync(join(dir, 'secret-key'));
  process.env.COMPANION_SECRET_KEY = OLD_KEY.toString('base64url');

  // Generating here would print the only copy of the key protecting the whole
  // database, so the operator has to supply one they have already stored.
  await assert.rejects(() => rotateSecretKey(dir, STOPPED), /cannot install its replacement/);
  assert.equal(readWith(dir, OLD_KEY, 'notify', 'smtpPassword'), 'hunter2');

  await rotateSecretKey(dir, STOPPED, { newKey: NEW_KEY.toString('base64url') });
  assert.equal(readWith(dir, NEW_KEY, 'notify', 'smtpPassword'), 'hunter2');
  // Nothing was written to disk: the environment is where that key lives.
  assert.equal(existsSync(join(dir, 'secret-key')), false);
});

test('a database with no encrypted secrets says so instead of installing a key', async (t) => {
  const dir = home(t);
  openDb(dir).close();
  writeFileSync(join(dir, 'secret-key'), `${OLD_KEY.toString('base64url')}\n`, { mode: 0o600 });

  await assert.rejects(() => rotateSecretKey(dir, STOPPED), /nothing to rotate/);
});

test('a missing current key refuses rather than orphaning the ciphertext', async (t) => {
  const dir = home(t);
  seed(dir);
  rmSync(join(dir, 'secret-key'));

  await assert.rejects(() => rotateSecretKey(dir, STOPPED), /no current key could be found/);
});

test('rotation refuses while the daemon is reachable', async (t) => {
  const dir = home(t);
  seed(dir);
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  await assert.rejects(
    () => rotateSecretKey(dir, `http://127.0.0.1:${server.address().port}`),
    /still running/,
  );
  assert.equal(readWith(dir, OLD_KEY, 'notify', 'smtpPassword'), 'hunter2');
});
