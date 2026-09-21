#!/usr/bin/env node
/**
 * Production validation suite for the POS Order → Invoice → Payment → Receipt
 * pipeline, including the CREDIT (house-account) settlement path.
 *
 * Unlike scripts/smoke-pos.ts (which exercises the legacy /invoices Document
 * path), this drives the NEW POS pipeline end to end and asserts the DATABASE
 * state behind each action: balanced journal entries, receipt rows, cash
 * movements, stock deduction and restoration, line discounts, split bills,
 * statement invariants, orphan sweeps, report reconciliation and shift close.
 *
 * Every scenario is wrapped in check() and every failure is classified, so a
 * stale request can never be mistaken for broken data:
 *
 *   INTEGRITY     an assertion about the database/business state failed.
 *                 This is a real defect. Exit code 2.
 *   CONTRACT      the API rejected the request SHAPE (validation error, unknown
 *                 route). The script is out of date with the API. Exit code 1.
 *   REJECTED      the API refused a well-formed request for a business reason
 *                 (permission, configuration, guard). Read the message. Exit 1.
 *   PRECONDITION  the environment cannot run the scenario (e.g. no mobile-money
 *                 tile configured, credit disabled, legacy open orders on the
 *                 copy). Reported, not counted as a failure.
 *
 * It WRITES real sales/refunds/GL, so it refuses a non-local API_BASE unless
 * VALIDATE_ALLOW_WRITE=1 is set. Run it on a disposable copy, never on the café.
 *
 * Usage:
 *   API_BASE=http://localhost:3000/api/v1 \
 *   ORG_CODE=DEMO ADMIN_EMAIL=admin@demo.test ADMIN_PASSWORD='Admin@123' \
 *   DATABASE_URL='postgresql://...@localhost:5432/<disposable copy>' \
 *   pnpm tsx scripts/validate-production.ts
 *
 * Optional:
 *   VALIDATE_REGISTER_CODE=UAT-REG     run on a dedicated register (created if missing)
 *   VALIDATE_MANAGER_PIN=1234          PIN of the logged-in manager for refund/void overrides
 *   VALIDATE_EXPECT_NEXT_INVOICE=INV-2026-004136
 *   VALIDATE_EXPECT_NEXT_RECEIPT=RCT-008200
 *                                      the first numbers this run must issue
 *   VALIDATE_JSON=<file>               write the classified results as JSON
 */
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';

// Load the repo-root .env first, then the API's .env (without overriding), so
// DATABASE_URL / creds are picked up wherever the developer keeps them. dotenv
// is optional — plain env vars work too. Requires: `pnpm add -w -D tsx pg dotenv`.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { config } = require('dotenv');
  config();
  config({ path: 'apps/api/.env' });
} catch { /* dotenv not installed — rely on the ambient environment */ }

// NestJS mounts the API under the `api/v1` global prefix (see apps/api/src/main.ts).
const BASE = process.env.API_BASE ?? 'http://localhost:3000/api/v1';
const ORG = process.env.ORG_CODE ?? 'DEMO';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@123';
const MANAGER_PIN = process.env.VALIDATE_MANAGER_PIN;
const DB_URL = process.env.DATABASE_URL ?? '';
if (!DB_URL) { console.error('DATABASE_URL not set (checked env + apps/api/.env).'); process.exit(2); }

const isLocal = /localhost|127\.0\.0\.1/.test(BASE);
if (!isLocal && process.env.VALIDATE_ALLOW_WRITE !== '1') {
  console.error(`Refusing to run write-heavy validation against non-local API_BASE=${BASE}. Set VALIDATE_ALLOW_WRITE=1 to override.`);
  process.exit(2);
}

let AUTH = '';
let ORG_ID = '';

// ---- failure classes --------------------------------------------------------
type Category = 'INTEGRITY' | 'CONTRACT' | 'REJECTED' | 'PRECONDITION';
class IntegrityError extends Error { category: Category = 'INTEGRITY'; }
class Precondition extends Error { category: Category = 'PRECONDITION'; }
class ApiError extends Error {
  category: Category;
  constructor(public status: number, public body: any, message: string) {
    super(message);
    // Validation errors come back as a message ARRAY (class-validator); an
    // unknown route is Nest's "Cannot POST ...". Both mean the request is stale.
    const msg = body?.message;
    const shape = status === 404 && typeof msg === 'string' && msg.startsWith('Cannot ')
      || (status === 400 && Array.isArray(msg));
    this.category = shape ? 'CONTRACT' : 'REJECTED';
  }
}

