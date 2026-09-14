/*
 * Prove historical stock-ledger rows against the CHECK constraints that were
 * added NOT VALID (20260914001000), then mark them VALIDATED.
 *
 *   pnpm --filter @erp/api validate:ledger-constraints          # dry run: report violations
 *   pnpm --filter @erp/api validate:ledger-constraints --apply  # VALIDATE when there are none
 *
 * Never edits ledger rows (the ledger is append-only). A violating row must be
 * explained and neutralised with a posted correction, not rewritten.
 * Exit codes: 0 = validated / would validate, 2 = violations found, 1 = error.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const dotenv = require('dotenv');

const CHECKS = [
  {
    table: 'InventoryLedger',
    name: 'InventoryLedger_balance_arithmetic_check',
    violations: `SELECT id, "organizationId", "ledgerCode", "qtyBefore", "quantityChange", "balanceAfter"
                   FROM "InventoryLedger" WHERE NOT ("balanceAfter" = "qtyBefore" + "quantityChange")`,
  },
  {
    table: 'InventoryLedger',
    name: 'InventoryLedger_non_negative_value_check',
    violations: `SELECT id, "organizationId", "ledgerCode", "unitCost", "totalValue"
                   FROM "InventoryLedger" WHERE NOT ("totalValue" >= 0 AND "unitCost" >= 0)`,
  },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const envPath = path.join(__dirname, '..', '.env');
  const config = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const connectionString = process.env.DATABASE_URL || config.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString });
  await db.connect();
  const report = [];
  let blocked = false;
  try {
    for (const check of CHECKS) {
      const state = (await db.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', [check.name])).rows[0];
      if (!state) { report.push({ constraint: check.name, status: 'missing — run prisma migrate deploy' }); blocked = true; continue; }
      if (state.convalidated) { report.push({ constraint: check.name, status: 'already validated' }); continue; }
      const rows = (await db.query(`${check.violations} LIMIT 50`)).rows;
      if (rows.length) {
        blocked = true;
        report.push({ constraint: check.name, status: 'violations', sample: rows });
        continue;
      }
      if (apply) {
        await db.query(`ALTER TABLE "${check.table}" VALIDATE CONSTRAINT "${check.name}"`);
        report.push({ constraint: check.name, status: 'validated' });
      } else {
        report.push({ constraint: check.name, status: 'clean — rerun with --apply to validate' });
      }
    }
  } finally {
    await db.end();
  }
  process.stdout.write(JSON.stringify({ apply, report }, null, 2) + '\n');
  process.exitCode = blocked ? 2 : 0;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
