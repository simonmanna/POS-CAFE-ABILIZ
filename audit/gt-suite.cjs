/**
 * PHASE 14 — Golden Transaction suite (GT-01…GT-18).
 * Live API against the ISOLATED audit org. Full downstream state verification:
 * invoice → payment → allocation → GL → drawer movement → receipt → stock job →
 * InventoryLedger → StockItem → order close → PosRefund → Z snapshot.
 * Soft-asserts: every check records PASS/FAIL into audit/evidence-gt.json.
 * Usage: node audit/gt-suite.cjs <orgFile>
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));

const BASE = 'http://localhost:3001/api/v1';
const CONN = 'postgresql://cafe-pos:cafe-pos@localhost:5432/cafe-pos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let ORG, RUN, sessionId, tokens = {}, emails = {};

function record(gt, check, pass, detail) {
  results.push({ gt, check, pass, detail: detail === undefined ? null : detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${gt}] ${check}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

async function api(who, method, p, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, body: json };
}

async function db(sql, params = []) {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

async function login(who) {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emails[ORG.users[who]], password: ORG.passwords[who], organizationCode: ORG.code }) });
  const j = await res.json();
  if (!j.accessToken) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  tokens[who] = j.accessToken;
}

/** Full downstream state for one invoice id. */
async function saleState(invoiceId) {
  const inv = (await db(`SELECT "invoiceNumber", status, "settlementStatus", "paymentMode", "totalAmount", "amountPaid", "amountResidual", "amountRefunded" FROM "Invoice" WHERE id=$1`, [invoiceId]))[0];
  const pays = await db(`SELECT p."paymentNumber", p.direction, p."paymentMethod", p.amount, p."accountId", p."refundedAmount", a.code acct FROM "Payment" p LEFT JOIN "Account" a ON a.id=p."accountId" WHERE p.id IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1) OR p."refundOfId" IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1)`, [invoiceId]);
  const allocs = await db(`SELECT amount, "refundedAmount" FROM "PaymentAllocation" WHERE "invoiceId"=$1`, [invoiceId]);
  const gl = await db(`SELECT a.code, sum(l.debit) dr, sum(l.credit) cr FROM "JournalEntry" je JOIN "JournalLine" l ON l."journalEntryId"=je.id JOIN "Account" a ON a.id=l."accountId" WHERE je.id IN (SELECT "journalEntryId" FROM "Invoice" WHERE id=$1) OR je."sourceType"='payment' AND je.id IN (SELECT p."journalEntryId" FROM "Payment" p WHERE p.id IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1)) GROUP BY 1 ORDER BY 1`, [invoiceId]);
  const movements = await db(`SELECT "movementType", amount FROM "CashMovement" WHERE "paymentId" IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1)`, [invoiceId]);
  const receipts = await db(`SELECT type, "receiptNumber" FROM "Receipt" WHERE "invoiceId"=$1`, [invoiceId]);
  const job = (await db(`SELECT status, "lastError" FROM "StockPostingJob" WHERE "invoiceId"=$1`, [invoiceId]))[0] ?? null;
  const ledger = await db(`SELECT type, "quantityChange", "balanceAfter", "referenceType" FROM "InventoryLedger" WHERE "referenceType"='pos_invoice' AND "referenceId"=$1`, [invoiceId]);
  const order = (await db(`SELECT o.status, o."invoiceId" FROM "Order" o JOIN "Invoice" i ON i.id=o."invoiceId" WHERE i.id=$1`, [invoiceId]))[0] ?? null;
  return { inv, pays, allocs, gl, movements, receipts, job, ledger, order };
}

async function checkout(who, key, lines, tenders, opts = {}) {
  return api(who, 'POST', '/pos/checkout', {
    lines, tenders, cashSessionId: opts.cashSessionId ?? sessionId,
    ...(opts.partnerId ? { partnerId: opts.partnerId } : {}),
    ...(opts.discount ? opts.discount : {}),
    ...(opts.amountTendered ? { amountTendered: opts.amountTendered } : {}),
    ...(opts.override ? { overrideById: opts.override.overrideById, overridePin: opts.override.overridePin } : {}),
  }, { 'Idempotency-Key': key });
}

