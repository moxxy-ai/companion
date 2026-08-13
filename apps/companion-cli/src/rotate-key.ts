import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database, decodeSecretKey, readSecretEncryptionKey } from '@moxxy/companion-services';

/**
 * Re-encrypt every locally stored secret under a new COMPANION_SECRET_KEY.
 *
 * Without this a key change is unrecoverable: the daemon boots, every stored
 * credential fails its GCM tag, and there is no path back short of retyping
 * every provider token by hand. Rotation is the escape hatch that makes the key
 * an operational object rather than a one-way decision.
 *
 * The ciphertext lives in exactly one place, `module_config`, written by
 * SqliteSecretStore as a `{version:1,nonce,ciphertext,tag}` envelope with
 * `moduleId\0key` as AES-GCM additional data. That envelope is self-identifying,
 * so rotation needs no manifests and no kernel boot: a row either parses as one
 * or it is ordinary config and is left alone. The AAD is rebuilt from the same
 * row, so a value cannot silently migrate to another location.
 */

interface SecretRow {
  readonly module_id: string;
  readonly key: string;
  readonly value: string;
}

interface Envelope {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function asEnvelope(value: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const e = parsed as Partial<Envelope>;
  const ok =
    e.version === 1 && typeof e.nonce === 'string' && typeof e.ciphertext === 'string' && typeof e.tag === 'string';
  return ok ? (e as Envelope) : null;
}

function decrypt(envelope: Envelope, key: Buffer, moduleId: string, configKey: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
  decipher.setAAD(Buffer.from(`${moduleId}\0${configKey}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

function encrypt(plaintext: string, key: Buffer, moduleId: string, configKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${moduleId}\0${configKey}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  } satisfies Envelope);
}

async function isRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function rotateSecretKey(
  home: string,
  baseUrl: string,
  options: { readonly newKey?: string } = {},
): Promise<void> {
  if (await isRunning(baseUrl)) {
    throw new Error(
      `Companion is still running at ${baseUrl}.\n` +
        `Stop it first: the daemon holds the old key in memory and would keep writing secrets with it.`,
    );
  }

  const dbFile = join(home, 'companion.db');
  if (!existsSync(dbFile)) throw new Error(`No database at ${dbFile}. Check --home.`);

  const current = readSecretEncryptionKey();
  const next = options.newKey ? decodeSecretKey(options.newKey.trim(), '--new-key') : randomBytes(32);

  const db = new Database(dbFile);
  try {
    const hasTable =
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'module_config'`).get() !== undefined;
    const rows = hasTable
      ? (db.prepare(`SELECT module_id, key, value FROM module_config`).all() as SecretRow[])
      : [];
    const encrypted = rows.flatMap((row) => {
      const envelope = asEnvelope(row.value);
      return envelope ? [{ row, envelope }] : [];
    });

    if (encrypted.length === 0) {
      // Nothing to re-encrypt, so nothing can be lost. Installing a key here
      // would still be wrong: an operator asking to rotate a key that protects
      // nothing has almost certainly pointed --home somewhere unexpected.
      throw new Error(
        `${dbFile} holds no encrypted secrets, so there is nothing to rotate.\n` +
          `If you meant to set a key for the first time, start the daemon: it creates one.`,
      );
    }
    if (!current) {
      throw new Error(
        `${encrypted.length} encrypted secret(s) are stored, but no current key could be found.\n` +
          `Restore the secret-key file or set COMPANION_SECRET_KEY(_FILE) to the key they were written with.`,
      );
    }
    if (current.origin === 'env' && !options.newKey) {
      // Generating here would print the only copy of a key that now protects the
      // whole database. Making the operator supply it means they cannot lose a
      // key they have already stored wherever this environment comes from.
      throw new Error(
        'The current key comes from the environment, so this command cannot install its replacement.\n' +
          'Generate one, store it wherever COMPANION_SECRET_KEY is set, then pass it here:\n' +
          `  companion rotate-key --new-key ${randomBytes(32).toString('base64url')}`,
      );
    }

    // Decrypt EVERYTHING before writing anything. A row that fails here means
    // the old key is wrong or the row is corrupt, and finding that out halfway
    // through a rewrite would leave the table split across two keys.
    const plaintexts = encrypted.map(({ row, envelope }) => {
      try {
        return { row, plaintext: decrypt(envelope, current.key, row.module_id, row.key) };
      } catch {
        throw new Error(
          `secret ${row.module_id}:${row.key} could not be decrypted with the current key. ` +
            'Nothing was changed. Check that COMPANION_SECRET_KEY(_FILE) is the key these secrets were written with.',
        );
      }
    });

    // The key file moves aside BEFORE the commit, so an interrupted rotation
    // leaves both keys on disk and the database still readable with the old
    // one. Losing power between these two steps must never destroy data.
    const keyFile = current.origin === 'file' ? current.file : null;
    const aside = keyFile ? `${keyFile}.pre-rotate-${new Date().toISOString().replace(/[:.]/g, '-')}` : null;
    if (keyFile && aside) renameSync(keyFile, aside);

    try {
      const update = db.prepare(`UPDATE module_config SET value = ? WHERE module_id = ? AND key = ?`);
      db.transaction(() => {
        for (const { row, plaintext } of plaintexts) {
          update.run(encrypt(plaintext, next, row.module_id, row.key), row.module_id, row.key);
        }
      })();
      if (keyFile) writeFileSync(keyFile, `${next.toString('base64url')}\n`, { mode: 0o600 });
    } catch (err) {
      // Put the old key back: the transaction rolled back, so it is once again
      // the key that reads this database.
      if (keyFile && aside && existsSync(aside) && !existsSync(keyFile)) renameSync(aside, keyFile);
      throw err;
    }

    process.stdout.write(
      `Rotated the encryption key for ${plaintexts.length} secret(s) in ${dbFile}\n` +
        (keyFile
          ? `  new key written to ${keyFile}\n  previous key kept at ${aside}\n`
          : `  new key is the one you supplied; the environment must already serve it\n`) +
        `\nStart Companion again and confirm a stored credential still works.\n` +
        (keyFile ? `Delete ${aside} once you have: it still decrypts any older database backup.\n` : ''),
    );
  } finally {
    db.close();
  }
}
