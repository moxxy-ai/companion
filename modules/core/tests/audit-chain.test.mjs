import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { AuditStore } from '../dist/api/audit-store.js';

/**
 * Append-only was a convention the application could break without leaving a
 * mark: anything with write access to the database could edit or drop a row and
 * the export would look untouched. Each row now commits to its predecessor, so
 * the tamper shows up as a broken link.
 */

function store() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return { db, audit: new AuditStore(db) };
}

function record(audit, n) {
  audit.record({
    at: 1_700_000_000_000 + n,
    actor: `user-${n}`,
    action: `POST /api/thing/${n}`,
    access: 'things:manage',
    status: 200,
    module: 'core',
  });
}

test('an untouched trail verifies', () => {
  const { db, audit } = store();
  for (let n = 0; n < 5; n++) record(audit, n);

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.brokenAt, null);
  // Five rows are four verifiable links: the oldest one's predecessor may have
  // been pruned, so it is entered rather than checked.
  assert.equal(verdict.checked, 4);
  assert.equal(verdict.unchained, 0);
  db.close();
});

test('editing a row in place is caught', () => {
  const { db, audit } = store();
  for (let n = 0; n < 5; n++) record(audit, n);
  // The exact tamper the chain exists for: rewrite who did it, leave the digest
  // alone so the row still looks well-formed.
  db.prepare(`UPDATE audit_log SET actor = 'nobody' WHERE id = 3`).run();

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.brokenAt, 3);
  db.close();
});

test('rewriting the digest without the row is caught too', () => {
  const { db, audit } = store();
  for (let n = 0; n < 5; n++) record(audit, n);
  // The other half of the same tamper: leave the contents, forge the digest.
  db.prepare(`UPDATE audit_log SET hash = ? WHERE id = 3`).run('0'.repeat(64));

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.brokenAt, 3);
  db.close();
});

test('deleting a row from the middle is caught', () => {
  const { db, audit } = store();
  for (let n = 0; n < 5; n++) record(audit, n);
  db.prepare(`DELETE FROM audit_log WHERE id = 3`).run();

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.brokenAt, 4, 'the row after the hole no longer follows its predecessor');
  db.close();
});

test('retention pruning the front leaves a verifiable chain', () => {
  const { db, audit } = store();
  for (let n = 0; n < 6; n++) record(audit, n);
  // Deleting from the front is what retention does, and it is indistinguishable
  // from an attacker doing the same; the verdict must stay honest about that
  // rather than claim a pass means nothing was ever removed.
  db.prepare(`DELETE FROM audit_log WHERE id <= 2`).run();

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.from, 3);
  assert.equal(verdict.to, 6);
  assert.equal(verdict.checked, 3);
  db.close();
});

test('rows written before the chain existed are reported, not silently passed', () => {
  const { db, audit } = store();
  db.prepare(
    `INSERT INTO audit_log (at, actor, action, access, status, module) VALUES (1, 'old', 'GET /x', 'any', 200, 'core')`,
  ).run();
  for (let n = 0; n < 3; n++) record(audit, n);

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unchained, 1, 'the pre-migration row is counted, not covered');
  assert.equal(verdict.from, 2);
  db.close();
});

test('an empty trail verifies without pretending to cover anything', () => {
  const { db, audit } = store();
  const verdict = audit.verifyChain();
  assert.deepEqual(verdict, { ok: true, checked: 0, from: null, to: null, brokenAt: null, unchained: 0 });
  db.close();
});

test('appending after a verification continues the same chain', () => {
  const { db, audit } = store();
  for (let n = 0; n < 3; n++) record(audit, n);
  assert.equal(audit.verifyChain().ok, true);
  for (let n = 3; n < 6; n++) record(audit, n);

  const verdict = audit.verifyChain();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, 5);
  db.close();
});

test('the chain survives a reopened store', () => {
  // The tail digest is read from the table, not held in memory, so a daemon
  // restart must not start a second chain.
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const first = new AuditStore(db);
  for (let n = 0; n < 3; n++) record(first, n);

  const second = new AuditStore(db);
  for (let n = 3; n < 6; n++) record(second, n);

  assert.equal(second.verifyChain().ok, true);
  assert.equal(second.verifyChain().checked, 5);
  db.close();
});
