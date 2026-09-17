/*
 * Business-simulation certification run (M1–M6 + 15-day).
 *
 *   SIM_DATABASE_URL=postgresql://.../pos_stage1_<digits> node scripts/run-simulation.cjs [--quick]
 *
 * Runs every simulation spec against the disposable database (HTTP specs use
 * the built API: `pnpm --filter @erp/api build` first), then aggregates the
 * evidence verdicts from var/simulations/. Exit 0 only when no P0/P1 scenario
 * failed. --quick runs the in-process specs only (no API process).
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'apps', 'api');
const url = process.env.SIM_DATABASE_URL;
if (!url || !/\/pos_stage1_\d+(\?|$)/.test(url)) { console.error('Set SIM_DATABASE_URL to a disposable pos_stage1_<digits> database'); process.exit(2); }
const quick = process.argv.includes('--quick');
const specs = ['lakeview-d0-d1', 'lakeview-m3', ...(quick ? [] : ['lakeview-m4-http', 'lakeview-m5-load']), 'lakeview-15day'];

spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: API, env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit', shell: process.platform === 'win32' });
const started = Date.now();
for (const spec of specs) {
  if (!fs.existsSync(path.join(API, 'test/business-simulation', `${spec}.sim.spec.ts`))) continue;
  console.log(`\n▶ ${spec}`);
  spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--runInBand', '--forceExit', `test/business-simulation/${spec}`], {
    cwd: API, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, SIM_RUN: '1', NODE_ENV: 'test', DATABASE_URL: url, SIM_PROFILE: process.env.SIM_PROFILE ?? 'cafe-pace', SIM_WORKERS: process.env.SIM_WORKERS ?? '4', SIM_THINK_MS: process.env.SIM_THINK_MS ?? '2000', SIM_OPS: process.env.SIM_OPS ?? '200' },
  });
}

const dir = path.join(ROOT, 'var/simulations');
const runs = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'results.json')))
  .map((d) => JSON.parse(fs.readFileSync(path.join(dir, d, 'results.json'), 'utf8')))
  .filter((r) => new Date(r.finishedAt).getTime() >= started);
const failed = runs.flatMap((r) => r.scenarios.filter((s) => s.status === 'FAIL' && s.priority !== 'P2').map((s) => `${r.runId} ${s.id} (${s.priority}) ${s.title}`));
console.log('\nSIMULATION CERTIFICATION');
for (const r of runs) console.log(`${r.verdict.padEnd(12)} ${r.runId}  ${r.scenarios.filter((s) => s.status === 'PASS').length}/${r.scenarios.length} scenarios`);
if (failed.length) console.log(`\nBLOCKING FAILURES:\n${failed.join('\n')}`);
process.exitCode = failed.length || !runs.length ? 1 : 0;
