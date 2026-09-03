/* Read-only Stage 1 deployment inventory. Never repairs historical postings. */
const fs = require('node:fs');
const { Client } = require('pg');
const dotenv = require('dotenv');

async function main() {
  const organizationId = process.argv[process.argv.indexOf('--organization') + 1];
  if (!process.argv.includes('--organization') || !/^[\w-]+$/.test(organizationId || '')) throw new Error('Usage: node scripts/pos-release-preflight.cjs --organization <organization-id>');
  const config = fs.existsSync('apps/api/.env') ? dotenv.parse(fs.readFileSync('apps/api/.env')) : {};
  const connectionString = process.env.DATABASE_URL || config.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SELECT set_config('app.org_id', $1, true), set_config('statement_timeout', '30000', true)", [organizationId]);
    const query = async (sql) => (await db.query(sql, [organizationId])).rows;
    const organization = await query('SELECT id, name, "currencyCode" FROM "Organization" WHERE id = $1');
    if (!organization.length) throw new Error('Organization is missing or unavailable to this database role');
    const role = (await db.query('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    const legacy = await query(`SELECT id, "invoiceNumber", "paymentMode", "settlementStatus", "journalEntryId"
      FROM "Invoice" i WHERE "organizationId" = $1 AND status NOT IN ('cancelled','refunded')
      AND (to_jsonb(i)->>'receivableAccountId') IS NULL ORDER BY "createdAt" LIMIT 100`);
    const invalidPayments = await query(`SELECT id, "paymentNumber", amount FROM "Payment" WHERE "organizationId" = $1 AND amount < 0`);
    const ambiguousDrawers = await query(`SELECT "paymentId", COUNT(DISTINCT "cashSessionId") AS drawers FROM "CashMovement"
      WHERE "organizationId" = $1 AND "paymentId" IS NOT NULL GROUP BY "paymentId" HAVING COUNT(DISTINCT "cashSessionId") > 1`);
    const sharedDrawers = await query(`SELECT "defaultAccountId", COUNT(*) AS registers FROM "CashRegister" WHERE "organizationId" = $1 AND "isActive" = true AND "deletedAt" IS NULL GROUP BY "defaultAccountId" HAVING COUNT(*) > 1`);
    const sessions = await query(`SELECT id, "cashRegisterId", "userId", status, "closingDifference", "varianceStatus" FROM "CashSession" WHERE "organizationId" = $1 AND status <> 'reconciled' ORDER BY "openedAt"`);
    const operations = await query(`SELECT id, key, path, status, "createdAt" FROM "IdempotencyRecord" WHERE "organizationId" = $1 AND status IN ('pending','indeterminate') ORDER BY "createdAt"`);
    const pendingStock = await query(`SELECT id, "invoiceId", status FROM "StockPostingJob" WHERE "organizationId" = $1 AND status <> 'done' LIMIT 100`);
    const mappings = await query(`SELECT m.key, a.id, a.code, a.name, c.key AS category, a."isActive" FROM "AccountMapping" m JOIN "Account" a ON a.id = m."accountId" JOIN "AccountCategory" c ON c.id = a."categoryId" WHERE m."organizationId" = $1 ORDER BY m.key`);
    const tables = (await db.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('Payment','Invoice','CashSession','PosRefund','PosApprovalGrant','TenderSettlement') AND relkind = 'r'`)).rows;
    const migrated = tables.some(t => t.relname === 'PosRefund');
    await db.query('ROLLBACK');
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(), readOnly: true, organization: organization[0], migrated,
      status: 'REQUIRES_RELEASE_REVIEW',
      instructions: 'Review original journals, allocations and drawer movements before restoring legacy collection/refund access. This report does not change any account or approve deployment.',
      databaseRole: role, tableIsolation: tables, legacyInvoicesNeedingOriginalAccountReview: legacy,
      invalidPayments, paymentsSpanningDrawers: ambiguousDrawers, registersSharingCashAccounts: sharedDrawers,
      unreconciledSessions: sessions, unresolvedOperations: operations, pendingStockPostings: pendingStock, accountMappings: mappings,
      limits: 'Legacy invoice and pending-stock samples are limited to 100. Browser-local unsynced work and provider statements must be checked separately.',
    }, null, 2) + '\n');
  } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
