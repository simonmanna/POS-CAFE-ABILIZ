#!/usr/bin/env node
/**
 * LEGACY PREFLIGHT - the data conditions that make a migration abort, run
 * read-only against a v1.5.0-era cafe database (or its clone).
 *
 * Why this exists: `scripts/pos-release-preflight.cjs` is a POST-migration
 * readiness gate. It queries tables a v1.5.0 database does not have
 * (SyncOpDeadLetter, StockPostingJob), so it cannot be pointed at the legacy
 * side. These checks are the pre-migration half: each one corresponds to a
 * migration statement that would fail, or to a value a migration would
 * overwrite, and says which migration owns it.
 *
 * Stages, because not every column exists at every point in the bridge:
 *   pre     - before any bridge SQL (legacy schema)
 *   post-a  - after bridge-10-additive.sql
 *   post-b  - after bridge-20-backfill.ts
 *
 * Severity:
 *   blocker - `prisma migrate deploy` will fail (or data would be lost); fix the
 *             data in the OLD system, or via a reviewed remediation script,
 *             before continuing
 *   report  - a documented transformation or an owner decision; recorded, not
 *             fixed by this kit
 *
 * Exit codes: 0 = no blockers, 2 = blockers, 1 = the preflight itself failed.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' pnpm tsx deployment/2026-09-r2/01-legacy-preflight.ts --stage pre
 *   ... --stage all --json out.json
 */
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { config } = require('dotenv');
  config();
  config({ path: 'apps/api/.env' });
} catch {
  /* optional */
}

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
const STAGE = (flag('--stage') ?? 'all') as 'pre' | 'post-a' | 'post-b' | 'all';
const JSON_OUT = flag('--json');
const DB_URL = process.env.DATABASE_URL ?? '';
if (!DB_URL) { console.error('DATABASE_URL not set.'); process.exit(1); }

type Stage = 'pre' | 'post-a' | 'post-b';
interface Check {
  id: string;
  stage: Stage;
  severity: 'blocker' | 'report';
  owner: string;          // the migration or bridge step that cares
  title: string;
  sql: string;
  /** Rows returned means trouble (default). For `report` checks rows are just listed. */
  emptyIsGood?: boolean;
}

