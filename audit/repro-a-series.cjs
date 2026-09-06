/**
 * PHASE 14 — A-series live reproduction driver.
 * Runs against the LIVE API (http://localhost:3001) inside the ISOLATED audit org.
 * Captures request → response → DB → GL → inventory → receipt → audit evidence.
 * NO production code is modified. NO remediation performed.
 *
 * Usage: node audit/repro-a-series.cjs <orgFile>
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));

const BASE = 'http://localhost:3001/api/v1';
const CONN = 'postgresql://cafe-pos:cafe-pos@localhost:5432/cafe-pos';
const evidence = [];
let ORG;

function log(...a) { console.log(...a); }
async function capture(step, data) { evidence.push({ step, at: new Date().toISOString(), ...data }); log(`  [capture] ${step}`); }

async function api(token, method, p, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
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

async function login(email, password) {
  const r = await api(null, 'POST', '/auth/login', { email, password, organizationCode: ORG.code });
  if (!r.ok) throw new Error(`login failed ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

main();
async function main() {
  const orgFile = process.argv[2];
  if (!orgFile) throw new Error('Usage: node audit/repro-a-series.cjs <orgFile>');
  ORG = JSON.parse(fs.readFileSync(path.join(process.cwd(), orgFile), 'utf8'));
  if (!ORG.code) ORG.code = (await db(`SELECT code FROM "Organization" WHERE id=$1`, [ORG.orgId]))[0].code;
  const orgId = ORG.orgId;
  const RUN = String(Date.now());
  const emails = {};
  for (const u of await db(`SELECT id, email FROM "User" WHERE "organizationId"=$1`, [orgId])) emails[u.id] = u.email;

  log(`=== A-SERIES REPRO in org ${orgId} ===`);

  // Admin + cashier sessions
  const admin = await login(emails[ORG.users.admin], ORG.passwords.admin);
  const cashier = await login(emails[ORG.users.cashier], ORG.passwords.cashier);
  capture('sessions', { adminUserId: ORG.users.admin, cashierUserId: ORG.users.cashier, adminToken: 'Bearer ' + admin.accessToken.slice(0, 12) + '…' });

  // Verify cashier permissions are exactly the seeded Cashier set (baseline)
  const me = await api(cashier.accessToken, 'GET', '/auth/me');
  capture('cashier-me', { permissions: me.body.permissions ?? me.body.user?.permissions });

  /* ============ A-001 (P0): store-credit minting by cashier ============ */
  log('\n--- A-001: cashier mints store credit (partner:read only) ---');
  const a1 = {};
  // 1a. Cashier opens the shift (float funded from the audit bank account)
  const open = await api(cashier.accessToken, 'POST', '/cash-sessions/open', { cashRegisterId: ORG.register.id, openingFloat: 50000, openingSourceAccountId: ORG.accounts.bank, notes: 'audit opening float' }, { 'Idempotency-Key': `a001-open-${orgId}-${RUN}` });
  a1.openShift = { status: open.status, sessionId: open.body.id ?? open.body?.data?.id };
  const sessionId = open.body.id ?? open.body?.data?.id;
  capture('a001-open-shift', { httpStatus: open.status, sessionId });

  // 1a-NEW. Document the notes-500 crash on the mint endpoint itself (bonus finding)
  const mintNotes = await api(cashier.accessToken, 'POST', '/pos/loyalty/credit/issue', { partnerId: ORG.creditCustomer, amount: 1000, source: 'cashier_test', notes: 'A-001 notes-500 probe' });
  a1.mintWithNotes = { status: mintNotes.status, ok: mintNotes.ok, error: mintNotes.body.name, message: (mintNotes.body.message || '').split('\n')[0] };
  capture('a001-notes-crash', { httpStatus: mintNotes.status, prismaError: mintNotes.body.name === 'PrismaClientValidationError' });

  // 1b. Cashier MINTS credit (the P0) — without notes (the working path)
  const mint = await api(cashier.accessToken, 'POST', '/pos/loyalty/credit/issue', { partnerId: ORG.creditCustomer, amount: 100000, source: 'cashier_test' });
  a1.mint = { status: mint.status, ok: mint.ok, body: mint.body };
  capture('a001-mint', { request: 'POST /pos/loyalty/credit/issue {amount:100000}', response: mint.body, httpStatus: mint.status });

  // 1c. Verify DB state: StoreCredit balance + ledger row; NO GL; NO audit; NO payment
  const sc = await db(`SELECT balance, "isActive" FROM "StoreCredit" WHERE "organizationId"=$1 AND "partnerId"=$2`, [orgId, ORG.creditCustomer]);
  const scl = await db(`SELECT delta, "balanceAfter", reason, "documentId" FROM "StoreCreditLedger" WHERE "organizationId"=$1 ORDER BY "createdAt" DESC LIMIT 3`, [orgId]);
  const glCount = await db(`SELECT count(*)::int n FROM "JournalEntry" WHERE "organizationId"=$1`, [orgId]);
  const auditCount = await db(`SELECT count(*)::int n FROM "AuditLog" WHERE "organizationId"=$1 AND entity ILIKE '%loyalty%' OR ("organizationId"=$1 AND "newValues"::text ILIKE '%store%credit%')`, [orgId]);
  a1.dbState = { storeCredit: sc, ledger: scl, glEntries: glCount[0].n, loyaltyAuditRows: auditCount[0].n };
  capture('a001-dbstate', a1.dbState);

  // 1d. THE MONEY TEST: cashier spends the minted credit on a REAL sale (goods leave the cafe)
  if (mint.ok) {
    const spend = await api(cashier.accessToken, 'POST', '/pos/checkout', {
      partnerId: ORG.creditCustomer,
      lines: [{ productId: ORG.products['AUD-CAKE'], description: 'Audit Cake', quantity: 2, unitPrice: 8000 }],
      tenders: [{ method: 'store_credit', amount: 16000 }],
      cashSessionId: sessionId,
    }, { 'Idempotency-Key': `a001-spend-${orgId}-${RUN}` });
    a1.spendSale = { status: spend.status, ok: spend.ok, invoiceNumber: spend.body.invoiceNumber, invoiceId: spend.body.invoiceId };
    capture('a001-spend', { request: 'POST /pos/checkout store_credit 16000', response: { invoiceNumber: spend.body.invoiceNumber, invoiceId: spend.body.invoiceId, paymentIds: spend.body.paymentIds }, httpStatus: spend.status });
    if (spend.ok) {
      // GL legs of the sale + payment
      const gl = await db(`SELECT a.code, sum(l.debit) dr, sum(l.credit) cr FROM "JournalEntry" je JOIN "JournalLine" l ON l."journalEntryId"=je.id JOIN "Account" a ON a.id=l."accountId" WHERE je."organizationId"=$1 GROUP BY 1 ORDER BY 1`, [orgId]);
      const inv = await db(`SELECT "invoiceNumber", status, "settlementStatus", "totalAmount", "amountResidual" FROM "Invoice" WHERE "organizationId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [orgId]);
      const scAfter = await db(`SELECT balance FROM "StoreCredit" WHERE "organizationId"=$1 AND "partnerId"=$2`, [orgId, ORG.creditCustomer]);
      const stock = await db(`SELECT quantity FROM "StockItem" WHERE "organizationId"=$1 AND "productId"=$2`, [orgId, ORG.products['AUD-CAKE']]);
      a1.spendDb = { invoice: inv[0], storeCreditBalanceAfter: Number(scAfter[0].balance), cakeStockAfter: Number(stock[0].quantity), glByAccount: gl };
      capture('a001-spend-db', a1.spendDb);
    }
  }
  // 1e. DID ANY AUDIT ROW GET WRITTEN FOR THE MINT?
  const auditAll = await db(`SELECT entity, action, "createdAt" FROM "AuditLog" WHERE "organizationId"=$1 ORDER BY "createdAt"`, [orgId]);
  a1.auditRows = auditAll;
  capture('a001-audit', { count: auditAll.length, rows: auditAll.slice(0, 10) });
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a001.json'), JSON.stringify(a1, null, 2));
  log('A-001 evidence → audit/evidence-a001.json');

  /* ============ A-002 (P1): line-discount reason 400 ============ */
  log('\n--- A-002: line discount without order-level reason ---');
  const a2 = {};
  // quote first (Terminal path requires quote; the 400 fires at quote's assertPricingAuthority)
  const quote = await api(cashier.accessToken, 'POST', '/pos/orders/quote', {
    lines: [{ productId: ORG.products['AUD-TEA'], description: 'Audit Tea', quantity: 1, unitPrice: 3000, discountPercent: 10, discountType: 'percentage' }],
    transactionDiscountPercent: 0, transactionDiscountType: 'percentage',
  });
  a2.quoteWithLineDiscountNoReason = { status: quote.status, ok: quote.ok, body: quote.body };
  capture('a002-quote', { httpStatus: quote.status, response: quote.body });

  // With an order-level reason on the transaction discount input (0%)? The UI collects reason
  // only for tx discounts. Line-only is the failing case. Also try settle via checkout:
  const sale = await api(cashier.accessToken, 'POST', '/pos/checkout', {
    lines: [{ productId: ORG.products['AUD-TEA'], description: 'Audit Tea', quantity: 1, unitPrice: 3000, discountPercent: 10, discountType: 'percentage' }],
    tenders: [{ method: 'cash', amount: 2700 }],
    cashSessionId: sessionId,
  }, { 'Idempotency-Key': `a002-sale-${orgId}-${RUN}` });
  a2.checkoutWithLineDiscount = { status: sale.status, ok: sale.ok, body: sale.body };
  capture('a002-checkout', { httpStatus: sale.status, response: sale.body });

  // Control: SAME discount with a line reason present should pass (validates root cause)
  const saleCtl = await api(cashier.accessToken, 'POST', '/pos/checkout', {
    lines: [{ productId: ORG.products['AUD-TEA'], description: 'Audit Tea', quantity: 1, unitPrice: 3000, discountPercent: 10, discountType: 'percentage', discountReason: 'staff' }],
    tenders: [{ method: 'cash', amount: 2700 }],
    cashSessionId: sessionId,
  }, { 'Idempotency-Key': `a002-ctl-${orgId}-${RUN}` });
  a2.controlWithLineReason = { status: saleCtl.status, ok: saleCtl.ok, invoiceNumber: saleCtl.body.invoiceNumber };
  capture('a002-control', { httpStatus: saleCtl.status, response: { invoiceNumber: saleCtl.body.invoiceNumber } });
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a002.json'), JSON.stringify(a2, null, 2));

  /* ============ A-003 (P1): retail barcode /pos/lookup array ============ */
  log('\n--- A-003: /pos/lookup response shape ---');
  const a3 = {};
  const lookup = await api(cashier.accessToken, 'GET', `/pos/lookup?sku=AUD-TEA`);
  a3.lookupResponse = { status: lookup.status, isArray: Array.isArray(lookup.body), body: lookup.body };
  capture('a003-lookup', { isArray: Array.isArray(lookup.body), bodyType: typeof lookup.body, body: lookup.body });
  // Frontend check is `product?.id` — on an array that's undefined → dead path. Static, but confirm shape.
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a003.json'), JSON.stringify(a3, null, 2));

  /* ============ A-005 (P1): manager override brute-force ============ */
  log('\n--- A-005: override verify brute-force window ---');
  const a5 = {};
  // Fire 12 wrong-PIN verifies inside the throttle window (10/min) — expect 10 pass through,
  // NO lockout, NO audit of failures. Use distinct attempts but stay under the global throttle.
  const attempts = [];
  for (let i = 0; i < 10; i++) {
    const r = await api(cashier.accessToken, 'POST', '/pos/override/verify', { email: emails[ORG.users.manager], pin: `0000`, overrideKind: 'discount' });
    attempts.push({ i, status: r.status, message: Array.isArray(r.body?.message) ? r.body.message[0] : (r.body?.message || r.body) });
  }
  a5.tenWrongPins = attempts;
  const loginAttempts = await db(`SELECT count(*)::int n FROM "LoginAttempt" WHERE "organizationId"=$1 AND email=$2 AND success=false`, [orgId, emails[ORG.users.manager]]);
  const auditOverride = await db(`SELECT action, "newValues" FROM "AuditLog" WHERE "organizationId"=$1 AND action='login' AND "newValues"::text ILIKE '%override%' ORDER BY "createdAt" DESC LIMIT 12`, [orgId]);
  a5.dbState = { managerLoginAttemptRows: loginAttempts[0].n, overrideAuditRows: auditOverride.length, overrideAudit: auditOverride };
  capture('a005-bruteforce', { attempts: attempts.map(a => a.status), lockoutCounter: loginAttempts[0].n, auditedFailures: auditOverride.length });
  // Confirm a CORRECT pin still works right after 10 failures (no lockout engaged)
  const good = await api(cashier.accessToken, 'POST', '/pos/override/verify', { email: emails[ORG.users.manager], pin: ORG.pin.manager, overrideKind: 'discount' });
  a5.correctPinAfterFailures = { status: good.status, ok: good.ok, managerId: good.body.managerId ? 'present' : undefined };
  capture('a005-good-pin', { httpStatus: good.status, unlocked: !!good.body.managerId });
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a005.json'), JSON.stringify(a5, null, 2));

  /* ============ A-006 (P1): cashier-shift-summary expected drift ============ */
  log('\n--- A-006: adjustment movement omitted from cashier-shift-summary ---');
  const a6 = {};
  // Record an adjustment movement into the OPEN session. The SESSION OWNER (cashier)
  // must be the caller; manager approval rides via approvedById + managerPin.
  if (!sessionId) throw new Error('no open session for A-006');
  const adj = await api(cashier.accessToken, 'POST', '/cash-sessions/movement', {
    sessionId, movementType: 'adjustment', amount: 5000, reason: 'A-006 test adjustment',
    counterpartAccountId: ORG.accounts.shortOver,
    approvedById: ORG.users.manager, managerPin: ORG.pin.manager,
  }, { 'Idempotency-Key': `a006-adj-${orgId}-${RUN}` });
  a6.ownerEnforcement = { note: 'admin-as-caller was 403-blocked (good control) — re-run as cashier owner with manager approval' };
  a6.adjustment = { status: adj.status, ok: adj.ok, body: adj.body };
  capture('a006-adjustment', { httpStatus: adj.status, response: adj.body });

  if (adj.ok) {
    // Close-read: expected (reconciliation) vs cashier-shift-summary expected
    const recon = await api(admin.accessToken, 'GET', `/cash-sessions/${sessionId}/expected`);
    const summary = await api(admin.accessToken, 'GET', `/pos/reports/cashier-shift-summary?cashSessionId=${sessionId}`);
    a6.reconciliationExpected = { status: recon.status, expectedCash: recon.body.expectedCash ?? recon.body.totals?.expectedCash ?? recon.body };
    a6.cashierShiftSummary = { status: summary.status, body: summary.body };
    capture('a006-compare', { reconciliation: a6.reconciliationExpected, summary: (summary.body.totals ?? summary.body) });
  }
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a006.json'), JSON.stringify(a6, null, 2));

  /* ============ A-007 (downgraded): PIN → own password rotation ============ */
  log('\n--- A-007: change-password authenticated by PIN (SELF-SERVICE) ---');
  const a7 = {};
  // DTO: { currentPin, newPassword } — acts on user.sub (the JWT holder), NOT an arbitrary userId.
  // Repro: the CASHIER rotates their own back-office password using ONLY their 4-digit PIN.
  const chg = await api(cashier.accessToken, 'POST', '/pos/auth/change-password', {
    currentPin: ORG.pin.cashier, newPassword: 'Rotated@789',
  });
  a7.changeManagerPasswordByPin = { status: chg.status, ok: chg.ok, body: chg.body };
  capture('a007-change-password', { httpStatus: chg.status, response: chg.body });
  // If it succeeded, prove rotation: login with the NEW password; then restore.
  if (chg.ok) {
    const relogin = await login(emails[ORG.users.cashier], 'Rotated@789');
    a7.rotationLogin = { success: !!relogin.accessToken, sameUser: relogin.user?.id === ORG.users.cashier };
    const restore = await api(cashier.accessToken, 'POST', '/pos/auth/change-password', { currentPin: ORG.pin.cashier, newPassword: ORG.passwords.cashier });
    a7.restored = { status: restore.status };
    capture('a007-rotation', { loginWithNewPassword: a7.rotationLogin, restored: restore.status });
  }
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a007.json'), JSON.stringify(a7, null, 2));

  /* ============ A-004 (P1): cafe offline queue wiring (static) ============ */
  log('\n--- A-004: recorded from static evidence (UI mount) — see evidence pack ---');
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-a004.json'), JSON.stringify({
    finding: 'OfflineIndicator (mounts useOfflineQueue — health probe + auto-replay) is commented out of cafe Terminal.tsx:1341',
    staticEvidence: { terminal: 'apps/web/src/pages/pos/Terminal.tsx:1341 // rightExtras={<OfflineIndicator />}', retail: 'apps/web/src/pages/pos/RetailTerminal.tsx:661 (mounted)' },
    repro: 'Browser-level; not reproducible over API. Status carried from Phase 1/8 static evidence.',
  }, null, 2));

  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-captures.json'), JSON.stringify(evidence, null, 2));
  log('\n=== A-SERIES COMPLETE — evidence files in audit/ ===');
}
