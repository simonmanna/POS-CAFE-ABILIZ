/*
 * Mutation proof for the business-simulation oracle.
 *
 * Each mutant injects ONE realistic bug into application code, runs the M1/M2
 * simulation, and must be "killed": the named scenario has to fail. The file is
 * always restored byte-for-byte afterwards (even on error or Ctrl-C).
 *
 *   SIM_DATABASE_URL=postgresql://.../pos_stage1_<digits> node test/business-simulation/run-mutants.cjs
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const url = process.env.SIM_DATABASE_URL;
if (!url || !/\/pos_stage1_\d+(\?|$)/.test(url)) { console.error('Set SIM_DATABASE_URL to a disposable pos_stage1_<digits> database'); process.exit(2); }

const MUTANTS = [
  { id: 'MUT-01', title: 'VAT ignores the currency scale (6dp tax lines)', file: 'src/modules/invoicing/tax/tax-calculation.service.ts',
    from: 'round(base.times(dec(t.rate).dividedBy(100)), scale ?? 6)', to: 'round(base.times(dec(t.rate).dividedBy(100)), 6)', killedBy: ['D1-TAX-001'] },
  { id: 'MUT-02', title: 'Refund with restock never returns stock', file: 'src/modules/pos/billing/refund-operation.ts',
    from: "    if (opts.stockDisposition === 'restock') {", to: "    if (false && opts.stockDisposition === 'restock') {", killedBy: ['D1-I-001'] },
  { id: 'MUT-03', title: 'Cash change reported as zero', file: 'src/modules/pos/billing/pos-invoice.service.ts',
    from: 'change: Math.max(0, tendered - result.tendersSum) };', to: 'change: 0 };', killedBy: ['D1-B-001'] },
  { id: 'MUT-04', title: 'X/Z report forgets refunds in net revenue', file: 'src/modules/accounting/treasury/session-reconciliation.ts',
    from: "netRevenueAfterRefunds: dec(sumInvoices('subtotal')).minus(refundedRevenue).toString()", to: "netRevenueAfterRefunds: dec(sumInvoices('subtotal')).toString()", killedBy: ['D1-R-001'] },
  { id: 'MUT-05', title: 'Cancelled kitchen food is not written off', file: 'src/modules/pos/order/pos-orders.service.ts',
    from: '    if (wasted.length) {', to: '    if (false && wasted.length) {', killedBy: ['D1-I-002'] },
];

const results = [];
for (const m of MUTANTS) {
  const file = path.join(API, m.file);
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');
  if (!text.includes(m.from)) { results.push({ ...m, status: 'NOT_APPLIED', detail: 'mutation point not found' }); continue; }
  const restore = () => fs.writeFileSync(file, original);
  process.once('SIGINT', () => { restore(); process.exit(130); });
  try {
    fs.writeFileSync(file, text.replace(m.from, m.to));
    spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--runInBand', '--forceExit', 'test/business-simulation/lakeview-d0-d1'], {
      cwd: API, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, SIM_RUN: '1', NODE_ENV: 'test', DATABASE_URL: url, SIMULATION_SEED: `${process.env.SIMULATION_SEED ?? '20260917'}-${m.id}` },
    });
    const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'var/simulations', `SIM-${process.env.SIMULATION_SEED ?? '20260917'}-${m.id}-M1M2`, 'results.json'), 'utf8'));
    const failed = report.scenarios.filter((s) => s.status === 'FAIL').map((s) => s.id);
    const killed = m.killedBy.every((id) => failed.includes(id));
    results.push({ id: m.id, title: m.title, file: m.file, expectedRed: m.killedBy, redScenarios: failed, status: killed ? 'KILLED' : 'SURVIVED' });
    console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.title} → red: ${failed.join(', ') || 'none'}`);
  } finally {
    restore();
  }
}
const out = path.join(ROOT, 'var/simulations/mutants.json');
fs.writeFileSync(out, JSON.stringify({ at: new Date(), results }, null, 2));
const survived = results.filter((r) => r.status !== 'KILLED');
console.log(`\n${results.length - survived.length}/${results.length} mutants killed → ${out}`);
process.exitCode = survived.length ? 1 : 0;