const CHECKS: Check[] = [
  {
    id: 'L01', stage: 'post-b', severity: 'blocker', owner: '20260907120000_one_open_tab_per_table',
    title: 'more than one open dine-in tab per table (migration RAISEs)',
    sql: `select "organizationId", "tableId", count(*) as tabs
            from "Order"
           where "orderType"::text = 'dine_in' and "tableId" is not null and "invoiceId" is null
             and status::text in ('draft','open','preparing','ready','served','confirmed','in_progress','completed')
           group by 1,2 having count(*) > 1`,
  },
  {
    id: 'L02', stage: 'pre', severity: 'blocker', owner: '20260913000000 CashSession_one_open_per_register_key',
    title: 'more than one OPEN shift per register',
    sql: `select "organizationId", "cashRegisterId", count(*) as open_sessions
            from "CashSession" where status::text = 'open' group by 1,2 having count(*) > 1`,
  },
  {
    id: 'L03', stage: 'pre', severity: 'blocker', owner: '20260913000000 CashMovement_paymentId_key',
    title: 'a payment with more than one drawer movement',
    sql: `select "paymentId", count(*) as movements
            from "CashMovement" where "paymentId" is not null group by 1 having count(*) > 1`,
  },
  {
    id: 'L04', stage: 'pre', severity: 'blocker', owner: '20260913000000 / 20260914000100 CashMovement_amount_direction_check',
    title: 'cash movement amount does not match its type',
    sql: `select "movementType"::text as movement_type, count(*) as rows, min(amount) as min_amount, max(amount) as max_amount
            from "CashMovement"
           where not ((("movementType"::text in ('sale','refund','supplier_payment','pay_in','pay_out')) and amount > 0)
                   or ("movementType"::text = 'adjustment' and amount <> 0))
           group by 1`,
  },
  {
    id: 'L05', stage: 'pre', severity: 'blocker', owner: '20260913000000 / 20260914000100 CashMovement_payment_link_check',
    title: 'cash movement payment link does not match its type',
    sql: `select "movementType"::text as movement_type, count(*) as rows
            from "CashMovement"
           where not ((("movementType"::text in ('sale','refund','supplier_payment')) and "paymentId" is not null)
                   or (("movementType"::text in ('pay_in','pay_out','adjustment')) and "paymentId" is null))
           group by 1`,
  },
  {
    id: 'L06', stage: 'pre', severity: 'blocker', owner: '20260913100000 CashMovement_cashSessionId_fkey',
    title: 'drawer movement pointing at a missing shift',
    sql: `select m.id, m."cashSessionId"
            from "CashMovement" m left join "CashSession" s on s.id = m."cashSessionId"
           where s.id is null`,
  },
  {
    id: 'L07', stage: 'pre', severity: 'blocker', owner: '20260903000000 Payment_refund_bounds / PaymentAllocation_refund_bounds',
    title: 'negative payment or allocation amounts (CHECK would fail)',
    // HAVING binds to the last branch of a UNION only, so the totals are
    // filtered outside the union instead.
    sql: `select * from (
            select 'Payment' as source, count(*) as rows from "Payment" where amount < 0
             union all
            select 'PaymentAllocation', count(*) from "PaymentAllocation" where amount < 0
          ) s where rows > 0`,
  },
  {
    id: 'L08', stage: 'pre', severity: 'blocker', owner: 'bridge-10 Setting_organizationId_scopeType_scopeId_key_key',
    title: 'duplicate Setting key within an organization',
    sql: `select "organizationId", key, count(*) as rows from "Setting" group by 1,2 having count(*) > 1`,
  },
  {
    id: 'L09', stage: 'pre', severity: 'blocker', owner: 'bridge-10 InventoryCountSession_draft_location_count_type_key',
    title: 'more than one DRAFT stock count per (location, type)',
    sql: `select "organizationId", "locationId", "countType"::text as count_type, count(*) as rows
            from "InventoryCountSession" where status::text = 'draft' group by 1,2,3 having count(*) > 1`,
  },
  {
    id: 'L10', stage: 'pre', severity: 'report', owner: '20260804120000_table_zones_configurable',
    title: 'customZone values that the migration would drop (zone <> custom)',
    sql: `select id, zone::text as zone, "customZone"
            from "PosTable"
           where "customZone" is not null and btrim("customZone") <> '' and zone::text <> 'custom'`,
  },
  {
    id: 'L12', stage: 'pre', severity: 'blocker', owner: '20260810130000_dms_phase1_registry (RAISEs on unmapped rows)',
    title: 'Document types outside the five DMS codes',
    sql: `select "documentType"::text as document_type, count(*) as rows
            from "Document"
           where "documentType"::text not in ('sales_invoice','credit_note','vendor_bill','debit_note','proforma_invoice')
           group by 1`,
  },
  {
    id: 'L13', stage: 'pre', severity: 'blocker', owner: '20260914000800_cleanup_orphan_sequences + every API boot',
    title: 'document sequences that the cleanup would DROP (numbering restart risk)',
    sql: `select c.relname
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'S'
             and c.relname ~ '^seq_[0-9a-f]{8}_'
             and substring(c.relname from 5 for 8) not in
                 (select substring(replace(id::text, '-', '') from 1 for 8) from "Organization")`,
  },
  {
    id: 'L14', stage: 'post-b', severity: 'blocker', owner: '20260913000000 Account_one_default_per_category_key',
    title: 'more than one default account per (organization, category)',
    sql: `select "organizationId", "categoryId", count(*) as rows
            from "Account" where "isDefault" and "deletedAt" is null and "categoryId" is not null
           group by 1,2 having count(*) > 1`,
  },
  {
    id: 'L15', stage: 'pre', severity: 'report', owner: '20260910010000_purchase_permissions_and_ppv',
    title: 'organizations without account 5300 (no PPV account will be created)',
    sql: `select o.id, o.code from "Organization" o
           where not exists (select 1 from "Account" a where a."organizationId" = o.id and a.code = '5300')`,
  },
  {
    id: 'L16', stage: 'pre', severity: 'report', owner: '20260914000200_manager_role / 20260914000600',
    title: 'existing roles named Manager (their permissions get widened)',
    sql: `select r.id, r."organizationId", cardinality(r.permissions) as permissions,
                 (select count(*) from "_UserRoles" ur where ur."A" = r.id) as members
            from "Role" r where r.name = 'Manager'`,
  },
  {
    id: 'L17', stage: 'pre', severity: 'report', owner: '20260910000000_bill_receipt_matching',
    title: 'goods-receipt lines that will be marked fully billed',
    sql: `select count(*) as rows from "GoodsReceiptLine" having count(*) > 0`,
  },
  {
    id: 'L18', stage: 'pre', severity: 'report', owner: '20260908000000_recipe_snapshot',
    title: 'products whose stock policy flips silent -> warn',
    sql: `select count(*) as rows from "Product" where "stockPolicy"::text = 'silent' having count(*) > 0`,
  },
  {
    id: 'L19', stage: 'pre', severity: 'report', owner: '20260805120100_order_status_backfill',
    title: 'order status distribution before the remap',
    sql: `select status::text as status, count(*) as rows from "Order" group by 1 order by 1`,
  },
  {
    id: 'L20', stage: 'pre', severity: 'report', owner: '20260907130000_pos_credit_control_fails_closed',
    title: 'organizations with credit invoices (credit.allowUnlimited gets set)',
    sql: `select i."organizationId", count(*) as credit_invoices
            from "Invoice" i where i."paymentMode"::text = 'credit' group by 1`,
  },
  {
    id: 'L21', stage: 'pre', severity: 'report', owner: 'A-009 pattern (scripts/pos-a009-legacy-adjustment.cjs)',
    title: 'posted cash invoices left unsettled (owner decision, adjusting JE after go-live)',
    sql: `select count(*) as rows from "Invoice"
           where "paymentMode"::text = 'cash' and "settlementStatus"::text = 'unsettled'
             and "journalEntryId" is not null and status::text not in ('cancelled','refunded')
          having count(*) > 0`,
  },
  {
    id: 'L22', stage: 'pre', severity: 'report', owner: 'audit CASH_FLOW_REAUDIT N-16',
    title: 'cash payments with no drawer movement',
    sql: `select count(*) as rows from "Payment" p
           where p."paymentMethod" = 'cash'
             and not exists (select 1 from "CashMovement" m where m."paymentId" = p.id)
          having count(*) > 0`,
  },
  {
    id: 'L23', stage: 'pre', severity: 'report', owner: 'JWT_ACCESS_SECRET continuity',
    title: 'users enrolled in MFA (secret rotation would force re-enrolment)',
    sql: `select count(*) as rows from "User" where "mfaEnrolledAt" is not null having count(*) > 0`,
  },
  {
    id: 'L24', stage: 'pre', severity: 'report', owner: 'cutover precondition (must all be zero at the FINAL backup)',
    title: 'open operational state',
    sql: `select 'open shifts' as item, count(*) as rows from "CashSession" where status::text = 'open'
           union all
          select 'orders not invoiced', count(*) from "Order"
            where "invoiceId" is null and status::text not in ('closed','cancelled')
           union all
          select 'parked carts (PosHold)', count(*) from "PosHold"
           union all
          select 'KDS tickets still new', count(*) from "KitchenTicket" where status::text = 'new'`,
  },
  {
    id: 'L25', stage: 'pre', severity: 'blocker', owner: 'prisma migrate deploy',
    title: 'failed or rolled-back migration rows',
    sql: `select migration_name, started_at from "_prisma_migrations"
           where finished_at is null or rolled_back_at is not null`,
  },
];

