/*
 * Build var/simulations/CERTIFICATION.md from the latest simulation evidence,
 * the mutant run and the DR drill. GO only when no P0/P1 scenario failed, all
 * mutants were killed and the restore was identical.
 *
 *   node scripts/certification-report.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'var', 'simulations');
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const wanted = ['M1M2', 'M3', 'M4', 'M5-cafe-pace', '15DAY'];
const runs = fs.readdirSync(dir)
  .map((d) => ({ d, r: read(path.join(dir, d, 'results.json')) }))
  .filter((x) => x.r && wanted.some((w) => x.d.endsWith(`-${w}`)) && !/MUT-/.test(x.d))
  .map((x) => x.r);
const mutants = read(path.join(dir, 'mutants.json'));
const dr = read(path.join(dir, 'dr-drill.json'));

const all = runs.flatMap((r) => r.scenarios.map((s) => ({ ...s, run: r.runId })));
const count = (p, st) => all.filter((s) => s.priority === p && s.status === st).length;
const rules = all.flatMap((s) => s.rules);
const openP0 = all.filter((s) => s.priority === 'P0' && s.status === 'FAIL');
const openP1 = all.filter((s) => s.priority === 'P1' && s.status === 'FAIL');
const mutantsOk = mutants && mutants.results.every((m) => m.status === 'KILLED');
const drOk = dr && dr.verdict === 'RESTORE_IDENTICAL';
const verdict = openP0.length || !mutantsOk || !drOk ? 'NO-GO' : openP1.length ? 'CONDITIONAL' : 'GO';
const area = (prefixes) => {
  const hit = rules.filter((r) => prefixes.some((p) => r.rule.startsWith(p)));
  return hit.length ? (hit.every((r) => r.status !== 'FAIL') ? `PASS (${hit.length} checks)` : `FAIL (${hit.filter((r) => r.status === 'FAIL').length}/${hit.length})`) : 'n/a';
};

const md = [
  '# POS PRODUCTION CERTIFICATION — Lakeview Café & Grill (simulated)',
  '',
  `Generated ${new Date().toISOString()} · commit ${runs[0]?.commit?.sha ?? 'unknown'} (+${runs[0]?.commit?.dirtyFiles?.length ?? '?'} uncommitted files) · policy ${runs[0]?.policyVersion ?? '?'}`,
  '',
  '## Scenarios',
  `- P0: ${count('P0', 'PASS')} pass / ${count('P0', 'FAIL')} fail`,
  `- P1: ${count('P1', 'PASS')} pass / ${count('P1', 'FAIL')} fail`,
  `- P2: ${count('P2', 'PASS')} pass / ${count('P2', 'FAIL')} fail`,
  `- Reconciliation checks: ${rules.filter((r) => r.status === 'PASS').length} pass / ${rules.filter((r) => r.status === 'FAIL').length} fail`,
  '',
  '## Areas',
  `| Area | Result |`, `|---|---|`,
  `| Sales & VAT | ${area(['SALES', 'TAX', 'ORACLE'])} |`,
  `| Cash / tills | ${area(['CASH', 'CP-DAY drawer', 'CP-DAY safe'])} |`,
  `| Treasury / clearing | ${area(['TEND', 'CP-DAY MTN', 'CP-DAY card', 'CP-DAY bank', 'CP-DAY processor'])} |`,
  `| Inventory | ${area(['INV', 'WASTE', 'COUNT', 'XFER', 'RECIPE', 'LANDED', 'PROC', 'CP-DAY BEANS', 'CP-DAY MILK', 'CP-DAY CUP', 'CP-DAY LID', 'CP-DAY BUN', 'CP-DAY CHICKEN', 'CP-DAY WATER', 'CP-DAY BEER'])} |`,
  `| Accounting | ${area(['GL', 'PERIOD', 'CP-DAY revenue', 'CP-DAY output', 'CP-DAY TB', 'CP-DAY duplicate', 'CP-DAY invoices', 'CERT'])} |`,
  `| Restaurant (tables/KOT/split) | ${area(['KOT', 'TABLE', 'SPLIT'])} |`,
  `| Security / RBAC / tenancy | ${area(['AUTH', 'TENANCY', 'LOG', 'AUDIT'])} |`,
  `| Idempotency / concurrency | ${area(['INT', 'D10'])} |`,
  `| Crash / fault recovery | ${area(['FAULT', 'D13'])} |`,
  `| Load | ${area(['LOAD', 'VOLUME'])} |`,
  `| Reports | ${area(['RPT', 'RECON'])} |`,
  `| Shadow pilot (simulated) | ${area(['SHADOW'])} |`,
  `| Mutation proof | ${mutants ? `${mutants.results.filter((m) => m.status === 'KILLED').length}/${mutants.results.length} killed` : 'not run'} |`,
  `| Backup / restore | ${dr ? `${dr.verdict} (backup ${dr.backupSeconds}s, restore ${dr.restoreSeconds}s)` : 'not run'} |`,
  '',
  '## Runs',
  ...runs.map((r) => `- ${r.runId}: ${r.verdict} — ${r.scenarios.filter((s) => s.status === 'PASS').length}/${r.scenarios.length} scenarios`),
  '',
  '## Open P0', ...(openP0.length ? openP0.map((s) => `- ${s.run} ${s.id} ${s.title}`) : ['- none']),
  '', '## Open P1', ...(openP1.length ? openP1.map((s) => `- ${s.run} ${s.id} ${s.title}`) : ['- none']),
  '',
  `## FINAL VERDICT (simulation scope): **${verdict}**`,
  '',
  'Scope note: a simulated certification. Live GO additionally requires the real shadow pilot, accountant sign-off of policy.ts, and a 24–72 h soak on production hardware.',
];
fs.writeFileSync(path.join(dir, 'CERTIFICATION.md'), md.join('\n'));
console.log(md.join('\n'));
