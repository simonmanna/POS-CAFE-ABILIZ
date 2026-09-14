/*
 * Cash-flow / POS release preflight. Read-only: it never repairs anything.
 *
 *   node scripts/pos-release-preflight.cjs --organization <id>
 *   node scripts/pos-release-preflight.cjs --code <organization code>
 *   node scripts/pos-release-preflight.cjs --all
 *
 * Exit codes: 0 = no blockers, 2 = blockers found (do not deploy / do not open
 * the tenant for trading), 1 = the preflight itself failed.
 */
const fs = require('node:fs');
const path = require('node:path');

function load(name) {
  try { return require(name); } catch { return require(require.resolve(name, { paths: [path.join(__dirname, '..', 'apps', 'api')] })); }
}
const { Client } = load('pg');
const dotenv = load('dotenv');

const EVIDENCE_TRIGGERS = [
  ['CashMovement', 'cash_movement_append_only'],
  ['CashSession', 'cash_session_frozen_after_close'],
  ['PosReportSnapshot', 'pos_report_snapshot_write_once'],
  ['TenderSettlement', 'tender_settlement_write_once'],
  ['JournalEntry', 'journal_entry_immutable_after_post'],
  ['JournalLine', 'journal_line_immutable_after_post'],
  ['Payment', 'payment_immutable_core'],
  ['PaymentAllocation', 'payment_allocation_evidence'],
  ['PosRefund', 'pos_refund_evidence'],
  ['InventoryLedger', 'inventory_ledger_append_only'],
];

