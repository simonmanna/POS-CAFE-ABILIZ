/*
 * Cash-flow / POS release certification gate. Every step must pass; the script
 * prints exactly what ran (suites executed, skipped, failed) and exits non-zero
 * on the first failing gate category.
 *
 *   DATABASE_URL=...                 migrated, seeded database for the general suite
 *   POS_TEST_DATABASE_URL=...        disposable database named pos_stage1_<digits>
 *   SHADOW_DATABASE_URL=...          (optional) enables the schema drift check
 *   PREFLIGHT_SCOPE="--all"          (optional) preflight scope, default --all
 *   SKIP_WEB_BUILD=1                 (optional) skip the web production build
 *
 *   node scripts/release-gate.cjs
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'apps', 'api');
const isWin = process.platform === 'win32';
const results = [];

function envFromDotenv() {
  const file = path.join(API, '.env');
  if (!fs.existsSync(file)) return {};
  try { return require(require.resolve('dotenv', { paths: [API] })).parse(fs.readFileSync(file)); } catch { return {}; }
}
const dotenv = envFromDotenv();
const DATABASE_URL = process.env.DATABASE_URL || dotenv.DATABASE_URL;
const POS_TEST_DATABASE_URL = process.env.POS_TEST_DATABASE_URL;

function run(name, cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, stdio: opts.capture ? 'pipe' : 'inherit', shell: isWin, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const ok = r.status === 0;
  results.push({ gate: name, status: ok ? 'PASS' : 'FAIL', seconds: Math.round((Date.now() - started) / 1000), detail: opts.detail?.(r) ?? '' });
  return r;
}

function jest(name, pattern, databaseUrl, allowedSkips) {
  const out = path.join(os.tmpdir(), `release-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = ['jest', '--ci', '--forceExit', '--json', `--outputFile=${out}`, isWin ? '--maxWorkers=2' : '--maxWorkers=50%'];
  // Quoted: with shell=true on Windows an unquoted `|` would pipe the command.
  if (pattern) args.push(isWin ? `"--testPathPattern=${pattern}"` : `--testPathPattern=${pattern}`);
  const started = Date.now();
  spawnSync('npx', args, { cwd: API, stdio: 'inherit', shell: isWin, env: { ...process.env, DATABASE_URL: databaseUrl, REQUIRE_DB_TESTS: '1', NODE_ENV: 'test', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim() } });
  let report;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {
    results.push({ gate: name, status: 'FAIL', seconds: Math.round((Date.now() - started) / 1000), detail: 'no jest report produced' });
    return;
  }
  const skippedFiles = report.testResults
    .filter((t) => t.assertionResults.length > 0 && t.assertionResults.every((a) => a.status === 'pending'))
    .map((t) => path.relative(API, t.name).replace(/\\/g, '/'));
  const unexpected = skippedFiles.filter((f) => !allowedSkips.some((re) => re.test(f)));
  const ok = report.numFailedTests === 0 && report.numFailedTestSuites === 0 && unexpected.length === 0 && report.numRuntimeErrorTestSuites === 0;
  results.push({
    gate: name,
    status: ok ? 'PASS' : 'FAIL',
    seconds: Math.round((Date.now() - started) / 1000),
    detail: `suites ${report.numPassedTestSuites}/${report.numTotalTestSuites} passed, tests ${report.numPassedTests} passed / ${report.numFailedTests} failed / ${report.numPendingTests} skipped` +
      (skippedFiles.length ? `; skipped files: ${skippedFiles.join(', ')}` : '') +
      (unexpected.length ? `; UNEXPECTED SKIPS: ${unexpected.join(', ')}` : ''),
  });
}

// ── 1. static gates ──────────────────────────────────────────────────────────
run('shared build', 'pnpm', ['shared:build']);
run('api typecheck', 'pnpm', ['--filter', '@erp/api', 'typecheck']);
run('web typecheck', 'pnpm', ['--filter', '@erp/web', 'typecheck']);
run('architecture lint', 'pnpm', ['lint:arch']);
if (process.env.SKIP_WEB_BUILD !== '1') run('web build', 'pnpm', ['--filter', '@erp/web', 'build']);

// ── 2. database + migrations ────────────────────────────────────────────────
if (!DATABASE_URL) {
  results.push({ gate: 'database configured', status: 'FAIL', seconds: 0, detail: 'DATABASE_URL is required' });
} else {
  run('migrate deploy', 'npx', ['prisma', 'migrate', 'deploy'], { cwd: API, env: { DATABASE_URL } });
  if (process.env.SHADOW_DATABASE_URL) {
    run('schema drift', 'npx', ['prisma', 'migrate', 'diff', '--from-migrations', './prisma/migrations', '--to-schema-datamodel', './prisma/schema.prisma', '--shadow-database-url', process.env.SHADOW_DATABASE_URL, '--exit-code'], { cwd: API });
  }
  // The isolated money suites run in step 3; the RLS role-flip spec needs a
  // separately provisioned `app` role and documents the application-tenancy model.
  jest('full jest suite (DB required)', null, DATABASE_URL, [
    /pos-money-foundations|pos-sale-pipeline|pos-store-credit-issuance|pos-cash-flow-go-live|pos-cash-flow-day|pos-cash-flow-adversarial|pos-offline-inventory-replay|pos-shift-close-gates|pos-kot-print-delta/,
    /kernel\/prisma\/rls\.spec\.ts$/,
  ]);
}

// ── 3. isolated money database ──────────────────────────────────────────────
if (!POS_TEST_DATABASE_URL || !/^\/pos_stage1_\d+$/.test(new URL(POS_TEST_DATABASE_URL).pathname)) {
  results.push({ gate: 'isolated money suites', status: 'FAIL', seconds: 0, detail: 'POS_TEST_DATABASE_URL must name a disposable pos_stage1_<digits> database' });
} else {
  run('migrate deploy (isolated)', 'npx', ['prisma', 'migrate', 'deploy'], { cwd: API, env: { DATABASE_URL: POS_TEST_DATABASE_URL } });
  jest('isolated money suites', 'pos-money-foundations|pos-sale-pipeline|pos-store-credit-issuance|pos-cash-flow-go-live|pos-cash-flow-day|pos-cash-flow-adversarial|pos-offline-inventory-replay|pos-shift-close-gates|pos-kot-print-delta', POS_TEST_DATABASE_URL, []);
}

// ── 4. release preflight ────────────────────────────────────────────────────
if (DATABASE_URL) {
  const scope = (process.env.PREFLIGHT_SCOPE ?? '--all').split(' ').filter(Boolean);
  run('release preflight', 'node', ['scripts/pos-release-preflight.cjs', ...scope], {
    env: { DATABASE_URL },
    capture: true,
    detail: (r) => {
      try {
        const report = JSON.parse(r.stdout);
        const blocked = report.organizations.filter((o) => o.status === 'BLOCKED');
        return `exit ${r.status}; ${report.status}; database blockers ${report.database.blockers.length}; blocked organizations ${blocked.length}/${report.organizations.length}` +
          (blocked.length ? ` (${blocked.slice(0, 5).map((o) => `${o.organization.name}: ${o.blockers.map((b) => b.check).join('+')}`).join('; ')})` : '');
      } catch { return `exit ${r.status}; ${(r.stderr || '').trim().slice(0, 200)}`; }
    },
  });
}

// ── summary ─────────────────────────────────────────────────────────────────
const width = Math.max(...results.map((r) => r.gate.length));
console.log('\nRELEASE GATE SUMMARY');
for (const r of results) console.log(`${r.status === 'PASS' ? 'PASS' : 'FAIL'}  ${r.gate.padEnd(width)}  ${String(r.seconds).padStart(4)}s  ${r.detail}`);
const failed = results.filter((r) => r.status !== 'PASS');
console.log(failed.length ? `\nRELEASE BLOCKED: ${failed.length} gate(s) failed` : '\nALL RELEASE GATES PASSED');
process.exitCode = failed.length ? 1 : 0;
