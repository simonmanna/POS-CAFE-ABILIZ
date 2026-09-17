/*
 * Disaster-recovery drill on a disposable simulation database.
 *
 *   node scripts/dr-drill.cjs <source pos_stage1_N> <target pos_stage1_M>
 *
 * pg_dump (custom format) → drop/create target → pg_restore → compare every
 * organization's books and operational counts between source and restore, and
 * run the release preflight on the restored copy. Writes
 * var/simulations/dr-drill.json. Refuses any non-simulation database name.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const envText = fs.readFileSync(path.join(ROOT, 'apps/api/.env'), 'utf8');
const base = /DATABASE_URL="?([^"\n?]+)/.exec(envText)[1].replace(/\/[^/]+$/, '');
const pgBin = (/PG_BIN="?([^"\n]+)/.exec(envText)?.[1] ?? '').replace(/\\\\/g, '\\');
const [source, target] = process.argv.slice(2);
if (![source, target].every((d) => /^pos_stage1_\d+$/.test(d ?? ''))) { console.error('usage: dr-drill.cjs <pos_stage1_N> <pos_stage1_M>'); process.exit(2); }
const bin = (name) => (pgBin ? path.join(pgBin, process.platform === 'win32' ? `${name}.exe` : name) : name);
const u = new URL(`${base}/${source}`);
const pgEnv = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) };
const dumpFile = path.join(ROOT, 'var/simulations', `${source}.dump`);

const SNAPSHOT_SQL = `
  SELECT o.code,
    (SELECT COALESCE(SUM(l."baseDebit"),0)::text FROM "JournalLine" l WHERE l."organizationId" = o.id) AS debit,
    (SELECT COALESCE(SUM(l."baseCredit"),0)::text FROM "JournalLine" l WHERE l."organizationId" = o.id) AS credit,
    (SELECT COUNT(*) FROM "Invoice" i WHERE i."organizationId" = o.id)::int AS invoices,
    (SELECT COALESCE(SUM(i."totalAmount"),0)::text FROM "Invoice" i WHERE i."organizationId" = o.id) AS sales,
    (SELECT COUNT(*) FROM "Payment" p WHERE p."organizationId" = o.id)::int AS payments,
    (SELECT COUNT(*) FROM "InventoryLedger" g WHERE g."organizationId" = o.id)::int AS ledger_rows,
    (SELECT COALESCE(SUM(s.quantity * s."runningAverageCost"),0)::text FROM "StockItem" s WHERE s."organizationId" = o.id) AS stock_value,
    (SELECT COUNT(*) FROM "CashSession" c WHERE c."organizationId" = o.id)::int AS sessions,
    (SELECT COUNT(*) FROM "IdempotencyRecord" r WHERE r."organizationId" = o.id)::int AS idempotency
  FROM "Organization" o ORDER BY o.code`;

async function snapshot(db) {
  const c = new Client({ connectionString: `${base}/${db}` });
  await c.connect();
  try { return (await c.query(SNAPSHOT_SQL)).rows; } finally { await c.end(); }
}

(async () => {
  const report = { source, target, startedAt: new Date() };
  let t = Date.now();
  const dump = spawnSync(bin('pg_dump'), ['-Fc', '-f', dumpFile, source], { env: pgEnv, encoding: 'utf8' });
  if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);
  report.backupSeconds = (Date.now() - t) / 1000;
  report.backupBytes = fs.statSync(dumpFile).size;

  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${target}`);
  await admin.query(`CREATE DATABASE ${target}`);
  await admin.end();

  t = Date.now();
  const restore = spawnSync(bin('pg_restore'), ['--no-owner', '-d', target, dumpFile], { env: pgEnv, encoding: 'utf8' });
  report.restoreSeconds = (Date.now() - t) / 1000;
  report.restoreWarnings = (restore.stderr || '').split('\n').filter(Boolean).slice(0, 5);

  const [before, after] = [await snapshot(source), await snapshot(target)];
  report.organizations = before.length;
  report.mismatches = before.filter((row, i) => JSON.stringify(row) !== JSON.stringify(after[i])).map((row, i) => ({ before: row, after: after[i] }));
  report.lakeview = after.filter((r) => r.code.startsWith('LAKEVIEW'));

  const preflight = spawnSync(process.execPath, ['scripts/pos-release-preflight.cjs', '--all'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: `${base}/${target}` }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    const p = JSON.parse(preflight.stdout);
    report.preflightLakeview = p.organizations.filter((o) => o.organization.code?.startsWith('LAKEVIEW') || /Lakeview/.test(o.organization.name)).map((o) => ({ code: o.organization.code, status: o.status, blockers: o.blockers.map((b) => b.check) }));
  } catch { report.preflightError = (preflight.stderr || preflight.stdout || '').slice(0, 400); }

  report.verdict = report.mismatches.length === 0 ? 'RESTORE_IDENTICAL' : 'RESTORE_DIFFERS';
  report.finishedAt = new Date();
  fs.writeFileSync(path.join(ROOT, 'var/simulations/dr-drill.json'), JSON.stringify(report, null, 2));
  fs.unlinkSync(dumpFile);
  console.log(`${report.verdict}: ${report.organizations} orgs compared, backup ${report.backupSeconds}s (${report.backupBytes} bytes), restore ${report.restoreSeconds}s`);
  for (const l of report.preflightLakeview ?? []) console.log(` preflight ${l.code}: ${l.status} ${l.blockers.join('+')}`);
  process.exitCode = report.mismatches.length ? 1 : 0;
})().catch((e) => { console.error(e.message); process.exit(1); });
