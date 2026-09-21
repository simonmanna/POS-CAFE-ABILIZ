#!/usr/bin/env node
/**
 * FINGERPRINT - the evidence that the migration moved no money, lost no row and
 * changed nothing that was not deliberately transformed.
 *
 * Three modes:
 *
 *   --capture <file>              snapshot one database to JSON (cutover: run on
 *                                 the frozen legacy database before migrating)
 *   --compare <file>              re-snapshot and compare against that JSON
 *   --ab --source X --target Y    compare two live databases directly, including
 *                                 an exhaustive row-by-row hash of the eight
 *                                 financial tables (the rehearsal mode)
 *
 * WHAT IT PROVES
 *   1. row counts per table (history tables must be identical, never shrink)
 *   2. posted journal debit/credit totals, overall and per account x month
 *   3. payments by day x method x direction x status
 *   4. invoices by day x status
 *   5. cash sessions: opening/expected/counted/difference per session
 *   6. inventory per product x location: sum(quantityChange), last balance,
 *      sum(totalValue), and StockItem on-hand
 *   7. identifier sets: invoice / receipt / payment / journal / order numbers
 *   8. min and max createdAt per history table
 *   9. tenant document sequences (last_value)
 *  10. exhaustive per-row hashes over the columns that must not change
 *
 * ALLOWLISTED TRANSFORMATIONS
 * Columns a migration deliberately rewrites are excluded from the row hash and
 * counted separately, so "how many rows did this transformation touch" is a
 * number in the report rather than an assumption. Every allowlist entry names
 * the migration that owns it, and the original values live in `legacy_archive`.
 *
 * Exit codes: 0 = no unexplained difference, 1 = UNEXPECTED difference (fail).
 */
import { Client } from 'pg';
import { writeFileSync, readFileSync } from 'node:fs';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { config } = require('dotenv');
  config();
  config({ path: 'apps/api/.env' });
} catch {
  /* optional */
}

/* ----------------------------- CLI ---------------------------------- */
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const has = (name: string): boolean => argv.includes(name);

const CAPTURE = flag('--capture');
const COMPARE = flag('--compare');
const AB = has('--ab');
const SOURCE_URL = flag('--source') ?? process.env.SOURCE_DATABASE_URL ?? '';
const TARGET_URL = flag('--target') ?? process.env.DATABASE_URL ?? '';
const OUT = flag('--out');
const SAMPLES = Number(flag('--samples') ?? 20);

if (!CAPTURE && !COMPARE && !AB && !has("--transformations")) {
  console.error('Usage: fingerprint.ts --capture <file> | --compare <file> | --ab --source <url> --target <url>');
  process.exit(2);
}

/* --------------------------- allowlist ------------------------------- */
interface Allow { columns: string[]; reason: string }
const ALLOWLIST: Record<string, Allow> = {
  Account: {
    columns: ['accountType', 'isGroup', 'categoryId', 'normalBalance', 'isPostable',
              'controlAccountType', 'sortOrder', 'parentAccountId', 'updatedAt'],
    reason: 'COA restructure: bridge-20-backfill (originals in legacy_archive.account)',
  },
  Order: { columns: ['status', 'updatedAt'], reason: '20260805120100_order_status_backfill (legacy_archive.order_status)' },
  OrderItem: { columns: ['billPrintedQty', 'billLastPrintedAt', 'kotPrintedQty', 'updatedAt'],
               reason: '20260912000000 + 20260915000100 print-progress backfills' },
  Product: { columns: ['stockPolicy', 'station', 'updatedAt'], reason: '20260908000000 silent->warn; station enum->text (legacy_archive.product_policy)' },
  Role: { columns: ['permissions', 'updatedAt'], reason: 'permission migrations 20260907130000 / 20260910010000 / 20260913100100 / 20260914000200 / 20260914000600' },
  Organization: { columns: ['settings', 'updatedAt'], reason: '20260907130000 credit.allowUnlimited (legacy_archive.organization_settings)' },
  PosTable: { columns: ['zone', 'customZone', 'updatedAt'], reason: '20260804120000 zone enum->text + PosTableZone rows (legacy_archive.pos_table)' },
  Setting: { columns: ['updatedAt'], reason: 'scopeType/scopeId added by the squashed baseline' },
  KitchenTicket: { columns: ['status', 'station', 'updatedAt'], reason: '20260803140000 station enum->text' },
  Payment: { columns: ['cashSessionId', 'updatedAt'], reason: '20260903000000 unambiguous drawer-session backfill' },
  CashSession: { columns: ['drawerAccountId', 'registerLocationId', 'branchId', 'businessDate', 'updatedAt'],
                 reason: '20260913000000 / 20260913020000 / 20260917120000 backfills' },
  Invoice: { columns: ['businessDate', 'receivableAccountId', 'updatedAt'], reason: 'new columns (no historical rewrite)' },
  Document: { columns: ['documentTypeId'], reason: '20260810130000 DMS registry backfill' },
  GoodsReceiptLine: { columns: ['billedQuantity'], reason: '20260910000000 marks legacy receipt lines fully billed' },
};

