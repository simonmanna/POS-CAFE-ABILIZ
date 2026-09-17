/*
 * Start the built API against a disposable simulation database (never the dev
 * or production database) for UI smoke tests of the business simulation.
 *
 *   SIM_DATABASE_URL=postgresql://.../pos_stage1_<digits> node scripts/sim-api.cjs
 *
 * Without SIM_DATABASE_URL the dev DATABASE_URL's server is reused with the
 * database name pos_stage1_20260920 (a migrated + seeded simulation copy).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require(require.resolve('dotenv', { paths: [path.join(__dirname, '..', 'apps', 'api')] }));

const api = path.join(__dirname, '..', 'apps', 'api');
const env = dotenv.parse(fs.readFileSync(path.join(api, '.env')));
const fallback = env.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/pos_stage1_20260920$1');
const url = process.env.SIM_DATABASE_URL || fallback;
if (!/\/pos_stage1_\d+(\?|$)/.test(url)) {
  console.error('sim-api refuses to start on a non-simulation database');
  process.exit(1);
}
const child = spawn(process.execPath, ['--max-http-header-size=65536', 'dist/main.js'], {
  cwd: api,
  stdio: 'inherit',
  env: { ...process.env, ...env, DATABASE_URL: url, PORT: process.env.PORT || '3001', NODE_ENV: 'development', RLS_ALLOW_SUPERUSER: 'true' },
});
child.on('exit', (code) => process.exit(code ?? 0));
