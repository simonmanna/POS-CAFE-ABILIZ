#!/usr/bin/env node
/*
 * Disaster-recovery restore for POS-CAFE backups. Works with the API stopped
 * (or not installed): only Node and the PostgreSQL client tools are needed.
 *
 *   node scripts/restore-backup.cjs list
 *   node scripts/restore-backup.cjs verify  <backup>
 *   node scripts/restore-backup.cjs restore <backup> [--target <new_db>]
 *   node scripts/restore-backup.cjs promote --target <restored_db>      (API STOPPED)
 *
 * <backup> is a .dump or .dump.enc file: a path, or a name in BACKUP_DIR\full.
 * Settings come from the environment, else apps/api/.env: DATABASE_URL (the live
 * database), PG_BIN, BACKUP_DIR, BACKUP_ENCRYPTION_PASSWORD. Set PGUSER/PGPASSWORD
 * to run as another role (e.g. postgres for `promote`).
 *
 * `restore` only ever creates a NEW database. `promote` swaps it in by renaming:
 * the live database is renamed to <live>_pre_restore_<stamp> and kept, never
 * dropped. See docs/backup-recovery.md.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(ROOT, 'apps', 'api', '.env'));
const setting = (k) => process.env[k] || fileEnv[k] || '';

function die(msg) {
  console.error(`\nSTOP: ${msg}`);
  process.exit(1);
}

const databaseUrl = setting('DATABASE_URL');
if (!databaseUrl) die('DATABASE_URL not set (environment or apps/api/.env)');
const url = new URL(databaseUrl);
const LIVE = decodeURIComponent(url.pathname.replace(/^\//, ''));
const pgEnv = { ...process.env, PGHOST: url.hostname || 'localhost', PGPORT: url.port || '5432' };
delete pgEnv.PGDATABASE;
if (process.env.PGUSER) {
  pgEnv.PGUSER = process.env.PGUSER;
  pgEnv.PGPASSWORD = process.env.PGPASSWORD || '';
} else {
  pgEnv.PGUSER = decodeURIComponent(url.username);
  pgEnv.PGPASSWORD = decodeURIComponent(url.password);
}
if (!pgEnv.PGPASSWORD) delete pgEnv.PGPASSWORD;

const pgBin = setting('PG_BIN');
const tool = (name) => {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin ? path.join(pgBin, exe) : exe;
};
const backupDir = path.resolve(path.join(ROOT, 'apps', 'api'), setting('BACKUP_DIR') || 'backup');

function run(name, args, { capture = false } = {}) {
  const r = spawnSync(tool(name), args, { env: pgEnv, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) die(`${name}: ${r.error.message}`);
  if (r.status !== 0) die(`${name} exited ${r.status}${capture ? `: ${(r.stderr || '').trim()}` : ''}`);
  return capture ? r.stdout : '';
}
const psql = (sql, db = LIVE) => run('psql', ['--no-password', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', `--dbname=${db}`, '-c', sql], { capture: true }).trim();
const dbExists = (name) => psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`, 'postgres') === '1';
const validName = (n) => /^[A-Za-z0-9_]{1,63}$/.test(n || '');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function resolveBackup(arg) {
  if (!arg) die('which backup? Run `list` to see them.');
  const candidates = [path.resolve(arg), path.join(backupDir, 'full', path.basename(arg))];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) die(`backup not found: ${arg} (looked in ${path.join(backupDir, 'full')})`);
  if (!/\.dump(\.enc)?$/i.test(file)) die('not a database backup (.dump or .dump.enc)');
  return file;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest('hex');
}

function checkChecksum(file) {
  const side = `${file}.sha256`;
  if (!fs.existsSync(side)) {
    console.log('  checksum : no .sha256 file next to the backup (older backup) - skipped');
    return;
  }
  const expected = fs.readFileSync(side, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  if (sha256(file) !== expected) die(`${path.basename(file)} does not match its checksum: the file is corrupted. Use another backup (or the copy on the USB/NAS).`);
  console.log('  checksum : OK');
}

/** Same format as apps/api/src/modules/backup/backup-crypto.ts (openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256). */
function decrypt(file) {
  const password = setting('BACKUP_ENCRYPTION_PASSWORD');
  if (!password) die('this backup is encrypted: set BACKUP_ENCRYPTION_PASSWORD (environment or apps/api/.env) to the backup password');
  const out = path.join(path.dirname(file), `${path.basename(file, '.enc')}.${crypto.randomBytes(4).toString('hex')}.partial`);
  const inFd = fs.openSync(file, 'r');
  const outFd = fs.openSync(out, 'w', 0o600);
  try {
    const header = Buffer.alloc(16);
    fs.readSync(inFd, header, 0, 16, 0);
    if (header.subarray(0, 8).toString('latin1') !== 'Salted__') die('encrypted backup has no Salted__ header');
    const decryptWith = (iterations) => {
      const kdf = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), header.subarray(8, 16), iterations, 48, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-cbc', kdf.subarray(0, 32), kdf.subarray(32, 48));
      fs.ftruncateSync(outFd, 0);
      const buf = Buffer.alloc(8 * 1024 * 1024);
      let n;
      let pos = 16;
      let outPos = 0;
      while ((n = fs.readSync(inFd, buf, 0, buf.length, pos)) > 0) {
        pos += n;
        outPos += fs.writeSync(outFd, decipher.update(buf.subarray(0, n)), 0, undefined, outPos);
      }
      fs.writeSync(outFd, decipher.final(), 0, undefined, outPos);
    };
    // 600000 = current format; 10000 = openssl's default, used by older backups.
    const ok = [600000, 10000].some((iterations) => { try { decryptWith(iterations); return true; } catch { return false; } });
    if (!ok) {
      fs.closeSync(outFd);
      fs.rmSync(out, { force: true });
      die('decryption failed: wrong BACKUP_ENCRYPTION_PASSWORD or corrupted file');
    }
  } finally {
    fs.closeSync(inFd);
    try { fs.closeSync(outFd); } catch { /* closed above */ }
  }
  console.log('  decrypt  : OK');
  return out;
}

