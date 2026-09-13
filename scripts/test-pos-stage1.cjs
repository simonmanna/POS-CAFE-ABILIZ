const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const dotenv = require('dotenv');

// Explicit disposable database only. No reset, role changes or business-DB fallback.
const url = process.env.POS_TEST_DATABASE_URL;
if (!url || !/^\/pos_stage1_\d+$/.test(new URL(url).pathname)) {
  console.error('Set POS_TEST_DATABASE_URL to a migrated disposable database named pos_stage1_<digits>.');
  process.exit(1);
}
const config = fs.existsSync('apps/api/.env') ? dotenv.parse(fs.readFileSync('apps/api/.env')) : {};
const result = spawnSync(process.execPath, [
  'node_modules/jest/bin/jest.js', '--runInBand', '--forceExit',
  '--testPathPattern=src.*[.]spec|pos-money-foundations|pos-sale-pipeline|pos-store-credit-issuance|pos-cash-flow-go-live',
], { cwd: 'apps/api', env: { ...config, ...process.env, DATABASE_URL: url, NODE_ENV: 'test' }, stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