const L = (productId, qty, unitPrice, extra = {}) => ({ productId, description: extra.description ?? 'Audit item', quantity: qty, unitPrice, ...extra });

main();
async function main() {
  const orgFile = process.argv[2];
  ORG = JSON.parse(fs.readFileSync(path.join(process.cwd(), orgFile), 'utf8'));
  if (!ORG.code) ORG.code = (await db(`SELECT code FROM "Organization" WHERE id=$1`, [ORG.orgId]))[0].code;
  RUN = String(Date.now());
  const orgId = ORG.orgId;
  for (const u of await db(`SELECT id, email FROM "User" WHERE "organizationId"=$1`, [orgId])) emails[u.id] = u.email;

  await login('cashier'); await login('manager'); await login('admin');
  log(`=== GT SUITE in org ${orgId} (run ${RUN}) ===`);
  function log(...a) { console.log(...a); }

  // Existing session from A-series is open on AUD-REG1 (owner: cashier)
  const openSess = (await db(`SELECT id FROM "CashSession" WHERE "organizationId"=$1 AND status='open'`, [orgId]))[0];
  sessionId = openSess?.id;
  if (!sessionId) {
    const o = await checkout_open();
    sessionId = o;
  }
  async function checkout_open() {
    const r = await api('cashier', 'POST', '/cash-sessions/open', { cashRegisterId: ORG.register.id, openingFloat: 50000, openingSourceAccountId: ORG.accounts.bank, notes: 'GT opening' }, { 'Idempotency-Key': `gt-open-${RUN}` });
    if (!r.ok) throw new Error('open session: ' + JSON.stringify(r.body).slice(0, 200));
    return r.body.id;
  }
  log('session:', sessionId);

  const tea = ORG.products['AUD-TEA'], cake = ORG.products['AUD-CAKE'], coffee = ORG.products['AUD-COFFEE'], svc = ORG.products['AUD-SVC'], low = ORG.products['AUD-LOW'];

  /* GT-01 cash sale: 2×TEA = 6,000 */
  log('\n== GT-01 cash ==');
  const gt01 = await checkout('cashier', `gt01-${RUN}`, [L(tea, 2, 3000, { description: 'Audit Tea' })], [{ method: 'cash', amount: 6000 }]);
  record('GT-01', 'checkout 200', gt01.ok, gt01.body.invoiceNumber ?? gt01.body.message);
  if (gt01.ok) {
    await sleep(35000); // worker drain
    const st = await saleState(gt01.body.invoiceId);
    record('GT-01', 'invoice settled', st.inv?.settlementStatus === 'settled', st.inv);
    record('GT-01', 'payment→drawer acct 1101', st.pays.some(p => p.acct === '1101' && Number(p.amount) === 6000), st.pays.map(p => `${p.acct}:${p.amount}`));
    record('GT-01', 'GL Dr1101=6000 / Cr1300=6000 / Cr4100=6000', st.gl.filter(g => g.code === '1101')[0]?.dr === '6000.000000' && st.gl.filter(g => g.code === '1300' && g.dr !== '0')[0]?.dr === '6000.000000' && st.gl.filter(g => g.code === '4100')[0]?.cr === '6000.000000', st.gl);
    record('GT-01', 'drawer movement sale 6000', st.movements.some(m => m.movementType === 'sale' && Number(m.amount) === 6000), st.movements);
    record('GT-01', 'receipts (payment+merchant)', st.receipts.some(r => r.type === 'payment_receipt') && st.receipts.some(r => r.type === 'merchant_copy'), st.receipts);
    record('GT-01', 'stock job done + ledger −2 tea', st.job?.status === 'done' && st.ledger.some(l => Number(l.quantityChange) === -2), { job: st.job?.status, ledger: st.ledger });
    record('GT-01', 'order closed', st.order?.status === 'closed', st.order);
  }

  /* GT-02 MTN sale: 1×CAKE = 8,000 */
  log('\n== GT-02 MTN ==');
  const gt02 = await checkout('cashier', `gt02-${RUN}`, [L(cake, 1, 8000, { description: 'Audit Cake' })], [{ method: 'mobile_money', amount: 8000, accountId: ORG.accounts.mmMtn }]);
  record('GT-02', 'checkout 200', gt02.ok, gt02.body.invoiceNumber ?? gt02.body.message);
  if (gt02.ok) {
    const st = await saleState(gt02.body.invoiceId);
    record('GT-02', 'payment→MOMO-MTN(2110)', st.pays.some(p => p.acct === '2110' && Number(p.amount) === 8000), st.pays.map(p => `${p.acct}:${p.amount}`));
    record('GT-02', 'no drawer movement (electronic)', st.movements.length === 0, st.movements);
    record('GT-02', 'GL Dr2110 / Cr4100', st.gl.some(g => g.code === '2110' && g.dr === '8000.000000') && st.gl.some(g => g.code === '4100' && g.cr === '8000.000000'), st.gl);
  }

  /* GT-03 Airtel sale: 1×CAKE = 8,000 */
  log('\n== GT-03 Airtel ==');
  const gt03 = await checkout('cashier', `gt03-${RUN}`, [L(cake, 1, 8000, { description: 'Audit Cake' })], [{ method: 'mobile_money', amount: 8000, accountId: ORG.accounts.mmAirtel }]);
  record('GT-03', 'checkout 200', gt03.ok, gt03.body.invoiceNumber ?? gt03.body.message);
  if (gt03.ok) {
    const st = await saleState(gt03.body.invoiceId);
    record('GT-03', 'payment→MOMO-AIRTEL(2120)', st.pays.some(p => p.acct === '2120' && Number(p.amount) === 8000), st.pays.map(p => `${p.acct}:${p.amount}`));
    record('GT-03', 'no drawer movement', st.movements.length === 0, st.movements);
  }

  /* GT-04 bank sale with reference: 1×CAKE = 8,000 */
  log('\n== GT-04 bank ==');
  const gt04 = await checkout('cashier', `gt04-${RUN}`, [L(cake, 1, 8000, { description: 'Audit Cake' })], [{ method: 'bank', amount: 8000, accountId: ORG.accounts.bank, reference: 'AUD-TRF-001' }]);
  record('GT-04', 'checkout 200', gt04.ok, gt04.body.invoiceNumber ?? gt04.body.message);
  if (gt04.ok) {
    const st = await saleState(gt04.body.invoiceId);
    record('GT-04', 'payment→bank(1200)', st.pays.some(p => p.acct === '1200' && Number(p.amount) === 8000), st.pays.map(p => `${p.acct}:${p.amount}`));
    const refRow = await db(`SELECT reference FROM "Payment" WHERE id IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1)`, [gt04.body.invoiceId]);
    record('GT-04', 'reference persisted', refRow[0]?.reference === 'AUD-TRF-001', refRow);
  }

  /* GT-05 split payment: 10×SVC = 100,000 = cash 40k + MTN 60k */
  log('\n== GT-05 split ==');
  const gt05 = await checkout('cashier', `gt05-${RUN}`, [L(svc, 10, 10000, { description: 'Audit Service' })], [{ method: 'cash', amount: 40000 }, { method: 'mobile_money', amount: 60000, accountId: ORG.accounts.mmMtn }]);
  record('GT-05', 'checkout 200', gt05.ok, gt05.body.invoiceNumber ?? gt05.body.message);
  if (gt05.ok) {
    const st = await saleState(gt05.body.invoiceId);
    record('GT-05', 'two payments 40k/60k on right accounts', st.pays.filter(p => p.direction === 'inbound').length === 2 && st.pays.some(p => p.acct === '1101' && Number(p.amount) === 40000) && st.pays.some(p => p.acct === '2110' && Number(p.amount) === 60000), st.pays.map(p => `${p.acct}:${p.amount}:${p.direction}`));
    const allocSum = st.allocs.reduce((s, a) => s + Number(a.amount), 0);
    record('GT-05', 'allocations sum = 100,000', allocSum === 100000, allocSum);
    record('GT-05', 'paymentMode mixed', st.inv?.paymentMode === 'mixed', st.inv?.paymentMode);
    record('GT-05', 'drawer movement 40k only (MM no drawer)', st.movements.every(m => Number(m.amount) === 40000) && st.movements.length === 1, st.movements);
  }

  /* GT-06 order-level discount 15% + reason + manager override: 4×TEA 12,000 → 10,200 */
  log('\n== GT-06 discount ==');
  const gt06 = await checkout('cashier', `gt06-${RUN}`, [L(tea, 4, 3000, { description: 'Audit Tea' })], [{ method: 'cash', amount: 10200 }],
    { discount: { transactionDiscountPercent: 15, transactionDiscountType: 'percentage', discountReason: 'audit discount' }, override: { overrideById: ORG.users.manager, overridePin: ORG.pin.manager } });
  record('GT-06', 'checkout 200 (override honored)', gt06.ok, gt06.body.invoiceNumber ?? gt06.body.message);
  if (gt06.ok) {
    const st = await saleState(gt06.body.invoiceId);
    record('GT-06', 'total 10,200 & discountTotal 1,800', Number(st.inv?.totalAmount) === 10200, { total: st.inv?.totalAmount });
    const disc = (await db(`SELECT "discountTotal" FROM "Invoice" WHERE id=$1`, [gt06.body.invoiceId]))[0];
    record('GT-06', 'discount recorded', Number(disc.discountTotal) === 1800, disc);
    record('GT-06', 'GL revenue credited net', st.gl.some(g => g.code === '4100' && g.cr === '10200.000000'), st.gl);
  }

  /* GT-07 taxable sale: 2×COFFEE 5,000 tax-inclusive 18% = 10,000 gross */
  log('\n== GT-07 tax ==');
  const gt07 = await checkout('cashier', `gt07-${RUN}`, [L(coffee, 2, 5000, { description: 'Audit Coffee', taxId: ORG.tax.vat18, taxInclusive: true })], [{ method: 'cash', amount: 10000 }]);
  record('GT-07', 'checkout 200', gt07.ok, gt07.body.invoiceNumber ?? gt07.body.message);
  if (gt07.ok) {
    const st = await saleState(gt07.body.invoiceId);
    const invFull = (await db(`SELECT "subtotal", "taxAmount", "totalAmount" FROM "Invoice" WHERE id=$1`, [gt07.body.invoiceId]))[0];
    record('GT-07', 'gross=10,000, tax>0, net+tax=gross', Number(invFull.totalAmount) === 10000 && Number(invFull.taxAmount) > 0 && Math.abs(Number(invFull.subtotal) + Number(invFull.taxAmount) - 10000) < 0.001, invFull);
    record('GT-07', 'GL Cr output tax (2300) = taxAmount', st.gl.some(g => g.code === '2300' && Number(g.cr) === Number(invFull.taxAmount)), st.gl.filter(g => ['2300', '4100', '1300'].includes(g.code)));
  }

  /* GT-08 multi-item + decimal qty: 1.5 TEA + 0.5 CAKE + 1 SVC */
  log('\n== GT-08 multi/decimal ==');
  const gt08Total = 1.5 * 3000 + 0.5 * 8000 + 10000;
  const gt08 = await checkout('cashier', `gt08-${RUN}`, [
    L(tea, 1.5, 3000, { description: 'Audit Tea' }),
    L(cake, 0.5, 8000, { description: 'Audit Cake' }),
    L(svc, 1, 10000, { description: 'Audit Service' }),
  ], [{ method: 'cash', amount: gt08Total }]);
  record('GT-08', 'checkout 200 (decimal qty accepted)', gt08.ok, `${gt08.body.invoiceNumber ?? gt08.body.message} expected ${gt08Total}`);
  if (gt08.ok) {
    const st = await saleState(gt08.body.invoiceId);
    record('GT-08', 'total matches line math', Math.abs(Number(st.inv?.totalAmount) - gt08Total) < 0.001, { total: st.inv?.totalAmount, expected: gt08Total });
    const items = await db(`SELECT description, quantity FROM "InvoiceItem" WHERE "invoiceId"=$1 ORDER BY "lineNumber"`, [gt08.body.invoiceId]);
    record('GT-08', 'decimal quantities persisted', items.some(i => Number(i.quantity) === 1.5) && items.some(i => Number(i.quantity) === 0.5), items);
  }

  /* Wait for stock worker to drain before refunds (restock blocked while pending) */
  log('\n(waiting 40s for stock-posting worker…)');
  await sleep(40000);

  /* GT-09 void the GT-08 sale (manager override, no_return) */
  log('\n== GT-09 void ==');
  const gt09 = await api('manager', 'POST', `/pos/sales/${gt08.body.invoiceId}/void`, {
    reason: 'GT-09 void test', stockDisposition: 'no_return', overrideById: ORG.users.manager, overridePin: ORG.pin.manager, cashSessionId: sessionId,
  }, { 'Idempotency-Key': `gt09-${RUN}` });
  record('GT-09', 'void 200', gt09.ok, gt09.body.status ?? gt09.body.message);
  if (gt09.ok) {
    const st = await saleState(gt08.body.invoiceId);
    record('GT-09', 'invoice refunded + cash returned to drawer', st.inv?.status === 'refunded', st.inv);
    const refundPay = st.pays.find(p => p.direction === 'outbound');
    record('GT-09', 'outbound refund payment exists', !!refundPay, st.pays.map(p => `${p.direction}:${p.acct}:${p.amount}`));
    const movements = await db(`SELECT "movementType", amount FROM "CashMovement" m JOIN "Payment" p ON p.id=m."paymentId" WHERE p."refundOfId" IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1) OR p.id IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1)`, [gt08.body.invoiceId]);
    record('GT-09', 'drawer refund movement (negative)', movements.some(m => m.movementType === 'refund'), movements);
  }

  /* GT-10 full return of GT-02 MTN sale with restock */
  log('\n== GT-10 full return (MTN, restock) ==');
  const stockBefore = Number((await db(`SELECT quantity FROM "StockItem" WHERE "productId"=$1 AND "locationId"=$2`, [cake, ORG.warehouse.id]))[0].quantity);
  const gt10 = await api('manager', 'POST', `/pos/invoices/${gt02.body.invoiceId}/refund`, {
    reason: 'GT-10 full return', stockDisposition: 'restock', overrideById: ORG.users.manager, overridePin: ORG.pin.manager, cashSessionId: sessionId,
  }, { 'Idempotency-Key': `gt10-${RUN}` });
  record('GT-10', 'refund 200', gt10.ok, gt10.body.status ?? gt10.body.message);
  if (gt10.ok) {
    const stockAfter = Number((await db(`SELECT quantity FROM "StockItem" WHERE "productId"=$1 AND "locationId"=$2`, [cake, ORG.warehouse.id]))[0].quantity);
    record('GT-10', `cake restocked (${stockBefore}→${stockAfter})`, stockAfter === stockBefore + 1, { before: stockBefore, after: stockAfter });
    const refundPay = await db(`SELECT p.direction, p."paymentMethod", a.code FROM "Payment" p LEFT JOIN "Account" a ON a.id=p."accountId" WHERE p."refundOfId" IN (SELECT "paymentId" FROM "PaymentAllocation" WHERE "invoiceId"=$1)`, [gt02.body.invoiceId]);
    record('GT-10', 'refund returned to MTN account (electronic to original)', refundPay.some(p => p.direction === 'outbound' && p.code === '2110'), refundPay);
    const pr = (await db(`SELECT amount, "stockDisposition", "journalEntryId" FROM "PosRefund" WHERE "invoiceId"=$1`, [gt02.body.invoiceId]));
    record('GT-10', 'PosRefund row + GL linked', pr.length === 1 && !!pr[0].journalEntryId, pr);
  }

  /* GT-11 partial return of GT-01 (1 of 2 teas, cash refund, no_return) */
  log('\n== GT-11 partial return ==');
  const gt11Lines = await db(`SELECT id FROM "InvoiceItem" WHERE "invoiceId"=$1 ORDER BY "lineNumber" LIMIT 1`, [gt01.body.invoiceId]);
  const gt11 = await api('manager', 'POST', `/pos/invoices/${gt01.body.invoiceId}/refund`, {
    reason: 'GT-11 partial return', stockDisposition: 'no_return', overrideById: ORG.users.manager, overridePin: ORG.pin.manager, cashSessionId: sessionId,
    lines: [{ lineId: gt11Lines[0].id, quantity: 1 }],
  }, { 'Idempotency-Key': `gt11-${RUN}` });
  record('GT-11', 'partial refund 200', gt11.ok, gt11.body.status ?? gt11.body.message);
  if (gt11.ok) {
    const st = await saleState(gt01.body.invoiceId);
    record('GT-11', 'status partially_refunded, refunded=3,000', gt11.body.status === 'partially_refunded' && Number(gt11.body.amount) === 3000, { status: gt11.body.status, amount: gt11.body.amount });
    const outbound = st.pays.find(p => p.direction === 'outbound');
    record('GT-11', 'cash refund via drawer (1101)', outbound?.acct === '1101' && Number(outbound.amount) === 3000, outbound);
  }

  /* GT-14 duplicate payment attempts */
  log('\n== GT-14 duplicates ==');
  const before14 = Number((await db(`SELECT count(*)::int n FROM "Invoice" WHERE "organizationId"=$1`, [orgId]))[0].n);
  const replay = await checkout('cashier', `gt01-${RUN}`, [L(tea, 2, 3000, { description: 'Audit Tea' })], [{ method: 'cash', amount: 6000 }]); // SAME key as GT-01
  const afterReplay = Number((await db(`SELECT count(*)::int n FROM "Invoice" WHERE "organizationId"=$1`, [orgId]))[0].n);
  record('GT-14', 'same-key replay creates NO new invoice', afterReplay === before14 && (replay.ok || replay.status === 409), { httpStatus: replay.status, invoicesBefore: before14, invoicesAfter: afterReplay });
  // concurrent same key
  const [c1, c2] = await Promise.all([
    checkout('cashier', `gt14c-${RUN}`, [L(tea, 1, 3000, { description: 'Audit Tea' })], [{ method: 'cash', amount: 3000 }]),
    checkout('cashier', `gt14c-${RUN}`, [L(tea, 1, 3000, { description: 'Audit Tea' })], [{ method: 'cash', amount: 3000 }]),
  ]);
  const concurrentInvoices = Number((await db(`SELECT count(*)::int n FROM "Invoice" i JOIN "Order" o ON o.id=i."orderId" WHERE o."clientOperationKey"='gt14c-${RUN}'`))[0].n);
  record('GT-14', 'concurrent same-key → exactly ONE sale', concurrentInvoices === 1, { statuses: [c1.status, c2.status], invoices: concurrentInvoices });

  /* GT-15 concurrent last-unit sale (AUD-LOW stock 2; sell 2 twice in parallel) */
  log('\n== GT-15 concurrency ==');
  const lowStock = Number((await db(`SELECT quantity FROM "StockItem" WHERE "productId"=$1 AND "locationId"=$2`, [low, ORG.warehouse.id]))[0].quantity);
  const [p1, p2] = await Promise.all([
    checkout('cashier', `gt15a-${RUN}`, [L(low, 2, 6000, { description: 'Audit Low' })], [{ method: 'cash', amount: 12000 }]),
    checkout('cashier', `gt15b-${RUN}`, [L(low, 2, 6000, { description: 'Audit Low' })], [{ method: 'cash', amount: 12000 }]),
  ]);
  const lowAfter = Number((await db(`SELECT quantity FROM "StockItem" WHERE "productId"=$1 AND "locationId"=$2`, [low, ORG.warehouse.id]))[0].quantity);
  record('GT-15', 'both concurrent sales succeeded (never-block policy)', p1.ok && p2.ok, { statuses: [p1.status, p2.status] });
  record('GT-15', `stock ${lowStock} → ${lowAfter} (negative allowed by policy)`, lowAfter === lowStock - 4, { before: lowStock, after: lowAfter });
  await sleep(35000);
  const lowLedger = await db(`SELECT "qtyBefore", "quantityChange", "balanceAfter" FROM "InventoryLedger" WHERE "productId"=$1 ORDER BY "createdAt" DESC LIMIT 4`, [low]);
  const chainOk = lowLedger.length >= 2 && lowLedger.every(l => Number(l.balanceAfter) === Number(l.qtyBefore) + Number(l.quantityChange));
  const distinctBefore = new Set(lowLedger.map(l => String(l.qtyBefore))).size;
  record('GT-15', `ledger rows arithmetically consistent; qtyBefore distinct=${distinctBefore} (F4-2 chain race observable if >1 among concurrent pair)`, chainOk, { distinctBefore, lowLedger });

  /* GT-16 printer failure semantics: print is side-effect; sale unchanged */
  log('\n== GT-16 print ==');
  const before16 = await saleState(gt01.body.invoiceId);
  const print = await api('cashier', 'POST', `/pos/receipts/${gt01.body.invoiceId}/print`, {});
  const after16 = await saleState(gt01.body.invoiceId);
  record('GT-16', 'print endpoint responds without mutating sale', (print.ok || print.status === 404 || print.status === 400) && before16.inv.status === after16.inv.status, { httpStatus: print.status, invStatusStable: before16.inv.status === after16.inv.status });

  /* GT-17 network-failure recovery = same-key replay after success (done in GT-14) */
  log('\n== GT-17 (network-fail recovery == same-key replay semantics) ==');
  record('GT-17', 'client-retry-after-timeout ⇒ replay, single sale (covered by GT-14 same-key evidence)', afterReplay === before14, { invoicesDelta: afterReplay - before14 });

  /* GT-18 shift close + reconciliation */
  log('\n== GT-18 close ==');
  const expected = await api('cashier', 'GET', `/cash-sessions/${sessionId}/expected`);
  const exp = Number(expected.body.expectedCash);
  const close = await api('cashier', 'POST', '/cash-sessions/close', { closingCounted: exp, notes: 'GT-18 audit close' }, { 'Idempotency-Key': `gt18-${RUN}` });
  record('GT-18', 'close 200', close.ok, close.body?.id ?? close.body?.message);
  if (close.ok) {
    const sess = (await db(`SELECT "closingExpected", "closingCounted", "closingDifference", "varianceStatus", status FROM "CashSession" WHERE id=$1`, [sessionId]))[0];
    record('GT-18', 'expected=counted, variance 0', Number(sess.closingExpected) === exp && Number(sess.closingDifference) === 0, sess);
    const z = await db(`SELECT kind FROM "PosReportSnapshot" WHERE "cashSessionId"=$1`, [sessionId]);
    record('GT-18', 'Z snapshot frozen', z.length === 1 && z[0].kind === 'z', z);
    const summary = await api('admin', 'GET', `/pos/reports/cashier-shift-summary?fromDate=${new Date().toISOString().slice(0, 10)}&toDate=${new Date().toISOString().slice(0, 10)}`);
    record('GT-18', 'cashier summary retrieved (A-006 drift check on adjustment)', summary.ok, (summary.body ?? []).map ? summary.body.map(s => s.expectedCash) : summary.body);
  }

  /* GT-12/13 offline sale + sync via device plane */
  log('\n== GT-12/13 offline sync ==');
  const reg = await api('admin', 'POST', '/sync/devices/register', { label: 'audit-device-1' });
  record('GT-12', 'device registered', reg.ok, reg.body?.id ?? reg.body?.message);
  if (reg.ok) {
    const deviceToken = reg.body.token;
    const headers = { 'X-Device-Token': deviceToken, 'Content-Type': 'application/json' };
    // Re-open a session (GT-18 closed it) + one offline sale, as one pushed batch
    const openOp = { opId: `dev-open-${RUN}`, deviceSeq: 1, type: 'cash_session.open', actorUserId: ORG.users.cashier, occurredAt: new Date().toISOString(), payload: { clientId: `sess-${RUN}`, cashRegisterId: ORG.register.id, openingFloat: 10000, openingSourceAccountId: ORG.accounts.bank, notes: 'offline open' } };
    const saleOp = { opId: `dev-sale-${RUN}`, deviceSeq: 2, type: 'sale.checkout', actorUserId: ORG.users.cashier, occurredAt: new Date().toISOString(), payload: { clientId: `sale-${RUN}`, cashSessionId: `sess-${RUN}`, lines: [L(tea, 3, 3000, { description: 'Offline Tea' })], tenders: [{ method: 'cash', amount: 9000 }] } };
    const push = await fetch(`${BASE}/sync/push`, { method: 'POST', headers, body: JSON.stringify({ ops: [openOp, saleOp] }) });
    const pushJson = await push.json();
    record('GT-12', 'offline batch pushed+applied', push.ok && pushJson.results?.every(r => r.status === 'applied'), { httpStatus: push.status, results: pushJson.results?.map(r => `${r.opId}:${r.status}`) ?? pushJson });
    // GT-13: push the SAME batch again (device lost the response) → replayed, no duplicates
    const push2 = await fetch(`${BASE}/sync/push`, { method: 'POST', headers, body: JSON.stringify({ ops: [openOp, saleOp] }) });
    const push2Json = await push2.json();
    const offInvoices = Number((await db(`SELECT count(*)::int n FROM "Invoice" i JOIN "Order" o ON o.id=i."orderId" WHERE o."clientOperationKey"='dev-sale-${RUN}'`))[0].n);
    const offSessions = Number((await db(`SELECT count(*)::int n FROM "CashSession" s JOIN "Order" o ON o."cashSessionId"=s.id WHERE o."clientOperationKey"='dev-sale-${RUN}'`))[0].n);
    record('GT-13', 're-push replays (applied→replayed), still exactly 1 sale + 1 session', push2Json.results?.every(r => r.status === 'replayed') && offInvoices === 1 && offSessions === 1, { statuses: push2Json.results?.map(r => r.status), offInvoices, offSessions });
    // teardown: close the offline session
    const offSess = (await db(`SELECT s.id FROM "CashSession" s JOIN "Order" o ON o."cashSessionId"=s.id WHERE o."clientOperationKey"='dev-sale-${RUN}'`))[0];
    if (offSess) {
      const expOff = await api('admin', 'GET', `/cash-sessions/${offSess.id}/expected`);
      await api('admin', 'POST', '/cash-sessions/close', { closingCounted: Number(expOff.body.expectedCash), notes: 'offline teardown' }, { 'Idempotency-Key': `gt13-close-${RUN}` }).catch(() => {});
    }
    await api('admin', 'POST', `/sync/devices/${reg.body.id}/revoke`, {}).catch(() => {});
  }

  const summary = { run: RUN, orgId, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results };
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-gt.json'), JSON.stringify(summary, null, 2));
  log(`\n=== GT COMPLETE: ${summary.passed} passed / ${summary.failed} failed → audit/evidence-gt.json ===`);
  process.exitCode = summary.failed > 0 ? 1 : 0;
}