function prepare(file) {
  console.log(`Backup: ${file}`);
  checkChecksum(file);
  const dump = file.endsWith('.enc') ? decrypt(file) : file;
  const toc = run('pg_restore', ['--list', dump], { capture: true }).split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
  if (toc === 0) die('the archive has no entries');
  console.log(`  archive  : ${toc} entries readable`);
  return { dump, cleanup: () => { if (dump !== file) fs.rmSync(dump, { force: true }); } };
}

function summary(db) {
  const q = (sql) => {
    const r = spawnSync(tool('psql'), ['--no-password', '-X', '-q', '-t', '-A', `--dbname=${db}`, '-c', sql], { env: pgEnv, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '?';
  };
  return [
    `${q("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")} tables`,
    `${q('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')} migrations`,
    `${q('SELECT count(*) FROM "Organization"')} organizations`,
    `${q('SELECT count(*) FROM "Invoice"')} invoices`,
    `latest invoice ${q(`SELECT coalesce(max("createdAt")::text, '-') FROM "Invoice"`)}`,
  ].join(', ');
}

function opt(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const [cmd, arg] = process.argv.slice(2);
console.log(`Live database: ${LIVE} on ${pgEnv.PGHOST}:${pgEnv.PGPORT} as ${pgEnv.PGUSER}\n`);

if (cmd === 'list') {
  const dir = path.join(backupDir, 'full');
  if (!fs.existsSync(dir)) die(`no backup folder at ${dir}`);
  const items = fs.readdirSync(dir)
    .filter((n) => /\.dump(\.enc)?$/i.test(n))
    .map((n) => ({ n, st: fs.statSync(path.join(dir, n)) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  console.log(`Backups in ${dir} (newest first):`);
  for (const { n, st } of items) console.log(`  ${st.mtime.toISOString().replace('T', ' ').slice(0, 19)}  ${(st.size / 1048576).toFixed(1).padStart(8)} MB  ${n}`);
  if (!items.length) console.log('  (none)');
} else if (cmd === 'verify') {
  const p = prepare(resolveBackup(arg));
  p.cleanup();
  console.log('\nVerified: the backup is intact and readable. (`restore` proves it fully.)');
} else if (cmd === 'restore') {
  const file = resolveBackup(arg);
  const target = opt('--target') || `${LIVE.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)}_restored_${stamp()}`;
  if (!validName(target)) die('--target may only contain letters, digits and _ (max 63)');
  if (target.toLowerCase() === LIVE.toLowerCase()) die(`never restore over the live database "${LIVE}". Restore into a new one, then use promote.`);
  if (dbExists(target)) die(`database ${target} already exists - pick a new --target`);
  const p = prepare(file);
  try {
    console.log(`\nCreating ${target} and restoring (this can take a few minutes)...`);
    run('createdb', ['--no-password', '--template=template0', target]);
    const r = spawnSync(tool('pg_restore'), ['--no-owner', '--no-password', '--exit-on-error', `--dbname=${target}`, p.dump], { env: pgEnv, stdio: 'inherit' });
    if (r.status !== 0) {
      spawnSync(tool('dropdb'), ['--no-password', '--if-exists', target], { env: pgEnv, stdio: 'inherit' });
      die(`pg_restore failed (exit ${r.status}); the half-restored ${target} was dropped. The live database was not touched.`);
    }
  } finally {
    p.cleanup();
  }
  console.log(`\nRestored : ${summary(target)}`);
  console.log(`Live now : ${summary(LIVE)}`);
  console.log(`\nThe live database "${LIVE}" was NOT changed. To run the cafe on the restored copy:`);
  console.log('  1. nssm stop pos-cafe-api        (and stop any other process using the database)');
  console.log(`  2. node scripts/restore-backup.cjs promote --target ${target}`);
  console.log('  3. nssm start pos-cafe-api, then check /api/v1/health and a test sale');
} else if (cmd === 'promote') {
  const target = opt('--target');
  if (!validName(target)) die('promote needs --target <restored_db>');
  if (target.toLowerCase() === LIVE.toLowerCase()) die('--target is the live database');
  if (!dbExists(target)) die(`database ${target} does not exist`);
  const busy = psql(`SELECT count(*) FROM pg_stat_activity WHERE datname IN ('${LIVE.replace(/'/g, "''")}', '${target}') AND pid <> pg_backend_pid()`, 'postgres');
  if (busy !== '0') die(`${busy} connection(s) still open on ${LIVE}/${target}. Stop the API (nssm stop pos-cafe-api) and anything else using the database, then retry.`);
  const keep = `${LIVE.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30)}_pre_restore_${stamp()}`;
  const liveExists = dbExists(LIVE);
  if (liveExists) psql(`ALTER DATABASE "${LIVE}" RENAME TO "${keep}"`, 'postgres');
  psql(`ALTER DATABASE "${target}" RENAME TO "${LIVE}"`, 'postgres');
  console.log(`Promoted: ${target} is now "${LIVE}".${liveExists ? ` The previous live database was kept as "${keep}" (drop it only once you are sure).` : ''}`);
  console.log('Start the API (nssm start pos-cafe-api) and check /api/v1/health.');
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^ \*? ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
