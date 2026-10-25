import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

/**
 * Backup encryption in the OpenSSL `enc` container format, so an encrypted
 * dump can be opened on any machine with stock tooling — no POS install needed
 * during a disaster:
 *
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
 *     -in backup.dump.enc -out backup.dump
 *
 * Layout: "Salted__" | 8-byte salt | AES-256-CBC ciphertext (PKCS#7).
 * Key and IV come from PBKDF2-HMAC-SHA256(password, salt, 600000) → 48 bytes.
 * Integrity is checked separately (SHA-256 sidecar + `pg_restore --list`).
 */
export const ENCRYPTED_SUFFIX = '.enc';
export const PBKDF2_ITERATIONS = 600_000;
/** `openssl enc -pbkdf2` default, used by backups written before the format above. */
const LEGACY_ITERATIONS = 10_000;
const MAGIC = Buffer.from('Salted__', 'latin1');
const pbkdf2Async = promisify(pbkdf2);

async function deriveKeyIv(password: string, salt: Buffer, iterations = PBKDF2_ITERATIONS): Promise<{ key: Buffer; iv: Buffer }> {
  const out = await pbkdf2Async(Buffer.from(password, 'utf8'), salt, iterations, 48, 'sha256');
  return { key: out.subarray(0, 32), iv: out.subarray(32, 48) };
}

export async function encryptFile(src: string, dest: string, password: string): Promise<void> {
  if (!password) throw new Error('encryption password is empty');
  const salt = randomBytes(8);
  const { key, iv } = await deriveKeyIv(password, salt);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, salt]));
  await pipeline(createReadStream(src), createCipheriv('aes-256-cbc', key, iv), out);
}

export async function decryptFile(src: string, dest: string, password: string): Promise<void> {
  if (!password) throw new Error('backup is encrypted but no password is configured (BACKUP_ENCRYPTION_PASSWORD)');
  const fh = await open(src, 'r');
  const header = Buffer.alloc(16);
  try {
    await fh.read(header, 0, 16, 0);
  } finally {
    await fh.close();
  }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('not an encrypted backup (missing Salted__ header)');
  let lastErr: unknown;
  for (const iterations of [PBKDF2_ITERATIONS, LEGACY_ITERATIONS]) {
    const { key, iv } = await deriveKeyIv(password, header.subarray(8, 16), iterations);
    try {
      await pipeline(createReadStream(src, { start: 16 }), createDecipheriv('aes-256-cbc', key, iv), createWriteStream(dest));
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  // A wrong password almost always surfaces as a padding error on the last block.
  if (/bad decrypt|wrong final block/i.test(String((lastErr as Error)?.message))) {
    throw new Error('decryption failed: wrong password or corrupted file');
  }
  throw lastErr;
}