async function checkDatabase(db) {
  const blockers = [];
  const warnings = [];
  const role = (await db.query('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
  if (role?.rolsuper || role?.rolbypassrls) warnings.push({ check: 'database_role', detail: `${role.rolname} bypasses RLS; tenant isolation relies on the application tenancy layer` });
  const forced = (await db.query(`SELECT c.relname FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relforcerowsecurity`)).rows;
  if (forced.length) blockers.push({ check: 'rls_force_on_app_owned_tables', detail: 'FORCE RLS breaks non-transactional app reads/writes for the owner role and makes pg_dump refuse to back the table up', tables: forced.map((r) => r.relname) });
  const triggers = new Set((await db.query(`SELECT event_object_table || '.' || trigger_name AS t FROM information_schema.triggers`)).rows.map((r) => r.t));
  const missing = EVIDENCE_TRIGGERS.filter(([table, name]) => !triggers.has(`${table}.${name}`)).map(([table, name]) => `${table}.${name}`);
  if (missing.length) blockers.push({ check: 'evidence_immutability_triggers', detail: 'Financial evidence is not append-only; run prisma migrate deploy', missing });
  // Backup capacity: pg_dump locks every relation in one transaction; if the
  // lock table cannot hold them the nightly backup fails.
  const capacity = (await db.query(`SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','S','i','p','v','m'))::int AS relations,
      current_setting('max_locks_per_transaction')::int * (current_setting('max_connections')::int + current_setting('max_prepared_transactions')::int) AS lock_slots`)).rows[0];
  if (capacity.relations > capacity.lock_slots * 0.8) {
    blockers.push({ check: 'backup_lock_capacity', detail: `pg_dump needs ~${capacity.relations} relation locks but the lock table holds ${capacity.lock_slots}; raise max_locks_per_transaction (see docker-compose.yml) or backups fail`, ...capacity });
  } else if (capacity.relations > capacity.lock_slots * 0.5) {
    warnings.push({ check: 'backup_lock_capacity', detail: 'Over half of the lock table is needed by pg_dump', ...capacity });
  }
  const ledgerCheck = (await db.query(`SELECT 1 FROM pg_constraint WHERE conname = 'InventoryLedger_balance_arithmetic_check'`)).rows;
  if (!ledgerCheck.length) blockers.push({ check: 'inventory_ledger_arithmetic_constraint', detail: 'Stock ledger rows are not arithmetic-checked; run prisma migrate deploy' });
  const pending = (await db.query(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`)).rows;
  if (pending.length) blockers.push({ check: 'unfinished_migrations', migrations: pending.map((r) => r.migration_name) });
  return { role, blockers, warnings };
}

async function checkOrganization(db, organizationId) {
  const blockers = [];
  const warnings = [];
  const q = async (sql) => (await db.query(sql, [organizationId])).rows;
  const add = (list, check, rows, detail) => { if (rows.length) list.push({ check, count: rows.length, detail, sample: rows.slice(0, 20) }); };

  const org = (await q('SELECT id, name, "currencyCode" FROM "Organization" WHERE id = $1'))[0];
  if (!org) throw new Error(`Organization ${organizationId} not found`);

  add(blockers, 'unbalanced_journal_entries', await q(`
    SELECT e.id, e."entryNumber", SUM(l."baseDebit") AS debit, SUM(l."baseCredit") AS credit
    FROM "JournalEntry" e JOIN "JournalLine" l ON l."journalEntryId" = e.id
    WHERE e."organizationId" = $1 AND e.status IN ('posted','reversed')
    GROUP BY e.id, e."entryNumber" HAVING SUM(l."baseDebit") <> SUM(l."baseCredit")`), 'Posted journals must balance');

  add(blockers, 'negative_payment_account_balances', await q(`
    SELECT a.id, a.code, a.name, SUM(l."baseDebit" - l."baseCredit") AS balance
    FROM "Account" a JOIN "AccountCategory" c ON c.id = a."categoryId"
    JOIN "JournalLine" l ON l."accountId" = a.id JOIN "JournalEntry" e ON e.id = l."journalEntryId" AND e.status IN ('posted','reversed')
    WHERE a."organizationId" = $1 AND c."isCashEquivalent"
    GROUP BY a.id, a.code, a.name HAVING SUM(l."baseDebit" - l."baseCredit") < 0`), 'Cash, bank and wallet balances can never be negative');

  add(blockers, 'invalid_payments', await q(`SELECT id, "paymentNumber", amount FROM "Payment" WHERE "organizationId" = $1 AND (amount <= 0 OR "withholdingAmount" < 0 OR "withholdingAmount" >= amount)`), 'Payment amounts must be positive and exceed withholding');

  add(blockers, 'posted_payments_without_journal', await q(`SELECT id, "paymentNumber" FROM "Payment" WHERE "organizationId" = $1 AND status = 'posted' AND "journalEntryId" IS NULL`), 'Every posted payment needs its journal');

  add(blockers, 'cash_payments_missing_drawer_movement', await q(`
    SELECT p.id, p."paymentNumber", p."cashSessionId" FROM "Payment" p
    WHERE p."organizationId" = $1 AND p."paymentMethod" = 'cash' AND p."cashSessionId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "CashMovement" m WHERE m."paymentId" = p.id)`), 'A cash payment taken on a shift must move the drawer');

  add(warnings, 'legacy_cash_payments_without_shift', await q(`
    SELECT p.id, p."paymentNumber", p."paymentDate" FROM "Payment" p
    WHERE p."organizationId" = $1 AND p."paymentMethod" = 'cash' AND p."cashSessionId" IS NULL AND p.direction = 'inbound' AND p.status = 'posted'`), 'Historical cash receipts outside any shift (not in any Z report)');

  add(blockers, 'registers_sharing_drawer_accounts', await q(`SELECT "defaultAccountId", COUNT(*) AS registers FROM "CashRegister" WHERE "organizationId" = $1 AND "isActive" AND "deletedAt" IS NULL GROUP BY "defaultAccountId" HAVING COUNT(*) > 1`), 'Each register needs its own drawer account');

  add(blockers, 'stale_open_sessions', await q(`SELECT id, "cashRegisterId", "userId", "openedAt" FROM "CashSession" WHERE "organizationId" = $1 AND status = 'open' AND "openedAt" < now() - interval '24 hours'`), 'Shifts open more than 24h must be closed or force-closed');

  add(warnings, 'closed_sessions_pending_variance_review', await q(`SELECT id, "closingDifference", "varianceStatus", "closedAt" FROM "CashSession" WHERE "organizationId" = $1 AND status = 'closed' AND COALESCE("closingDifference", 0) <> 0 AND COALESCE("varianceStatus", '') <> 'approved'`), 'Variance awaiting manager review');

  add(warnings, 'unreconciled_closed_sessions', await q(`SELECT id, "closedAt" FROM "CashSession" WHERE "organizationId" = $1 AND status = 'closed' AND "closedAt" < now() - interval '3 days' AND "closedAt" >= now() - interval '7 days'`), 'Closed 3-7 days ago and not reconciled');

  add(blockers, 'stale_unreconciled_sessions', await q(`SELECT id, "closedAt", "closingDifference" FROM "CashSession" WHERE "organizationId" = $1 AND status = 'closed' AND "closedAt" < now() - interval '7 days'`), 'Closed shifts older than 7 days must be reviewed and reconciled');

  add(blockers, 'invalid_register_bindings', await q(`
    SELECT r.id, r.code, a.code AS "drawerAccount", c.key AS category, a."isActive", a."deletedAt"
    FROM "CashRegister" r LEFT JOIN "Account" a ON a.id = r."defaultAccountId" LEFT JOIN "AccountCategory" c ON c.id = a."categoryId"
    WHERE r."organizationId" = $1 AND r."isActive" AND r."deletedAt" IS NULL
      AND (a.id IS NULL OR a."organizationId" <> r."organizationId" OR NOT a."isActive" OR a."deletedAt" IS NOT NULL OR c.key NOT IN ('cash', 'petty_cash'))`), 'Every active register needs its own active cash drawer account');

  add(blockers, 'drawer_movements_mismatching_payment', await q(`
    SELECT m.id, m."movementType", p."paymentNumber", p."paymentMethod"
    FROM "CashMovement" m JOIN "Payment" p ON p.id = m."paymentId"
    WHERE m."organizationId" = $1 AND (p."organizationId" <> m."organizationId" OR p."paymentMethod" <> 'cash' OR p."cashSessionId" IS DISTINCT FROM m."cashSessionId")`), 'A drawer movement is attached to a payment of another tender, shift or organization');

  add(blockers, 'inconsistent_closed_session_totals', await q(`
    SELECT s.id, s."closingCounted", s."closingExpected", s."closingDifference"
    FROM "CashSession" s WHERE s."organizationId" = $1 AND s.status <> 'open'
      AND (s."closingCounted" IS NULL OR s."closingExpected" IS NULL OR s."closingDifference" IS DISTINCT FROM (s."closingCounted" - s."closingExpected"))`), 'A closed shift must carry a consistent count, expectation and variance');

  add(blockers, 'sessions_without_drawer_snapshot', await q(`SELECT id, status FROM "CashSession" WHERE "organizationId" = $1 AND status = 'open' AND "drawerAccountId" IS NULL`), 'Open shifts must carry their drawer account snapshot');

  add(blockers, 'failed_stock_postings', await q(`SELECT id, "invoiceNumber", "lastError" FROM "StockPostingJob" WHERE "organizationId" = $1 AND status = 'failed'`), 'Stock/COGS never posted; fix configuration and retry from the Posting Monitor');

  add(warnings, 'queued_stock_postings', await q(`SELECT id, "invoiceNumber", status, attempts FROM "StockPostingJob" WHERE "organizationId" = $1 AND status IN ('pending','processing') AND "createdAt" < now() - interval '15 minutes'`), 'Stock posting queue is behind');

  add(warnings, 'open_inventory_exceptions', await q(`SELECT id, kind, "invoiceNumber", reason FROM "InventoryException" WHERE "organizationId" = $1 AND status = 'open'`), 'Stock drift awaiting a decision');

  add(blockers, 'unresolved_money_operations', await q(`SELECT id, key, path, status, "createdAt" FROM "IdempotencyRecord" WHERE "organizationId" = $1 AND status IN ('pending','indeterminate') AND "createdAt" < now() - interval '10 minutes' AND "responseJson" <> '{}'::jsonb`), 'Money operations with a saved outcome but no completion; recover them before trading');

  add(warnings, 'abandoned_operation_keys', await q(`SELECT id, key, path, "createdAt" FROM "IdempotencyRecord" WHERE "organizationId" = $1 AND status IN ('pending','indeterminate') AND "responseJson" = '{}'::jsonb`), 'Attempts that committed nothing; released automatically on retry');

  add(blockers, 'expense_payments_without_journal', await q(`SELECT id, "expenseId", amount FROM "ExpensePayment" WHERE "organizationId" = $1 AND status = 'posted' AND "journalEntryId" IS NULL`), 'Expense money left the books with no journal');

  add(blockers, 'open_offline_dead_letters', await q(`SELECT id, "createdAt" FROM "SyncOpDeadLetter" WHERE "organizationId" = $1 AND status = 'open'`), 'Unsynced device operations');

  add(warnings, 'suspense_balance', await q(`
    SELECT a.code, a.name, SUM(l."baseDebit" - l."baseCredit") AS balance
    FROM "AccountMapping" m JOIN "Account" a ON a.id = m."accountId"
    JOIN "JournalLine" l ON l."accountId" = a.id JOIN "JournalEntry" e ON e.id = l."journalEntryId" AND e.status IN ('posted','reversed')
    WHERE m."organizationId" = $1 AND m.key IN ('cash_suspense','cash_clearing')
    GROUP BY a.code, a.name HAVING SUM(l."baseDebit" - l."baseCredit") <> 0`), 'Clearing/suspense accounts should be cleared');

  const mappings = await q(`SELECT key FROM "AccountMapping" WHERE "organizationId" = $1`);
  const have = new Set(mappings.map((r) => r.key));
  const requiredMappings = ['default_cash', 'cash_short_over', 'default_bank'].filter((k) => !have.has(k));
  if (requiredMappings.length) blockers.push({ check: 'missing_account_mappings', detail: 'Required for shift close, variance and banking', missing: requiredMappings });

  add(warnings, 'legacy_invoices_without_receivable_account', await q(`SELECT id, "invoiceNumber" FROM "Invoice" i WHERE "organizationId" = $1 AND status NOT IN ('cancelled','refunded') AND "receivableAccountId" IS NULL LIMIT 100`), 'Collections/refunds on these invoices are refused until reviewed');

  const warehouses = await q(`SELECT COUNT(*)::int AS n FROM "InventoryLocation" WHERE "organizationId" = $1 AND type = 'warehouse' AND "isActive" AND "deletedAt" IS NULL`);
  const posLocation = await q(`SELECT 1 FROM "Setting" WHERE "organizationId" = $1 AND key = 'pos.stockLocationId'`);
  const unlocatedRegisters = await q(`SELECT id, code FROM "CashRegister" WHERE "organizationId" = $1 AND "isActive" AND "deletedAt" IS NULL AND "locationId" IS NULL`);
  if (warehouses[0].n > 1 && !posLocation.length && unlocatedRegisters.length) {
    blockers.push({ check: 'ambiguous_pos_stock_location', detail: 'More than one warehouse and no POS stock location: sales will not relieve stock', registers: unlocatedRegisters });
  }

  // ── Inventory integrity ─────────────────────────────────────────────────────
  add(blockers, 'inventory_stock_ledger_drift', await q(`
    SELECT s."productId", s."locationId", s."variantKey", s.quantity, COALESCE(l.total, 0) AS ledger
    FROM "StockItem" s
    LEFT JOIN (SELECT "productId", "locationId", COALESCE("variantId", '') AS vk, SUM("quantityChange") AS total
               FROM "InventoryLedger" WHERE "organizationId" = $1 GROUP BY 1, 2, 3) l
      ON l."productId" = s."productId" AND l."locationId" = s."locationId" AND l.vk = s."variantKey"
    WHERE s."organizationId" = $1 AND abs(s.quantity - COALESCE(l.total, 0)) > 0.000001`), 'On-hand must equal the sum of its stock ledger; run a count or the opening-ledger backfill');

  add(blockers, 'inventory_batch_drift', await q(`
    SELECT s."productId", s."locationId", s.quantity, COALESCE(b.total, 0) AS batches
    FROM "StockItem" s JOIN "Product" p ON p.id = s."productId" AND p."batchTracking"
    LEFT JOIN (SELECT "productId", "locationId", COALESCE("variantId", '') AS vk, SUM(quantity) AS total
               FROM "InventoryBatch" WHERE "organizationId" = $1 GROUP BY 1, 2, 3) b
      ON b."productId" = s."productId" AND b."locationId" = s."locationId" AND b.vk = s."variantKey"
    WHERE s."organizationId" = $1 AND s.quantity >= 0 AND abs(s.quantity - COALESCE(b.total, 0)) > 0.000001`), 'Batch-tracked on-hand must equal the sum of its lots');

  add(warnings, 'inventory_serial_drift', await q(`
    SELECT s."productId", s."locationId", s.quantity, COUNT(sr.id) AS in_stock_serials
    FROM "StockItem" s JOIN "Product" p ON p.id = s."productId" AND p."serialTracking"
    LEFT JOIN "InventorySerial" sr ON sr."productId" = s."productId" AND sr."locationId" = s."locationId" AND sr.status = 'in_stock'
    WHERE s."organizationId" = $1
    GROUP BY s."productId", s."locationId", s.quantity HAVING s.quantity <> COUNT(sr.id)`), 'Serial-tracked on-hand differs from in-stock serials (expected while inventory.serialPolicy = capture_optional)');

  add(blockers, 'inventory_valued_movements_without_journal', await q(`
    SELECT l."referenceType", l.type, COUNT(*) AS rows, SUM(l."totalValue") AS value
    FROM "InventoryLedger" l
    WHERE l."organizationId" = $1 AND l."totalValue" > 0
      AND l.type::text NOT IN ('transfer_in', 'transfer_out', 'opening_balance')
      AND COALESCE(l."referenceType", '') NOT IN ('opening_balance', 'opening_backfill')
      AND NOT EXISTS (
        SELECT 1 FROM "JournalEntry" e
        WHERE e."organizationId" = l."organizationId" AND e.status <> 'draft'
          AND (e."sourceId" = l."referenceId" OR e."sourceId" = l."ledgerCode"
               OR (e."sourceType" = 'inventory_gl_gap_backfill' AND e."sourceId" = COALESCE(l."referenceType", '(none)') AND l."createdAt" <= e."createdAt")))
    GROUP BY l."referenceType", l.type`), 'Stock value moved with no journal entry; run pnpm --filter @erp/api backfill:inventory-gl-gaps');

  const tolerance = Number(process.env.INVENTORY_GL_TOLERANCE ?? 1);
  const tie = (await q(`
    SELECT
      (SELECT COALESCE(SUM(s.quantity * CASE WHEN s."runningAverageCost" > 0 THEN s."runningAverageCost" ELSE COALESCE(p."costPrice", 0) END), 0)
         FROM "StockItem" s JOIN "Product" p ON p.id = s."productId" WHERE s."organizationId" = $1) AS subledger,
      (SELECT COALESCE(SUM(jl."baseDebit" - jl."baseCredit"), 0)
         FROM "JournalLine" jl JOIN "JournalEntry" e ON e.id = jl."journalEntryId" AND e.status <> 'draft'
         WHERE e."organizationId" = $1
           AND jl."accountId" IN (SELECT "accountId" FROM "AccountMapping" WHERE "organizationId" = $1 AND key IN ('stock_valuation', 'inventory'))) AS gl`))[0];
  const inventoryVariance = Number(tie.subledger) - Number(tie.gl);
  if (Math.abs(inventoryVariance) > tolerance) {
    blockers.push({ check: 'inventory_gl_variance', detail: `Inventory sub-ledger ${Number(tie.subledger).toFixed(2)} vs Stock Valuation GL ${Number(tie.gl).toFixed(2)} (tolerance ${tolerance}); explain it in Accounting > Inventory GL Tie-out`, variance: inventoryVariance.toFixed(2) });
  }

  add(warnings, 'inventory_ledger_chain_breaks', await q(`
    SELECT "productId", "locationId", COUNT(*) AS breaks FROM (
      SELECT "productId", "locationId", "qtyBefore",
             lag("balanceAfter") OVER (PARTITION BY "productId", COALESCE("variantId", ''), "locationId" ORDER BY "createdAt", id) AS prev
      FROM "InventoryLedger" WHERE "organizationId" = $1) x
    WHERE prev IS NOT NULL AND prev <> "qtyBefore" GROUP BY "productId", "locationId"`), 'Historic stock-card rows do not chain (usually a mid-stream opening balance); totals are still right');

  add(warnings, 'inventory_negative_stock', await q(`SELECT "productId", "locationId", quantity FROM "StockItem" WHERE "organizationId" = $1 AND quantity < 0`), 'Sold before received; COGS used a stale cost until the covering receipt lands');

  add(warnings, 'inventory_expired_lots_on_hand', await q(`SELECT id, "productId", "batchNumber", quantity, "expiryDate" FROM "InventoryBatch" WHERE "organizationId" = $1 AND quantity > 0 AND "expiryDate" < now()`), 'Expired stock on hand; write it off via Waste');

  add(warnings, 'inventory_tracked_menu_items_without_recipe', await q(`
    SELECT m.id, m.name FROM "MenuItem" m
    WHERE m."organizationId" = $1 AND m."isInventoryTracked"
      AND NOT EXISTS (SELECT 1 FROM "MenuProduct" mp WHERE mp."menuItemId" = m.id)`), 'Every sale of these items raises an inventory exception and posts no COGS');

  add(warnings, 'inventory_documents_pending_over_7_days', await q(`
    SELECT 'stock_out' AS kind, "outCode" AS code, "createdAt" FROM "StockOut" WHERE "organizationId" = $1 AND status IN ('draft','pending') AND "createdAt" < now() - interval '7 days'
    UNION ALL SELECT 'waste', "wasteCode", "createdAt" FROM "WasteRecord" WHERE "organizationId" = $1 AND status IN ('draft','pending') AND "createdAt" < now() - interval '7 days'
    UNION ALL SELECT 'adjustment', "adjCode", "createdAt" FROM "StockAdjustment" WHERE "organizationId" = $1 AND status IN ('draft','pending') AND "createdAt" < now() - interval '7 days'
    UNION ALL SELECT 'transfer', "transferCode", "createdAt" FROM "StockTransfer" WHERE "organizationId" = $1 AND status IN ('draft','pending') AND "createdAt" < now() - interval '7 days'
    UNION ALL SELECT 'goods_receipt', "receiptNumber", "createdAt" FROM "GoodsReceiptNote" WHERE "organizationId" = $1 AND status = 'draft' AND "createdAt" < now() - interval '7 days'`), 'Stock documents awaiting approval/posting');

  const trackedWithoutWarehouse = await q(`
    SELECT COUNT(*)::int AS n FROM "Product" p
    WHERE p."organizationId" = $1 AND p."trackInventory" AND p."isActive" AND p."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "InventoryLocation" l WHERE l."organizationId" = $1 AND l.type = 'warehouse' AND l."isActive" AND l."deletedAt" IS NULL)`);
  if (trackedWithoutWarehouse[0].n > 0) {
    blockers.push({ check: 'inventory_no_active_warehouse', detail: `${trackedWithoutWarehouse[0].n} inventory-tracked product(s) but no active warehouse: every sale fails to relieve stock` });
  }

  return { organization: org, blockers, warnings };
}

async function main() {
  const all = process.argv.includes('--all');
  const idx = process.argv.indexOf('--organization');
  const codeIdx = process.argv.indexOf('--code');
  const organizationId = idx >= 0 ? process.argv[idx + 1] : undefined;
  const organizationCode = codeIdx >= 0 ? process.argv[codeIdx + 1] : undefined;
  if (!all && !/^[\w-]+$/.test(organizationId || '') && !/^[\w-]+$/.test(organizationCode || '')) throw new Error('Usage: node scripts/pos-release-preflight.cjs --organization <id> | --code <organization code> | --all');
  const envPath = path.join(__dirname, '..', 'apps', 'api', '.env');
  const config = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const connectionString = process.env.DATABASE_URL || config.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SELECT set_config('statement_timeout', '60000', true)");
    const database = await checkDatabase(db);
    const ids = all
      ? (await db.query('SELECT id FROM "Organization" ORDER BY "createdAt"')).rows.map((r) => r.id)
      : organizationCode
        ? (await db.query('SELECT id FROM "Organization" WHERE code = $1', [organizationCode])).rows.map((r) => r.id)
        : [organizationId];
    if (!ids.length) throw new Error(`Organization ${organizationCode ?? organizationId} not found`);
    const organizations = [];
    for (const id of ids) {
      await db.query("SELECT set_config('app.org_id', $1, true)", [id]);
      organizations.push(await checkOrganization(db, id));
    }
    await db.query('ROLLBACK');
    const blocked = database.blockers.length > 0 || organizations.some((o) => o.blockers.length > 0);
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      readOnly: true,
      status: blocked ? 'BLOCKED' : 'READY',
      database,
      organizations: organizations.map((o) => ({ ...o, status: o.blockers.length ? 'BLOCKED' : 'READY' })),
      limits: 'Browser-local unsynced work and provider statements must be checked separately.',
    }, null, 2) + '\n');
    process.exitCode = blocked ? 2 : 0;
  } finally {
    await db.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