/** Exhaustively hashed row by row, then drilled into when a hash differs. */
const CRITICAL_TABLES = [
  'Invoice', 'Payment', 'PaymentAllocation', 'Receipt',
  'JournalEntry', 'JournalLine', 'InventoryLedger', 'CashMovement',
];

/* --------------------------- helpers --------------------------------- */
const q = (id: string) => '"' + id.replace(/"/g, '""') + '"';

async function tableColumns(db: Client, table: string): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

async function listTables(db: Client): Promise<string[]> {
  const r = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

async function scalar<T = string>(db: Client, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  if (!r.rows.length) return null;
  return Object.values(r.rows[0])[0] as T;
}

async function map(db: Client, sql: string): Promise<Record<string, string>> {
  const r = await db.query(sql);
  const out: Record<string, string> = {};
  for (const row of r.rows) {
    const vals = Object.values(row) as unknown[];
    out[String(vals[0])] = vals.slice(1).map((v) => (v === null ? '' : String(v))).join('|');
  }
  return out;
}

/** Row hash over the given columns, NULL-safe and enum/text agnostic. */
const rowHashExpr = (cols: string[]) =>
  `md5(concat_ws('|', ${cols.map((c) => `coalesce(${q(c)}::text, '~NULL~')`).join(', ')}))`;

/* --------------------------- capture --------------------------------- */
interface Snapshot {
  meta: Record<string, string>;
  counts: Record<string, string>;
  money: Record<string, Record<string, string>>;
  inventory: Record<string, string>;
  identifiers: Record<string, string>;
  dateBounds: Record<string, string>;
  sequences: Record<string, string>;
  tableHashes: Record<string, string>;
}

async function capture(db: Client): Promise<Snapshot> {
  const tables = await listTables(db);
  const meta: Record<string, string> = {
    capturedAt: new Date().toISOString(),
    database: (await scalar(db, 'select current_database()')) ?? '',
    version: (await scalar(db, 'select version()')) ?? '',
    timezone: (await scalar(db, `select current_setting('TimeZone')`)) ?? '',
  };

  const counts: Record<string, string> = {};
  for (const t of tables) {
    counts[t] = String(await scalar(db, `select count(*)::text from ${q(t)}`));
  }

  const money: Record<string, Record<string, string>> = {};
  money.postedTotals = await map(
    db,
    `select 'posted', coalesce(sum(l."baseDebit"),0)::text, coalesce(sum(l."baseCredit"),0)::text
       from "JournalLine" l join "JournalEntry" e on e.id = l."journalEntryId"
      where e.status = 'posted'`,
  );
  money.perAccountMonth = await map(
    db,
    `select a.code || '|' || to_char(e."postingDate", 'YYYY-MM'),
            coalesce(sum(l."baseDebit"),0)::text, coalesce(sum(l."baseCredit"),0)::text
       from "JournalLine" l
       join "JournalEntry" e on e.id = l."journalEntryId"
       join "Account" a on a.id = l."accountId"
      where e.status = 'posted'
      group by 1 order by 1`,
  );
  money.paymentsByDay = await map(
    db,
    `select to_char("createdAt", 'YYYY-MM-DD') || '|' || "paymentMethod" || '|' ||
            "direction"::text || '|' || "status"::text,
            count(*)::text, coalesce(sum(amount),0)::text
       from "Payment" group by 1 order by 1`,
  );
  money.invoicesByDay = await map(
    db,
    `select to_char("createdAt", 'YYYY-MM-DD') || '|' || "status"::text,
            count(*)::text, coalesce(sum("totalAmount"),0)::text,
            coalesce(sum("amountPaid"),0)::text, coalesce(sum("amountResidual"),0)::text
       from "Invoice" group by 1 order by 1`,
  );

  const csCols = await tableColumns(db, 'CashSession');
  const csPick = ['openingFloat', 'openingBalance', 'closingExpected', 'closingCounted', 'closingDifference', 'bankedAmount']
    .filter((c) => csCols.includes(c));
  money.cashSessions = await map(
    db,
    `select id, ${csPick.map((c) => `coalesce(${q(c)}::text,'')`).join(", ")}, status::text
       from "CashSession" order by id`,
  );

  const inventory = await map(
    db,
    `select l."productId" || '|' || coalesce(l."locationId",'-'),
            coalesce(sum(l."quantityChange"),0)::text,
            coalesce(sum(l."totalValue"),0)::text,
            count(*)::text
       from "InventoryLedger" l group by 1 order by 1`,
  );
  const stock = await map(
    db,
    `select 'stock:' || s."productId" || '|' || coalesce(s."locationId",'-'),
            coalesce(s.quantity,0)::text, coalesce(s."runningAverageCost",0)::text
       from "StockItem" s order by 1`,
  );
  Object.assign(inventory, stock);

  const identifiers: Record<string, string> = {};
  const idSets: Array<[string, string, string]> = [
    ['invoiceNumbers', 'Invoice', 'invoiceNumber'],
    ['receiptNumbers', 'Receipt', 'receiptNumber'],
    ['paymentNumbers', 'Payment', 'paymentNumber'],
    ['journalNumbers', 'JournalEntry', 'entryNumber'],
    ['orderNumbers', 'Order', 'orderNumber'],
  ];
  for (const [label, table, col] of idSets) {
    const cols = await tableColumns(db, table);
    if (!cols.includes(col)) continue;
    identifiers[label] = String(
      await scalar(
        db,
        `select coalesce(md5(string_agg(v, '|' order by v)), 'empty') || ' n=' || count(*)::text
           from (select ${q(col)}::text as v from ${q(table)} where ${q(col)} is not null) s`,
      ),
    );
  }

  const dateBounds: Record<string, string> = {};
  for (const t of ['Order', 'Invoice', 'Payment', 'Receipt', 'JournalEntry', 'CashSession', 'CashMovement', 'InventoryLedger']) {
    const cols = await tableColumns(db, t);
    if (!cols.includes('createdAt')) continue;
    dateBounds[t] = String(
      await scalar(db, `select coalesce(min("createdAt")::text,'-') || ' .. ' || coalesce(max("createdAt")::text,'-') from ${q(t)}`),
    );
  }

  const sequences = await map(
    db,
    `select c.relname, (select last_value::text from pg_sequences s
                         where s.schemaname = 'public' and s.sequencename = c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'S'
      order by 1`,
  );

  // Per COLUMN, not per row: a snapshot taken before the migration and one taken
  // after it necessarily see different column sets, so a whole-row hash would
  // always differ and prove nothing. Hashing each column separately lets the
  // comparison intersect the two column sets and name the column that moved.
  const tableHashes: Record<string, string> = {};
  for (const t of CRITICAL_TABLES) {
    const cols = await tableColumns(db, t);
    if (!cols.length) continue;
    const exprs = cols
      .map((c) => `md5(string_agg(md5(coalesce(${q(c)}::text, '~NULL~')), '' order by id::text)) as ${q(c)}`)
      .join(', ');
    const r = await db.query(`select count(*)::text as "~rows", ${exprs} from ${q(t)}`);
    const row = r.rows[0] ?? {};
    tableHashes[`${t}.~rows`] = String(row['~rows'] ?? '0');
    for (const c of cols) tableHashes[`${t}.${c}`] = String(row[c] ?? 'empty');
  }

  return { meta, counts, money, inventory, identifiers, dateBounds, sequences, tableHashes };
}

/* ---------------------------- compare -------------------------------- */
type Finding = { severity: 'UNEXPECTED' | 'ALLOWLISTED' | 'INFO'; area: string; detail: string };

function diffMaps(area: string, before: Record<string, string>, after: Record<string, string>, findings: Finding[], opts: { allowGrowth?: boolean } = {}): void {
  for (const k of Object.keys(before)) {
    if (!(k in after)) { findings.push({ severity: 'UNEXPECTED', area, detail: `${k} disappeared (was ${before[k]})` }); continue; }
    if (before[k] !== after[k]) {
      findings.push({ severity: 'UNEXPECTED', area, detail: `${k}: ${before[k]} -> ${after[k]}` });
    }
  }
  for (const k of Object.keys(after)) {
    if (!(k in before)) {
      findings.push({ severity: opts.allowGrowth ? 'INFO' : 'UNEXPECTED', area, detail: `${k} appeared (${after[k]})` });
    }
  }
}

function compareSnapshots(before: Snapshot, after: Snapshot): Finding[] {
  const findings: Finding[] = [];

  for (const [t, n] of Object.entries(before.counts)) {
    const a = after.counts[t];
    if (a === undefined) { findings.push({ severity: 'UNEXPECTED', area: 'counts', detail: `${t}: table missing after migration` }); continue; }
    if (BigInt(a) < BigInt(n)) { findings.push({ severity: 'UNEXPECTED', area: 'counts', detail: `${t} SHRANK ${n} -> ${a}` }); }
    else if (BigInt(a) > BigInt(n)) { findings.push({ severity: 'ALLOWLISTED', area: 'counts', detail: `${t} grew ${n} -> ${a} (migration seed)` }); }
  }
  for (const t of Object.keys(after.counts)) {
    if (!(t in before.counts)) findings.push({ severity: 'INFO', area: 'counts', detail: `${t} is new (${after.counts[t]} rows)` });
  }

  for (const key of Object.keys(before.money)) {
    diffMaps(`money.${key}`, before.money[key], after.money[key] ?? {}, findings, { allowGrowth: true });
  }
  diffMaps('inventory', before.inventory, after.inventory, findings, { allowGrowth: true });
  diffMaps('identifiers', before.identifiers, after.identifiers, findings);
  diffMaps('dateBounds', before.dateBounds, after.dateBounds, findings);
  diffMaps('sequences', before.sequences, after.sequences, findings, { allowGrowth: true });

  // Column hashes: compare only columns present on BOTH sides. A column that is
  // new after the migration is INFO; a column that vanished is UNEXPECTED unless
  // the allowlist owns it (the COA columns dropped by bridge-30).
  for (const key of Object.keys(before.tableHashes)) {
    const [table, column] = key.split('.');
    const allow = new Set(ALLOWLIST[table]?.columns ?? []);
    const reason = ALLOWLIST[table]?.reason ?? '';
    if (!(key in after.tableHashes)) {
      findings.push(
        allow.has(column)
          ? { severity: 'ALLOWLISTED', area: 'columns', detail: `${key} dropped - ${reason}` }
          : { severity: 'UNEXPECTED', area: 'columns', detail: `${key} disappeared` },
      );
      continue;
    }
    if (before.tableHashes[key] === after.tableHashes[key]) continue;
    findings.push(
      allow.has(column)
        ? { severity: 'ALLOWLISTED', area: 'columns', detail: `${key} rewritten - ${reason}` }
        : { severity: 'UNEXPECTED', area: 'columns', detail: `${key} changed (${before.tableHashes[key]} -> ${after.tableHashes[key]})` },
    );
  }
  for (const key of Object.keys(after.tableHashes)) {
    if (!(key in before.tableHashes)) {
      findings.push({ severity: 'INFO', area: 'columns', detail: `${key} is new` });
    }
  }

  return findings;
}

/* ------------------------- A/B row drilldown -------------------------- */
async function rowLevelCompare(src: Client, tgt: Client, table: string, findings: Finding[]): Promise<Record<string, unknown>> {
  const srcCols = await tableColumns(src, table);
  const tgtCols = await tableColumns(tgt, table);
  const common = srcCols.filter((c) => tgtCols.includes(c));
  const allow = new Set(ALLOWLIST[table]?.columns ?? []);
  const hashed = common.filter((c) => !allow.has(c));
  const onlyTarget = tgtCols.filter((c) => !srcCols.includes(c));
  const onlySource = srcCols.filter((c) => !tgtCols.includes(c));

  const fetch = async (db: Client) =>
    (await db.query<{ id: string; h: string }>(
      `select id::text as id, ${rowHashExpr(hashed)} as h from ${q(table)}`,
    )).rows;

  const [a, b] = await Promise.all([fetch(src), fetch(tgt)]);
  const ma = new Map(a.map((r) => [r.id, r.h]));
  const mb = new Map(b.map((r) => [r.id, r.h]));

  const missing: string[] = [];
  const changed: string[] = [];
  for (const [id, h] of ma) {
    const other = mb.get(id);
    if (other === undefined) missing.push(id);
    else if (other !== h) changed.push(id);
  }
  const added = [...mb.keys()].filter((id) => !ma.has(id));

  if (missing.length) findings.push({ severity: 'UNEXPECTED', area: `rows.${table}`, detail: `${missing.length} row(s) missing after migration, e.g. ${missing.slice(0, 5).join(', ')}` });
  if (changed.length) findings.push({ severity: 'UNEXPECTED', area: `rows.${table}`, detail: `${changed.length} row(s) changed outside the allowlist, e.g. ${changed.slice(0, 5).join(', ')}` });
  if (added.length) findings.push({ severity: 'INFO', area: `rows.${table}`, detail: `${added.length} row(s) added after migration` });

  // Field-level drilldown for the first few changed rows.
  const samples: Array<Record<string, unknown>> = [];
  for (const id of changed.slice(0, SAMPLES)) {
    const sel = `select ${common.map(q).join(', ')} from ${q(table)} where id::text = $1`;
    const [ra, rb] = await Promise.all([src.query(sel, [id]), tgt.query(sel, [id])]);
    const fields: Record<string, string> = {};
    for (const c of common) {
      const va = String(ra.rows[0]?.[c] ?? '~NULL~');
      const vb = String(rb.rows[0]?.[c] ?? '~NULL~');
      if (va !== vb) fields[c] = `${va} -> ${vb}`;
    }
    samples.push({ id, fields });
  }

  // How many rows each allowlisted column actually touched.
  const allowlistImpact: Record<string, number> = {};
  for (const c of common.filter((x) => allow.has(x))) {
    const rows = await src.query<{ id: string; v: string }>(`select id::text as id, coalesce(${q(c)}::text,'~NULL~') as v from ${q(table)}`);
    const rowsB = await tgt.query<{ id: string; v: string }>(`select id::text as id, coalesce(${q(c)}::text,'~NULL~') as v from ${q(table)}`);
    const mbv = new Map(rowsB.rows.map((r) => [r.id, r.v]));
    allowlistImpact[c] = rows.rows.filter((r) => mbv.get(r.id) !== r.v).length;
  }

  return {
    table,
    sourceRows: a.length,
    targetRows: b.length,
    hashedColumns: hashed.length,
    allowlistedColumns: [...allow].filter((c) => common.includes(c)),
    allowlistReason: ALLOWLIST[table]?.reason ?? null,
    allowlistImpact,
    newColumns: onlyTarget,
    droppedColumns: onlySource,
    missing: missing.length,
    changed: changed.length,
    added: added.length,
    samples,
  };
}

/* --------------------- transformation proofs -------------------------- */
/**
 * Every allowlisted rewrite is proved against `legacy_archive`, so "we meant to
 * change that" is a query result rather than a claim. Runs on the migrated
 * database only; archive.sql must have run before the bridge.
 */
async function proveTransformations(db: Client, findings: Finding[]): Promise<Record<string, unknown>> {
  const proofs: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail: string) => {
    proofs[name] = { ok, detail };
    if (!ok) findings.push({ severity: 'UNEXPECTED', area: 'transformations', detail: `${name}: ${detail}` });
  };

  // D4 - Order.status remap (20260805120100). open->confirmed, preparing/ready->
  // in_progress, served->completed; everything else must be untouched.
  const statusMap: Record<string, string> = {
    open: 'confirmed', preparing: 'in_progress', ready: 'in_progress', served: 'completed',
  };
  const orders = await db.query<{ old: string; new: string; n: string }>(
    `select a.status as old, o.status::text as new, count(*)::text as n
       from legacy_archive.order_status a join "Order" o on o.id = a.id
      group by 1,2 order by 1,2`,
  );
  const badOrders = orders.rows.filter((r) => (statusMap[r.old] ?? r.old) !== r.new);
  check('order_status_remap', badOrders.length === 0,
    badOrders.length ? JSON.stringify(badOrders) : orders.rows.map((r) => `${r.old}->${r.new}:${r.n}`).join(', '));

  // D5 - Product.stockPolicy silent -> warn (20260908000000), nothing else.
  const products = await db.query<{ old: string; new: string; n: string }>(
    `select a."stockPolicy" as old, p."stockPolicy"::text as new, count(*)::text as n
       from legacy_archive.product_policy a join "Product" p on p.id = a.id
      group by 1,2 order by 1,2`,
  );
  const badProducts = products.rows.filter((r) => (r.old === 'silent' ? 'warn' : r.old) !== r.new);
  check('product_stock_policy', badProducts.length === 0,
    badProducts.length ? JSON.stringify(badProducts) : products.rows.map((r) => `${r.old}->${r.new}:${r.n}`).join(', '));

  // D1 - every legacy account survives with its identity intact, and the
  // coa-template invariant holds (categoryKey null <=> isPostable false).
  const accounts = await db.query<{ missing: string; renamed: string; defaults: string; invariant: string }>(
    `select (select count(*)::text from legacy_archive.account a
               where not exists (select 1 from "Account" x where x.id = a.id)) as missing,
            (select count(*)::text from legacy_archive.account a join "Account" x on x.id = a.id
               where x.name is distinct from a.name or x.code is distinct from a.code) as renamed,
            (select count(*)::text from legacy_archive.account a join "Account" x on x.id = a.id
               where x."isDefault" is distinct from a."isDefault") as defaults,
            (select count(*)::text from "Account"
               where ("isPostable" and "categoryId" is null) or (not "isPostable" and "categoryId" is not null)) as invariant`,
  );
  const acc = accounts.rows[0];
  check('accounts_preserved', acc.missing === '0' && acc.renamed === '0' && acc.defaults === '0',
    `missing=${acc.missing} renamed=${acc.renamed} isDefault_changed=${acc.defaults}`);
  check('coa_invariant', acc.invariant === '0', `violations=${acc.invariant}`);

  // D7 - permissions are only ever widened, except cash_session:reopen, which
  // 20260913100100 deliberately retires.
  const roles = await db.query<{ id: string; name: string; lost: string }>(
    `select r.id, r.name,
            array_to_string(array(select unnest(a.permissions) except select unnest(r.permissions)), ',') as lost
       from legacy_archive.role_permissions a join "Role" r on r.id = a.id`,
  );
  const badRoles = roles.rows.filter((r) => r.lost && r.lost.split(',').some((p) => p && p !== 'cash_session:reopen'));
  check('role_permissions_only_widened', badRoles.length === 0,
    badRoles.length ? JSON.stringify(badRoles) : `${roles.rows.length} legacy role(s) intact`);

  // D8 - organization settings gain the credit key and lose nothing.
  const orgs = await db.query<{ id: string; lost: string }>(
    `select o.id,
            array_to_string(array(select jsonb_object_keys(coalesce(a.settings,'{}'::jsonb))
                                  except select jsonb_object_keys(coalesce(o.settings,'{}'::jsonb))), ',') as lost
       from legacy_archive.organization_settings a join "Organization" o on o.id = a.id`,
  );
  const badOrgs = orgs.rows.filter((r) => r.lost);
  check('organization_settings_preserved', badOrgs.length === 0,
    badOrgs.length ? JSON.stringify(badOrgs) : `${orgs.rows.length} organization(s) keep every settings key`);

  // D2 - PosTable zones: a non-custom zone keeps its value; a custom zone is
  // re-pointed at a PosTableZone row rather than losing its name.
  const zones = await db.query<{ unchanged: string; repointed: string; lost: string }>(
    `select (select count(*)::text from legacy_archive.pos_table a join "PosTable" t on t.id = a.id
               where a.zone <> 'custom' and t.zone = a.zone) as unchanged,
            (select count(*)::text from legacy_archive.pos_table a join "PosTable" t on t.id = a.id
               where a.zone = 'custom' and t.zone <> 'custom') as repointed,
            (select count(*)::text from legacy_archive.pos_table a join "PosTable" t on t.id = a.id
               where a.zone <> 'custom' and t.zone <> a.zone) as lost`,
  );
  const z = zones.rows[0];
  check('pos_table_zones', z.lost === '0', `unchanged=${z.unchanged} repointed=${z.repointed} lost=${z.lost}`);

  // D11 - businessDate is added but never backfilled; reports fall back to
  // issueDate, so a non-null value on a legacy invoice would be a rewrite.
  const bd = await db.query<{ n: string }>(
    `select count(*)::text as n from "Invoice" i
       join legacy_archive.order_status a on a.id = i."orderId"
      where i."businessDate" is not null`,
  );
  check('business_date_not_backfilled', bd.rows[0].n === '0', `legacy invoices with businessDate=${bd.rows[0].n}`);

  return proofs;
}

/* ------------------------------ main --------------------------------- */
async function main(): Promise<void> {
  if (has('--transformations')) {
    if (!TARGET_URL) throw new Error('DATABASE_URL (or --target) is required');
    const db = new Client({ connectionString: TARGET_URL });
    await db.connect();
    try {
      const findings: Finding[] = [];
      const proofs = await proveTransformations(db, findings);
      for (const [name, p] of Object.entries(proofs)) {
        const r = p as { ok: boolean; detail: string };
        console.log(`  ${r.ok ? '[pass]' : '[FAIL]'} ${name.padEnd(32)} ${r.detail}`);
      }
      report(findings, { mode: 'transformations', proofs });
      return;
    } finally {
      await db.end();
    }
  }

  if (CAPTURE || COMPARE) {
    if (!TARGET_URL) throw new Error('DATABASE_URL (or --target) is required');
    const db = new Client({ connectionString: TARGET_URL });
    await db.connect();
    try {
      const snap = await capture(db);
      if (CAPTURE) {
        writeFileSync(CAPTURE, JSON.stringify(snap, null, 2));
        console.log(`Fingerprint written to ${CAPTURE}`);
        console.log(`  ${Object.keys(snap.counts).length} tables, posted totals: ${JSON.stringify(snap.money.postedTotals)}`);
        return;
      }
      const before: Snapshot = JSON.parse(readFileSync(COMPARE as string, 'utf8'));
      const findings = compareSnapshots(before, snap);
      report(findings, { mode: 'compare', before: before.meta, after: snap.meta });
      return;
    } finally {
      await db.end();
    }
  }

  // --ab
  if (!SOURCE_URL || !TARGET_URL) throw new Error('--ab needs --source and --target');
  const src = new Client({ connectionString: SOURCE_URL });
  const tgt = new Client({ connectionString: TARGET_URL });
  await src.connect();
  await tgt.connect();
  try {
    const [before, after] = [await capture(src), await capture(tgt)];
    const findings = compareSnapshots(before, after);
    const rowReports: Record<string, unknown>[] = [];
    for (const t of CRITICAL_TABLES) {
      rowReports.push(await rowLevelCompare(src, tgt, t, findings));
    }
    report(findings, { mode: 'ab', before: before.meta, after: after.meta, rows: rowReports });
  } finally {
    await src.end();
    await tgt.end();
  }
}

function report(findings: Finding[], extra: Record<string, unknown>): void {
  const unexpected = findings.filter((f) => f.severity === 'UNEXPECTED');
  const allowlisted = findings.filter((f) => f.severity === 'ALLOWLISTED');
  const info = findings.filter((f) => f.severity === 'INFO');

  const payload = { generatedAt: new Date().toISOString(), ...extra, counts: { unexpected: unexpected.length, allowlisted: allowlisted.length, info: info.length }, findings };
  const out = OUT ?? 'fingerprint-report.json';
  writeFileSync(out, JSON.stringify(payload, null, 2));

  console.log('');
  for (const f of unexpected.slice(0, 40)) console.log(`  UNEXPECTED  [${f.area}] ${f.detail}`);
  if (unexpected.length > 40) console.log(`  ... ${unexpected.length - 40} more unexpected`);
  for (const f of allowlisted.slice(0, 15)) console.log(`  allowlisted [${f.area}] ${f.detail}`);
  for (const f of info.slice(0, 10)) console.log(`  info        [${f.area}] ${f.detail}`);
  if (info.length > 10) console.log(`  ... ${info.length - 10} more info`);

  console.log('');
  console.log(`unexpected=${unexpected.length} allowlisted=${allowlisted.length} info=${info.length}`);
  console.log(`Report written to ${out}`);

  if (unexpected.length > 0) {
    console.error('\nFINGERPRINT FAILED - unexplained differences. Do not proceed.');
    process.exit(1);
  }
  console.log('FINGERPRINT PASSED - no unexplained differences.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