async function main(): Promise<void> {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const dbName = (await db.query('select current_database() as d')).rows[0].d as string;
  console.log(`=== legacy preflight (read-only) ===`);
  console.log(`  database : ${dbName}`);
  console.log(`  stage    : ${STAGE}`);
  console.log('');

  const results: Array<Record<string, unknown>> = [];
  let blockers = 0;
  let skipped = 0;

  try {
    for (const c of CHECKS) {
      if (STAGE !== 'all' && c.stage !== STAGE) continue;
      let rows: Record<string, unknown>[] = [];
      let status: string;
      try {
        // Read-only by construction; enforced per statement so a bad check can
        // never write.
        await db.query('begin read only');
        rows = (await db.query(c.sql)).rows;
        await db.query('commit');
        if (rows.length === 0) {
          status = 'clean';
        } else if (c.severity === 'blocker') {
          status = 'BLOCKER';
          blockers += 1;
        } else {
          status = 'report';
        }
      } catch (e) {
        await db.query('rollback').catch(() => undefined);
        const msg = (e as Error).message;
        // A missing relation/column means the check does not apply to this
        // schema vintage (e.g. a post-bridge check run at stage `pre`).
        if (/does not exist/i.test(msg)) { status = 'n/a (schema vintage)'; skipped += 1; }
        else throw e;
      }
      const label = `${c.id} ${c.severity === 'blocker' ? '[blocker]' : '[report] '}`;
      console.log(`  ${label} ${status.padEnd(20)} ${c.title}`);
      if (rows.length) {
        for (const r of rows.slice(0, 10)) console.log(`         ${JSON.stringify(r)}`);
        if (rows.length > 10) console.log(`         ... ${rows.length - 10} more row(s)`);
        console.log(`         owner: ${c.owner}`);
      }
      results.push({ id: c.id, stage: c.stage, severity: c.severity, owner: c.owner, title: c.title, status, rows });
    }
  } finally {
    await db.end();
  }

  const payload = { generatedAt: new Date().toISOString(), database: dbName, stage: STAGE, blockers, skipped, results };
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2)); console.log(`\nJSON written to ${JSON_OUT}`); }

  console.log('');
  if (blockers > 0) {
    console.error(`PREFLIGHT BLOCKED: ${blockers} blocker(s). Fix the data before migrating.`);
    process.exit(2);
  }
  console.log(`PREFLIGHT CLEAN: 0 blockers${skipped ? `, ${skipped} check(s) not applicable to this schema vintage` : ''}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