interface RawResult { status: number; json: any; text: string }
async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<RawResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (AUTH) h.Authorization = `Bearer ${AUTH}`;
  // Money-moving endpoints require an Idempotency-Key. Each call here is a
  // distinct operation, so a fresh key unless the caller supplied its own.
  if (method !== 'GET' && !h['Idempotency-Key']) h['Idempotency-Key'] = uuid();
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: res.status, json, text };
}
async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<any> {
  const r = await raw(method, path, body, headers);
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, r.json, `${method} ${path} → ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}
const uuid = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const list = (x: any): any[] => (Array.isArray(x) ? x : x?.data ?? []);

// ---- result accumulator -----------------------------------------------------
interface Row { name: string; ok: boolean; skipped?: boolean; category?: Category; detail?: string }
const rows: Row[] = [];
async function check(name: string, fn: () => Promise<void | 'skip' | string>): Promise<void> {
  try {
    const out = await fn();
    if (out === 'skip') rows.push({ name, ok: true, skipped: true });
    else rows.push({ name, ok: true, detail: typeof out === 'string' ? out : undefined });
    console.log(`  ✓ ${name}${typeof out === 'string' && out !== 'skip' ? ` — ${out}` : out === 'skip' ? ' (skipped)' : ''}`);
  } catch (e: any) {
    const category: Category = e?.category ?? 'INTEGRITY';
    const skipped = category === 'PRECONDITION';
    rows.push({ name, ok: skipped, skipped, category, detail: e?.message });
    console.log(`  ${skipped ? '–' : '✗'} [${category}] ${name} — ${e?.message}`);
  }
}
function assert(cond: any, msg: string): void { if (!cond) throw new IntegrityError(msg); }
function need(cond: any, msg: string): void { if (!cond) throw new Precondition(msg); }
function near(a: number, b: number, tol = 0.05): boolean { return Math.abs(a - b) <= tol; }
async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < until) { await new Promise((r) => setTimeout(r, 500)); v = await read(); }
  return v;
}

// ---- db helpers -------------------------------------------------------------
let db: Client;
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const r = await db.query(sql, params);
  return r.rows;
}
async function jeBalanced(sourceType: string, sourceId: string): Promise<{ balanced: boolean; debit: number; credit: number }> {
  const r = await q(
    `SELECT COALESCE(SUM(l.debit),0)::float AS d, COALESCE(SUM(l.credit),0)::float AS c
       FROM "JournalEntry" e JOIN "JournalLine" l ON l."journalEntryId" = e.id
      WHERE e."organizationId" = $1 AND e."sourceType" = $2 AND e."sourceId" = $3`,
    [ORG_ID, sourceType, sourceId],
  );
  const d = Number(r[0]?.d ?? 0), c = Number(r[0]?.c ?? 0);
  return { balanced: near(d, c, 0.01) && d > 0, debit: d, credit: c };
}
/** On-hand from the stock ledger (sum of signed movements). */
async function onHand(pid: string): Promise<number> {
  const r = await q(
    `SELECT COALESCE(SUM("quantityChange"),0)::float AS q FROM "InventoryLedger"
      WHERE "organizationId" = $1 AND "productId" = $2`,
    [ORG_ID, pid],
  );
  return Number(r[0]?.q ?? 0);
}

// ---- shared fixtures --------------------------------------------------------
let sessionId = '';
let productId = ''; let productPrice = 0; let trackedProductId = ''; let trackedPrice = 0; let managerId = '';
let customerId = ''; let tableId = '';
let momo: { accountId: string; label: string } | null = null;
const runStartedAt = new Date();
const createdOrderIds = new Set<string>();

/** The manager override every refund/void needs (the logged-in manager + PIN). */
const override = () => ({ overrideById: managerId, ...(MANAGER_PIN ? { overridePin: MANAGER_PIN } : {}) });
const momoTender = (amount: number) => {
  need(momo, 'no mobile-money payment tile with an account (configure POS payment methods, decision D21)');
  return { method: 'mobile_money', amount, accountId: momo!.accountId, reference: 'VALIDATE' };
};

async function newInvoice(opts: { lines?: any[]; partnerId?: string; tableId?: string; paymentMode?: string; orderType?: string } = {}): Promise<any> {
  const lines = opts.lines ?? [{ productId, description: 'Validation item', quantity: 1, unitPrice: productPrice }];
  const order = await call('POST', '/pos/orders', {
    orderType: opts.orderType ?? (opts.tableId ? 'dine_in' : 'takeaway'),
    tableId: opts.tableId,
    partnerId: opts.partnerId,
    cashSessionId: sessionId,
    guestCount: 1,
    lines,
  });
  createdOrderIds.add(order.id);
  const invoice = await call('POST', `/pos/orders/${order.id}/invoice`, {
    ...(opts.paymentMode ? { paymentMode: opts.paymentMode } : {}),
  });
  return { order, invoice };
}
/**
 * Stock for a sale is posted asynchronously (StockPostingJob, drained every
 * 30 s). Wait until the given invoice's jobs — or every job of the org — are
 * done, so stock assertions and restock refunds see a settled ledger.
 */
async function waitStockPosted(invoiceId?: string, ms = 90000): Promise<void> {
  const pending = async () => Number((await q(
    `SELECT COUNT(*)::int AS n FROM "StockPostingJob" WHERE "organizationId"=$1 AND status <> 'done'${invoiceId ? ' AND "invoiceId"=$2' : ''}`,
    invoiceId ? [ORG_ID, invoiceId] : [ORG_ID],
  ))[0].n);
  const left = await waitFor(pending, (n) => n === 0, ms);
  assert(left === 0, `${left} stock posting job(s) still not done after ${ms / 1000}s${invoiceId ? ` for invoice ${invoiceId}` : ''}`);
}
/** An un-billed order (tabs are split before they are billed). */
async function newOrder(lines: any[], table?: string): Promise<any> {
  const order = await call('POST', '/pos/orders', {
    orderType: table ? 'dine_in' : 'takeaway', tableId: table, cashSessionId: sessionId, guestCount: 1, lines,
  });
  createdOrderIds.add(order.id);
  return order;
}
/** Composite checkout at the server's own price; tenders must equal the total. */
async function checkout(pid: string, price: number, description: string, qty = 1): Promise<string> {
  const co = await call('POST', '/pos/checkout', {
    lines: [{ productId: pid, description, quantity: qty, unitPrice: price }],
    paymentMethod: 'cash', amountTendered: price * qty, expectedTotal: price * qty, cashSessionId: sessionId,
  });
  const invId = co.invoiceId ?? co.invoice?.id;
  assert(invId, 'no invoiceId from checkout');
  const ord = (await q(`SELECT "orderId" FROM "Invoice" WHERE id=$1`, [invId]))[0];
  if (ord?.orderId) createdOrderIds.add(ord.orderId);
  return invId;
}

async function bootstrap(): Promise<void> {
  const tok = await call('POST', '/auth/login', { organizationCode: ORG, email: EMAIL, password: PASSWORD });
  AUTH = tok.accessToken;
  const me = await call('GET', '/auth/me');
  managerId = me.id ?? me.userId ?? me.user?.id;
  ORG_ID = me.organizationId ?? me.organization?.id ?? tok.organizationId;
  if (!ORG_ID) {
    const orgs = await q(`SELECT id FROM "Organization" WHERE code = $1`, [ORG]);
    ORG_ID = orgs[0]?.id;
  }
  if (!ORG_ID) throw new Error('could not resolve organizationId');

  // Cash register + open session.
  // VALIDATE_REGISTER_CODE: run on a dedicated register (created if missing), so
  // a migrated copy's own open shifts and orders are left exactly as they are.
  const regCode = process.env.VALIDATE_REGISTER_CODE;
  const regs = list(await call('GET', '/cash-registers'));
  let register = regCode ? regs.find((r: any) => r.code === regCode) : regs[0];
  if (!register) {
    const cash = list(await call('GET', '/accounts?search=cash'))[0];
    register = await call('POST', '/cash-registers', { code: regCode ?? 'VAL-1', name: 'Validation', defaultAccountId: cash.id });
  }
  // A float above the drawer's ledger must name its funding account (a safe or
  // another cash account); the service ignores the source when nothing is added.
  const fundingSource = list(await call('GET', '/accounts?search=cash'))
    .find((a: any) => a.id !== register.defaultAccountId && a.isPostable !== false);
  // The opening count may not be below the drawer's ledger (cash left from the
  // previous shift that was never banked). Open with what is in the drawer, or
  // with a funded 1,000 float on an empty drawer.
  const drawerLedger = Number((await q(
    `SELECT COALESCE(SUM(l.debit - l.credit),0)::float AS b FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId"
      WHERE l."organizationId"=$1 AND l."accountId"=$2 AND e.status IN ('posted','reversed')`,
    [ORG_ID, register.defaultAccountId],
  ))[0]?.b ?? 0);
  const openingFloat = Math.max(1000, drawerLedger);
  const open = await call('POST', '/cash-sessions/open', {
    cashRegisterId: register.id, openingFloat, notes: 'validate: opening float',
    ...(fundingSource && openingFloat > drawerLedger ? { openingSourceAccountId: fundingSource.id } : {}),
  });
  sessionId = open.id;

  // Products at their catalogue price: the server prices every line itself.
  const products = list(await call('GET', '/products?pageSize=200'));
  if (!products.length) throw new Error('no products');
  const priceOf = (p: any) => Number(p.salesPrice ?? p.basePrice ?? p.price ?? 0);
  const sellable = products.filter((p: any) => p.isActive !== false && priceOf(p) > 0);
  const tracked = sellable.find((p: any) => p.trackInventory && (p.productType === 'stockable' || p.productType === 'consumable'));
  const plain = sellable.find((p: any) => !p.trackInventory) ?? sellable[0];
  if (!plain) throw new Error('no sellable product with a price');
  productId = plain.id; productPrice = priceOf(plain);
  trackedProductId = tracked?.id ?? ''; trackedPrice = tracked ? priceOf(tracked) : 0;

  // The mobile-money tile the till shows (configured or synthesized from accounts).
  const methods = list(await call('GET', '/pos/payment-methods'));
  const m = methods.find((x: any) => x.kind === 'mobile_money' && x.accountId && x.isActive !== false);
  momo = m ? { accountId: m.accountId, label: m.label } : null;

  // A named (non-walk-in) customer.
  const partners = list(await call('GET', '/partners?pageSize=50'));
  const cust = partners.find((p: any) => p.isCustomer && p.code !== 'WALKIN') ?? partners.find((p: any) => p.code !== 'WALKIN');
  customerId = cust?.id ?? '';

  // A free table (best-effort).
  const tables = list(await call('GET', '/pos/tables'));
  tableId = (tables.find((t: any) => t.status === 'available') ?? tables[0])?.id ?? '';
}

async function main(): Promise<void> {
  console.log(`POS production validation — base=${BASE} org=${ORG} db=${DB_URL.replace(/:[^:@]*@/, ':***@')}`);
  db = new Client({ connectionString: DB_URL });
  await db.connect();
  await bootstrap();
  console.log(`bootstrap ok — session=${sessionId} product=${productId} (${productPrice}) tracked=${trackedProductId || 'none'} (${trackedPrice}) momo=${momo?.label ?? 'none'} customer=${customerId || 'none'} table=${tableId || 'none'}\n`);

  // 0) Numbering continuity: the first documents this run issues.
  const expectInv = process.env.VALIDATE_EXPECT_NEXT_INVOICE;
  const expectRct = process.env.VALIDATE_EXPECT_NEXT_RECEIPT;

  // 1) Full cash sale via composite checkout.
  await check('1. full cash sale → paid + receipts + balanced JE + cash movement', async () => {
    const invId = await checkout(productId, productPrice, 'Cash sale');
    const inv = (await q(`SELECT status, "settlementStatus", "amountResidual"::float AS r, "paymentMode" FROM "Invoice" WHERE id=$1`, [invId]))[0];
    assert(inv.status === 'paid' && inv.settlementStatus === 'settled' && near(inv.r, 0, 0.01), `invoice not settled: ${JSON.stringify(inv)}`);
    const receipts = await q(`SELECT type FROM "Receipt" WHERE "invoiceId"=$1`, [invId]);
    const types = receipts.map((r) => r.type);
    assert(types.includes('payment_receipt') && types.includes('merchant_copy'), `missing receipts: ${types}`);
    const je = await jeBalanced('pos_invoice', invId);
    assert(je.balanced, `invoice JE unbalanced d=${je.debit} c=${je.credit}`);
    const cm = await q(`SELECT COUNT(*)::int AS n FROM "CashMovement" WHERE "cashSessionId"=$1 AND "movementType"='sale'`, [sessionId]);
    assert(Number(cm[0].n) >= 1, 'no sale cash movement');
    return `inv residual=${inv.r}`;
  });

  await check('1b. numbering continues from the migrated history', async () => {
    need(expectInv || expectRct, 'VALIDATE_EXPECT_NEXT_INVOICE / _RECEIPT not set');
    // createdAt is UTC in a timestamp WITHOUT time zone: compare as a UTC literal.
    const since = runStartedAt.toISOString().replace('Z', '');
    const inv = (await q(`SELECT min("invoiceNumber") AS n FROM "Invoice" WHERE "organizationId"=$1 AND "createdAt" >= $2::timestamp`, [ORG_ID, since]))[0]?.n;
    const rct = (await q(`SELECT min("receiptNumber") AS n FROM "Receipt" WHERE "organizationId"=$1 AND "createdAt" >= $2::timestamp`, [ORG_ID, since]))[0]?.n;
    if (expectInv) assert(inv === expectInv, `first invoice ${inv}, expected ${expectInv}`);
    if (expectRct) assert(rct === expectRct, `first receipt ${rct}, expected ${expectRct}`);
    return `invoice ${inv}, receipt ${rct}`;
  });

  // 2) Split tender (cash + mobile money) → mixed.
  await check('2. split tender cash + mobile money → mixed, 2 allocations', async () => {
    const half = Math.round(productPrice / 2);
    const co = await call('POST', '/pos/checkout', {
      lines: [{ productId, description: 'Split', quantity: 1, unitPrice: productPrice }],
      tenders: [{ method: 'cash', amount: half }, momoTender(productPrice - half)],
      cashSessionId: sessionId,
    });
    const invId = co.invoiceId ?? co.invoice?.id;
    const inv = (await q(`SELECT "paymentMode", "settlementStatus" FROM "Invoice" WHERE id=$1`, [invId]))[0];
    assert(inv.settlementStatus === 'settled', 'split not settled');
    assert(inv.paymentMode === 'mixed', `expected mixed, got ${inv.paymentMode}`);
    const allocs = await q(`SELECT COUNT(*)::int AS n FROM "PaymentAllocation" WHERE "invoiceId"=$1`, [invId]);
    assert(Number(allocs[0].n) === 2, `expected 2 allocations, got ${allocs[0].n}`);
  });

  // 3) Partial payment → completion; table held then freed.
  await check('3. partial → completion (statuses, receipts, derived mixed, table lifecycle)', async () => {
    need(momo, 'no mobile-money tile (D21)');
    const useTable = tableId || undefined;
    const { invoice } = await newInvoice({ lines: [{ productId, description: 'Partial', quantity: 2, unitPrice: productPrice }], tableId: useTable, orderType: useTable ? 'dine_in' : 'takeaway' });
    const total = Number(invoice.totalAmount);
    const first = Math.round(total / 3);
    const p1 = await call('POST', `/pos/invoices/${invoice.id}/payments`, { tenders: [{ method: 'cash', amount: first }], allowPartial: true, cashSessionId: sessionId });
    assert(p1.settlementStatus === 'partially_settled', `expected partially_settled, got ${p1.settlementStatus}`);
    const inv1 = (await q(`SELECT status, "paymentMode", "settlementStatus" FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(inv1.status === 'posted' && !inv1.paymentMode, `partial invoice wrong state: ${JSON.stringify(inv1)}`);
    if (useTable) {
      const t = (await q(`SELECT status FROM "PosTable" WHERE id=$1`, [useTable]))[0];
      assert(t.status === 'occupied', `table should stay occupied while partially paid, got ${t.status}`);
    }
    const rt = await q(`SELECT type FROM "Receipt" WHERE "invoiceId"=$1`, [invoice.id]);
    assert(rt.some((r) => r.type === 'partial_payment_receipt'), 'no partial_payment_receipt');
    const p2 = await call('POST', `/pos/invoices/${invoice.id}/payments`, { tenders: [momoTender(total - first)], cashSessionId: sessionId });
    assert(p2.settlementStatus === 'settled', `expected settled, got ${p2.settlementStatus}`);
    const inv2 = (await q(`SELECT status, "paymentMode" FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(inv2.status === 'paid' && inv2.paymentMode === 'mixed', `completion wrong: ${JSON.stringify(inv2)}`);
    if (useTable) {
      const t = (await q(`SELECT status FROM "PosTable" WHERE id=$1`, [useTable]))[0];
      assert(t.status !== 'occupied', `table should be released after full settle, got ${t.status}`);
    }
  });

  // 4) Guards. Every new invoice posts to receivables, so the old "pre-settled
  // invoice" guard has no subject any more; the tender guards below are the
  // strict contract that replaces it.
  await check('4a. under-tender without allowPartial → 400', async () => {
    const { invoice } = await newInvoice();
    const r = await raw('POST', `/pos/invoices/${invoice.id}/payments`, { tenders: [{ method: 'cash', amount: Math.max(1, Number(invoice.totalAmount) - 1) }], cashSessionId: sessionId });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
  });
  await check('4b. negative tender → 400', async () => {
    const { invoice } = await newInvoice();
    const r = await raw('POST', `/pos/invoices/${invoice.id}/payments`, { tenders: [{ method: 'cash', amount: Number(invoice.totalAmount) + 50 }, { method: 'cash', amount: -50 }], cashSessionId: sessionId });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
  });
  await check('4c. zero tender → 400', async () => {
    const { invoice } = await newInvoice();
    const r = await raw('POST', `/pos/invoices/${invoice.id}/payments`, { tenders: [{ method: 'cash', amount: 0 }], allowPartial: true, cashSessionId: sessionId });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
  });
  await check('4d. overpay tenders → 400', async () => {
    const { invoice } = await newInvoice();
    const r = await raw('POST', `/pos/invoices/${invoice.id}/payments`, { tenders: [{ method: 'cash', amount: Number(invoice.totalAmount) + 5 }], cashSessionId: sessionId });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
  });
  await check('4e. collection on a legacy cash-posted invoice is refused (D16)', async () => {
    const legacy = (await q(
      `SELECT id FROM "Invoice" WHERE "organizationId"=$1 AND "receivableAccountId" IS NULL
          AND "paymentMode" IN ('cash','card','mobile_money') AND "amountResidual" > 0 AND status NOT IN ('cancelled','refunded') LIMIT 1`,
      [ORG_ID],
    ))[0];
    need(legacy, 'no legacy cash-posted invoice with a balance on this copy');
    const r = await raw('POST', `/pos/invoices/${legacy.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
    assert(r.status === 400, `legacy collection should be refused, got ${r.status}`);
  });

  // 5) Credit lifecycle: bill without a mode, then settle on account.
  const creditIssue = async (invoiceId: string) => {
    const r = await raw('POST', `/pos/invoices/${invoiceId}/credit`, { partnerId: customerId });
    if (r.status === 400 && /credit/i.test(String(r.json?.message)) && !/already/i.test(String(r.json?.message))) {
      // Leave nothing dangling: an unpaid bill would block the shift close.
      await call('POST', `/pos/invoices/${invoiceId}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
      throw new Precondition(`credit refused by configuration (decision D10): ${r.json?.message}`);
    }
    if (r.status >= 300) throw new ApiError(r.status, r.json, `POST credit → ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json;
  };
  await check('5. credit issue → statement → settle → settlement_receipt → AR cleared', async () => {
    need(customerId, 'no named customer');
    const { invoice } = await newInvoice({ partnerId: customerId });
    const total = Number(invoice.totalAmount);
    await creditIssue(invoice.id);
    const inv0 = (await q(`SELECT "paymentMode", "settlementStatus" FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(inv0.settlementStatus === 'unsettled' && inv0.paymentMode === 'credit', `credit issue wrong: ${JSON.stringify(inv0)}`);
    const ci = await q(`SELECT type FROM "Receipt" WHERE "invoiceId"=$1`, [invoice.id]);
    assert(ci.some((r) => r.type === 'credit_issue_receipt'), 'no credit_issue_receipt');
    const st = await call('GET', `/pos/customers/${customerId}/statement`);
    assert(st.entries.length >= 1, 'statement empty after credit issue');
    const last = st.entries[st.entries.length - 1];
    assert(near(last.runningBalance, st.outstanding, 0.01), `runningBalance ${last.runningBalance} != outstanding ${st.outstanding}`);
    assert(st.outstanding >= total - 0.01, `outstanding ${st.outstanding} should include the ${total} charge`);
    const pay = await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
    assert(pay.settlementStatus === 'settled', `credit not settled: ${pay.settlementStatus}`);
    const sr = await q(`SELECT type FROM "Receipt" WHERE "invoiceId"=$1`, [invoice.id]);
    assert(sr.some((r) => r.type === 'settlement_receipt'), 'no settlement_receipt after credit payment');
    const inv = (await q(`SELECT "amountResidual"::float AS r FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(near(inv.r, 0, 0.01), `credit invoice residual not cleared: ${inv.r}`);
  });

  // 6) Write-off.
  await check('6. write-off → written_off + balanced bad-debt JE + statement entry', async () => {
    need(customerId, 'no named customer');
    const { invoice } = await newInvoice({ partnerId: customerId });
    await creditIssue(invoice.id);
    await call('POST', `/pos/invoices/${invoice.id}/write-off`, { reason: 'validation write-off' });
    const inv = (await q(`SELECT "settlementStatus" FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(inv.settlementStatus === 'written_off', `expected written_off, got ${inv.settlementStatus}`);
    const je = await jeBalanced('pos_invoice_writeoff', invoice.id);
    assert(je.balanced, `write-off JE unbalanced d=${je.debit} c=${je.credit}`);
    const st = await call('GET', `/pos/customers/${customerId}/statement`);
    assert(st.entries.some((e: any) => e.type === 'write_off' && e.invoiceId === invoice.id), 'statement missing write_off entry');
  });

  // 7) Full refund + restock.
  await check('7. full refund → refunded + reversal JE + stock restored + refund cash movement', async () => {
    const pid = trackedProductId || productId;
    const price = trackedProductId ? trackedPrice : productPrice;
    const invId = await checkout(pid, price, 'Refund me');
    await waitStockPosted(invId);
    const sold = trackedProductId ? await onHand(pid) : 0;
    await call('POST', `/pos/invoices/${invId}/refund`, { reason: 'validation refund', ...override(), stockDisposition: 'restock', cashSessionId: sessionId });
    const inv = (await q(`SELECT status FROM "Invoice" WHERE id=$1`, [invId]))[0];
    assert(inv.status === 'refunded', `expected refunded, got ${inv.status}`);
    const cm = await q(`SELECT COUNT(*)::int AS n FROM "CashMovement" WHERE "cashSessionId"=$1 AND "movementType"='refund'`, [sessionId]);
    assert(Number(cm[0].n) >= 1, 'no refund cash movement');
    if (trackedProductId) {
      const after = await waitFor(() => onHand(pid), (v) => v >= sold + 1 - 0.001);
      assert(near(after, sold + 1, 0.001), `stock not restored: after sale ${sold}, after refund ${after}`);
      return `stock ${sold}→${after}`;
    }
    return 'no tracked product: stock leg not exercised';
  });

  // 8) Partial refund + idempotency replay.
  await check('8. partial refund + idempotency replay (no double restock)', async () => {
    const pid = trackedProductId || productId;
    const price = trackedProductId ? trackedPrice : productPrice;
    const { invoice } = await newInvoice({ lines: [{ productId: pid, description: 'Qty2', quantity: 2, unitPrice: price }] });
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
    await waitStockPosted(invoice.id);
    const line = (await q(`SELECT id FROM "InvoiceItem" WHERE "invoiceId"=$1 ORDER BY "lineNumber" LIMIT 1`, [invoice.id]))[0];
    assert(line, 'no invoice item to refund');
    const before = trackedProductId ? await onHand(pid) : 0;
    const key = uuid();
    const body = { reason: 'partial', ...override(), stockDisposition: 'restock', cashSessionId: sessionId, lines: [{ lineId: line.id, quantity: 1 }] };
    await call('POST', `/pos/invoices/${invoice.id}/refund`, body, { 'Idempotency-Key': key });
    const r2 = await raw('POST', `/pos/invoices/${invoice.id}/refund`, body, { 'Idempotency-Key': key });
    assert(r2.status < 300, `replay should succeed/replay, got ${r2.status}`);
    if (trackedProductId) {
      const after = await waitFor(() => onHand(pid), (v) => v - before >= 1 - 0.001);
      assert(near(after - before, 1, 0.001), `partial refund restocked wrong qty: ${after - before} (expected 1)`);
    }
    await call('POST', `/pos/invoices/${invoice.id}/refund`, { reason: 'rest', ...override(), stockDisposition: 'restock', cashSessionId: sessionId, lines: [{ lineId: line.id, quantity: 1 }] });
    const over = await raw('POST', `/pos/invoices/${invoice.id}/refund`, { reason: 'over', ...override(), stockDisposition: 'restock', cashSessionId: sessionId, lines: [{ lineId: line.id, quantity: 1 }] });
    assert(over.status === 400, `over-refund should be 400, got ${over.status}`);
  });

  // 9) Void.
  await check('9. void settled sale → refunded', async () => {
    const invId = await checkout(productId, productPrice, 'Void me');
    await call('POST', `/pos/sales/${invId}/void`, { reason: 'validation void', ...override(), stockDisposition: 'no_return', cashSessionId: sessionId });
    const inv = (await q(`SELECT status FROM "Invoice" WHERE id=$1`, [invId]))[0];
    assert(inv.status === 'refunded' || inv.status === 'cancelled', `void wrong status: ${inv.status}`);
  });

  // 10) Double-settle race.
  await check('10. double-settle race → exactly one wins, residual never negative', async () => {
    const { invoice } = await newInvoice();
    const attempt = () => raw('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const ok = results.filter((r) => r.status === 'fulfilled' && (r.value as RawResult).status < 300).length;
    assert(ok === 1, `expected exactly 1 winner, got ${ok}`);
    const inv = (await q(`SELECT "amountResidual"::float AS r FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(inv.r >= -0.001, `negative residual: ${inv.r}`);
    const allocs = await q(`SELECT COUNT(*)::int AS n FROM "PaymentAllocation" WHERE "invoiceId"=$1`, [invoice.id]);
    assert(Number(allocs[0].n) === 1, `expected 1 allocation, got ${allocs[0].n}`);
  });

  // 11) Double-credit race.
  await check('11. double-credit race → one credit_issue_receipt only', async () => {
    need(customerId, 'no named customer');
    const { invoice } = await newInvoice({ partnerId: customerId });
    const attempt = () => raw('POST', `/pos/invoices/${invoice.id}/credit`, { partnerId: customerId });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const vals = results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean) as RawResult[];
    if (vals.every((v) => v.status === 400 && /credit/i.test(String(v.json?.message)) && !/already/i.test(String(v.json?.message)))) {
      await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
      throw new Precondition(`credit refused by configuration (decision D10): ${vals[0]?.json?.message}`);
    }
    const ok = vals.filter((v) => v.status < 300).length;
    assert(ok === 1, `expected exactly 1 credit winner, got ${ok}`);
    const ci = await q(`SELECT COUNT(*)::int AS n FROM "Receipt" WHERE "invoiceId"=$1 AND type='credit_issue_receipt'`, [invoice.id]);
    assert(Number(ci[0].n) === 1, `expected 1 credit_issue_receipt, got ${ci[0].n}`);
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
  });

  // 12) Duplicate invoice numbers.
  await check('12. no duplicate invoice numbers', async () => {
    const dups = await q(`SELECT "invoiceNumber", COUNT(*)::int AS n FROM "Invoice" WHERE "organizationId"=$1 GROUP BY "invoiceNumber" HAVING COUNT(*) > 1`, [ORG_ID]);
    assert(dups.length === 0, `duplicate invoice numbers: ${dups.map((d) => d.invoiceNumber).join(', ')}`);
  });

  // 13) Orphan sweep.
  await check('13a. no inbound posted payments without allocation', async () => {
    const orphans = await q(
      `SELECT p.id FROM "Payment" p
        WHERE p."organizationId"=$1 AND p.direction='inbound' AND p.status='posted'
          AND NOT EXISTS (SELECT 1 FROM "PaymentAllocation" a WHERE a."paymentId"=p.id)`,
      [ORG_ID],
    );
    assert(orphans.length === 0, `${orphans.length} unallocated payments`);
  });
  await check('13b. no receipts pointing at a missing invoice', async () => {
    const orphans = await q(
      `SELECT r.id FROM "Receipt" r WHERE r."organizationId"=$1 AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i.id=r."invoiceId")`,
      [ORG_ID],
    );
    assert(orphans.length === 0, `${orphans.length} orphan receipts`);
  });
  await check('13c. every posted journal entry balances', async () => {
    const bad = await q(
      `SELECT e.id, SUM(l.debit)::float AS d, SUM(l.credit)::float AS c
         FROM "JournalEntry" e JOIN "JournalLine" l ON l."journalEntryId"=e.id
        WHERE e."organizationId"=$1 AND e.status IN ('posted','reversed')
        GROUP BY e.id HAVING ABS(SUM(l.debit) - SUM(l.credit)) > 0.01`,
      [ORG_ID],
    );
    assert(bad.length === 0, `${bad.length} unbalanced journal entries`);
  });

  // 14) Reports: sales summary answers for today; the X-report's expected cash
  // equals the drawer recomputed from movements.
  await check('14. sales-summary responds; X-report expected cash = SQL recompute', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const summary = await call('GET', `/pos/reports/sales-summary?fromDate=${today}&toDate=${today}&groupBy=day`);
    assert(summary && Array.isArray(summary.periods), 'sales-summary has no periods');
    const x = await call('GET', `/pos/reports/x-report?cashSessionId=${sessionId}`);
    const expectedCash = Number(x.totals?.expectedCash ?? x.expectedCash ?? NaN);
    const svc = await call('GET', `/cash-sessions/${sessionId}/expected`);
    const serviceCash = Number(svc.expectedCash);
    const recompute = await q(
      `SELECT (s."openingFloat"
              + COALESCE(SUM(CASE WHEN m."movementType" IN ('sale','pay_in') THEN m.amount ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN m."movementType" IN ('refund','pay_out','supplier_payment') THEN m.amount ELSE 0 END),0)
              + COALESCE(SUM(CASE WHEN m."movementType" = 'adjustment' THEN m.amount ELSE 0 END),0))::float AS c
         FROM "CashSession" s LEFT JOIN "CashMovement" m ON m."cashSessionId"=s.id
        WHERE s.id=$1 GROUP BY s."openingFloat"`,
      [sessionId],
    );
    const sqlCash = Number(recompute[0]?.c ?? 0);
    assert(near(serviceCash, sqlCash, 0.01), `service expected cash ${serviceCash} vs SQL ${sqlCash}`);
    if (Number.isFinite(expectedCash)) assert(near(expectedCash, sqlCash, 0.01), `X-report cash ${expectedCash} vs SQL ${sqlCash}`);
    return `expectedCash=${serviceCash}`;
  });

  // 15) Line discount → the discount reaches the invoice and the JE still balances.
  await check('15. line discount → total reduced server-side + balanced JE', async () => {
    const qty = 2;
    const gross = productPrice * qty;
    const { invoice } = await newInvoice({
      lines: [{
        productId, description: 'Discounted', quantity: qty, unitPrice: productPrice,
        discountType: 'percentage', discountPercent: 10, discountReason: 'validation',
      }],
    });
    const total = Number(invoice.totalAmount);
    assert(total < gross, `discount not applied: total ${total} >= gross ${gross}`);
    await call('POST', `/pos/invoices/${invoice.id}/payments`, { paymentMethod: 'cash', cashSessionId: sessionId });
    const inv = (await q(`SELECT "settlementStatus", "amountResidual"::float AS r FROM "Invoice" WHERE id=$1`, [invoice.id]))[0];
    assert(inv.settlementStatus === 'settled' && near(inv.r, 0, 0.01), `discounted invoice not settled: ${JSON.stringify(inv)}`);
    const je = await jeBalanced('pos_invoice', invoice.id);
    assert(je.balanced, `discounted JE unbalanced d=${je.debit} c=${je.credit}`);
    return `gross=${gross} net=${total}`;
  });

  // 16) Forward stock deduction.
  await check('16. sale deducts stock from the ledger', async () => {
    need(trackedProductId, 'no stock-tracked product with a price');
    await waitStockPosted();
    const before = await onHand(trackedProductId);
    const invId = await checkout(trackedProductId, trackedPrice, 'Stock deduct');
    await waitStockPosted(invId);
    const after = await onHand(trackedProductId);
    assert(near(after, before - 1, 0.001), `stock not deducted: ${before} -> ${after} (expected ${before - 1})`);
    return `${before} -> ${after}`;
  });

  // 17) Split bill on a dine-in tab, through the flow the POS screen uses
  // (/pos/tabs/:tableId/split/*): two bills, one line each, each settled in
  // full; the tab closes when the last bill is paid.
  await check('17. split bill → 2 bills settle separately, tab closes', async () => {
    const free = list(await call('GET', '/pos/tables')).find((t: any) => t.status === 'available');
    need(free, 'no available table');
    // Open the tab the way the POS does (tabs/:tableId/items), not a bare order.
    const tab = await call('POST', `/pos/tabs/${free.id}/items`, {
      cashSessionId: sessionId, guestCount: 2, sendToKitchen: false,
      lines: [
        { productId, description: 'Split A', quantity: 1, unitPrice: productPrice },
        { productId, description: 'Split B', quantity: 1, unitPrice: productPrice },
      ],
    });
    void tab;
    const st = await call('POST', `/pos/tabs/${free.id}/split/bills`, { count: 2 });
    const order = { id: st.sourceOrderId as string };
    assert(order.id, 'split state has no source order');
    createdOrderIds.add(order.id);
    const bills = st.bills ?? [];
    const lines = st.lines ?? [];
    assert(bills.length === 2, `expected 2 split bills, got ${bills.length}`);
    assert(lines.length === 2, `expected 2 tab lines, got ${lines.length}`);
    for (let i = 0; i < 2; i++) {
      await call('POST', `/pos/split-bills/${bills[i].id}/assign`, { items: [{ sourceItemId: lines[i].id, quantity: 1 }] });
    }
    const results: any[] = [];
    for (const b of bills) {
      results.push(await call('POST', `/pos/split-bills/${b.id}/settle`, { paymentMethod: 'cash', cashSessionId: sessionId }));
    }
    for (const r of results) {
      const inv = (await q(`SELECT status, "settlementStatus" FROM "Invoice" WHERE id=$1`, [r.invoiceId]))[0];
      assert(inv?.status === 'paid' && inv.settlementStatus === 'settled', `split bill ${r.invoiceNumber} not settled: ${JSON.stringify(inv)}`);
      const je = await jeBalanced('pos_invoice', r.invoiceId);
      assert(je.balanced, `split bill ${r.invoiceNumber} JE unbalanced d=${je.debit} c=${je.credit}`);
    }
    assert(results[results.length - 1].tableClosed === true, 'tab not closed after the last split bill was paid');
    const src = (await q(`SELECT status FROM "Order" WHERE id=$1`, [order.id]))[0];
    assert(src && src.status !== 'open' && src.status !== 'confirmed', `source order still ${src?.status}`);
    return `${results.map((r) => r.invoiceNumber).join(' + ')}`;
  });

  // 18) Teardown — close the session (the Z-report path).
  await check('18. close cash session cleanly → Z-report totals', async () => {
    // The close gate refuses while this shift's stock posting is still queued.
    await waitStockPosted();
    const expected = await call('GET', `/cash-sessions/${sessionId}/expected`);
    // Every tracked non-cash tender (MoMo, bank, card) is declared at close, as
    // the cashier does in the close dialog: the balance this shift took in.
    const tracked = list(await call('GET', '/pos/payment-methods'))
      .filter((m: any) => m.trackInShift && m.accountId && m.kind !== 'cash');
    const rec = await call('GET', `/cash-sessions/${sessionId}/reconciliation`);
    const closingAccounts: Record<string, string> = {};
    for (const m of tracked) {
      if (m.accountId in closingAccounts) continue;
      const acc = (rec.accounts ?? []).find((a: any) => a.accountId === m.accountId);
      closingAccounts[m.accountId] = String(acc?.net ?? '0');
    }
    const r = await raw('POST', '/cash-sessions/close', {
      closingCounted: Number(expected.expectedCash), notes: 'validate-close',
      ...(Object.keys(closingAccounts).length ? { closingAccounts } : {}),
    });
    if (r.status === 400 && r.json?.code === 'OPEN_ORDERS') {
      const all = r.json.openOrders ?? [];
      const foreign = all.filter((o: any) => !createdOrderIds.has(o.id));
      const own = all.filter((o: any) => createdOrderIds.has(o.id));
      // Orders this run left open are a real defect; legacy open orders on a
      // mid-trade copy are an environment condition (they are 0 at the final backup).
      assert(own.length === 0, `close blocked by orders this run created: ${own.map((o: any) => o.orderNumber).join(', ')}`);
      throw new Precondition(`close blocked by ${foreign.length} legacy open order(s) on this copy: ${foreign.map((o: any) => o.orderNumber).join(', ')}`);
    }
    if (r.status >= 300) throw new ApiError(r.status, r.json, `close → ${r.status}: ${r.text.slice(0, 200)}`);
    const row = (await q(`SELECT status, "closedAt", "closingDifference"::float AS v FROM "CashSession" WHERE id=$1`, [sessionId]))[0];
    assert(row.status === 'closed', `session not closed: ${row.status}`);
    assert(row.closedAt, 'closedAt not set');
    assert(near(Number(row.v ?? 0), 0, 0.01), `unexpected close variance ${row.v} — counted equalled expected`);
    return `closed variance=${row.v ?? 0}`;
  });

  // ---- summary --------------------------------------------------------------
  await db.end();
  const by = (c: Category) => rows.filter((r) => r.category === c);
  const passed = rows.filter((r) => r.ok && !r.skipped);
  const pre = by('PRECONDITION');
  const integrity = by('INTEGRITY'), contract = by('CONTRACT'), rejected = by('REJECTED');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed.length} passed · INTEGRITY ${integrity.length} · CONTRACT ${contract.length} · REJECTED ${rejected.length} · PRECONDITION ${pre.length}`);
  for (const [label, set] of [['INTEGRITY (data/business defects)', integrity], ['CONTRACT (script out of date)', contract], ['REJECTED (API refused a valid request)', rejected], ['PRECONDITION (not run here)', pre]] as const) {
    if (!set.length) continue;
    console.log(`\n${label}:`);
    for (const f of set) console.log(`  ${f.name}\n      ${f.detail}`);
  }
  console.log('='.repeat(60));
  if (process.env.VALIDATE_JSON) {
    writeFileSync(process.env.VALIDATE_JSON, JSON.stringify({ base: BASE, org: ORG, startedAt: runStartedAt.toISOString(), rows }, null, 2));
  }
  process.exit(integrity.length ? 2 : contract.length || rejected.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nValidation aborted:', err?.message ?? err);
  try { await db?.end(); } catch { /* noop */ }
  process.exit(1);
});
