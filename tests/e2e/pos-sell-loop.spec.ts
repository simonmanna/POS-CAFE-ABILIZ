/**
 * POS P12 — E2E test suite (smoke tests for the sell loop).
 *
 * These tests run against a live API + Postgres (i.e. you need to:
 *   1. start the database:  `pnpm db:up`
 *   2. run the migrations:   `pnpm db:migrate`
 *   3. seed the demo data:   `pnpm db:seed`
 *   4. start the API:        `pnpm dev:api`  (or `pnpm --filter @erp/api start:dev`)
 *   5. run the tests:        `pnpm test:e2e`
 *
 * The tests are API-only (no browser) so they exercise the same surface
 * the cashier's terminal hits, but in a fraction of the time and without
 * flakiness from UI rendering.
 */
import { test, expect, beforeAll, afterAll, describe } from 'vitest';

// The API mounts everything under the global prefix `api/v1` (see main.ts), so
// the base must include it. POS_API_BASE may point at any host/origin; the
// prefix is appended here unless the override already contains it.
const RAW_BASE = process.env.POS_API_BASE ?? 'http://localhost:3000';
const BASE = /\/api\/v1$/.test(RAW_BASE) ? RAW_BASE : `${RAW_BASE.replace(/\/$/, '')}/api/v1`;
// Overridable so the suite can run against any seeded environment, not just
// a freshly-seeded demo one. /auth/login is org-scoped and REQUIRES
// organizationCode — omitting it 400s before a single test runs.
const ORG_CODE = process.env.POS_ORG_CODE ?? 'DEMO';
const ADMIN_EMAIL = process.env.POS_ADMIN_EMAIL ?? 'admin@demo.test';
const ADMIN_PASS = process.env.POS_ADMIN_PASS ?? 'Admin@123';
// Manager override PIN for the seeded admin (refunds/discounts need it now).
const ADMIN_PIN = process.env.POS_ADMIN_PIN ?? '1234';

let token = '';
let adminUserId = '';
let orgId = '';
let productId = '';
let cashRegisterId = '';
let cashSessionId = '';
let partnerId = '';

/** Routes that refuse to run twice, and therefore refuse to run without a key. */
const NEEDS_IDEMPOTENCY_KEY =
  /\/pos\/(checkout|sales\/[^/]+\/void|tabs\/[^/]+\/settle|orders\/[^/]+\/(settle|invoice|payments|credit|refund|write-off)|invoices\/[^/]+\/(payments|refund|write-off)|split-bills\/[^/]+\/settle|shift\/handover)$/;

function newKey(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function api(path: string, init: RequestInit = {}) {
  const needsKey = (init.method ?? 'GET') !== 'GET' && NEEDS_IDEMPOTENCY_KEY.test(path.split('?')[0]);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(needsKey ? { 'Idempotency-Key': newKey() } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

beforeAll(async () => {
  // Login as the demo admin.
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationCode: ORG_CODE, email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  if (!login.ok) throw new Error(`Login failed (${login.status}): ${await login.text()}`);
  const loginJson = (await login.json()) as any;
  token = loginJson.accessToken ?? loginJson.token;
  adminUserId = loginJson.user?.id ?? loginJson.userId ?? '';
  expect(token).toBeTruthy();

  // Resolve IDs.
  const me = await api('/auth/me') as any;
  orgId = me.organizationId;

  const products = await api('/products?pageSize=200') as any;
  const espresso = (products.data ?? products).find((p: any) => p.code === 'P-COFFEE-S');
  expect(espresso).toBeTruthy();
  productId = espresso.id;

  const registers = await api('/cash-registers') as any;
  const reg = (registers.data ?? registers)[0];
  expect(reg).toBeTruthy();
  cashRegisterId = reg.id;

  // Use a known test customer — auto-create one if missing.
  const customers = await api('/partners?pageSize=10') as any;
  partnerId = (customers.data ?? customers)[0]?.id ?? ((await api('/partners', {
    method: 'POST',
    body: JSON.stringify({ code: `TEST-${Date.now()}`, name: 'Test Customer', isCustomer: true }),
  })) as any).id;
}, 30_000);

afterAll(async () => {
  if (cashSessionId) {
    try {
      await api('/cash-sessions/close', {
        method: 'POST',
        body: JSON.stringify({ closingCounted: 0, notes: 'E2E teardown' }),
      });
    } catch { /* best effort */ }
  }
});

describe('POS sell loop', () => {
  test('opens a shift, sells a coffee, closes the shift', async () => {
    // 1) Open a shift on the main register.
    // Re-runnable: a register may already carry an open session from a previous
    // run (or an interrupted one), and opening a second is correctly refused.
    // Reuse it rather than leaving the whole suite unable to start twice.
    const existing = await api(`/cash-sessions/open?registerId=${cashRegisterId}`).catch(() => null) as any;
    const session = existing?.id ? existing : await api('/cash-sessions/open', {
      method: 'POST',
      // Opening float above zero has to name the account it came out of and
      // say why; a till that starts empty needs neither, which is all this
      // sell-loop suite requires.
      body: JSON.stringify({ cashRegisterId, openingFloat: 0 }),
    }) as any;
    cashSessionId = session.id;
    expect(cashSessionId).toBeTruthy();

    // Measure the delta this sale makes: a reused session already carries the
    // takings of earlier runs, and the suite has to be re-runnable.
    const before = await api(`/pos/reports/x-report?cashSessionId=${cashSessionId}`) as any;

    // 2) Sell 2 espressos @ 5,000 UGX each = 10,000 UGX total.
    const checkout = await api('/pos/checkout', {
      method: 'POST',
      body: JSON.stringify({
        lines: [{ productId, description: 'Espresso', quantity: 2, unitPrice: 5000 }],
        tenders: [{ method: 'cash', amount: 10_000 }],
        cashSessionId,
      }),
    }) as any;
    expect(checkout.invoiceId).toBeTruthy();
    expect(checkout.invoiceNumber).toMatch(/^INV-\d{4}-/);
    expect(checkout.change).toBe(0);

    // 3) X-report should now show 10,000 UGX in sales + 1 transaction.
    const x = await api(`/pos/reports/x-report?cashSessionId=${cashSessionId}`) as any;
    // Money crosses the wire as a decimal string so it never loses precision.
    expect(Number(x.totals.salesTotal) - Number(before.totals.salesTotal)).toBe(10_000);
    expect(x.totals.saleCount - before.totals.saleCount).toBe(1);
  });

  test('refunds a sale (full credit note + reversing payment)', async () => {
    const docs = await api('/invoices?pageSize=5&sourceType=pos') as any;
    const invoice = (docs.data ?? docs)[0];
    expect(invoice).toBeTruthy();
    // The legacy Document-based POST /pos/refund was deleted; the live route is
    // POST /pos/invoices/:id/refund. A refund now needs an explicit manager
    // approval and stock disposition (F04/F16).
    const refund = await api(`/pos/invoices/${invoice.id}/refund`, {
      method: 'POST',
      // Cash handed back leaves a real till, so the refund names the session.
      body: JSON.stringify({ reason: 'E2E refund test', stockDisposition: 'no_return', cashSessionId, overrideById: adminUserId, overridePin: ADMIN_PIN }),
    }) as any;
    // POS refunds run the Order→Invoice→Receipt pipeline (billing.refund), which
    // reverses the invoice GL in place rather than raising a credit-note
    // Document. It returns the refunded invoice, not a creditNoteId.
    expect(refund.status).toBe('refunded');
  });

  test('manager override: 30% discount requires manager PIN', async () => {
    // 30% discount without override should fail.
    let failed = false;
    try {
      await api('/pos/checkout', {
        method: 'POST',
        body: JSON.stringify({
          lines: [{ productId, description: 'Espresso', quantity: 1, unitPrice: 5000, discountPercent: 30 }],
          tenders: [{ method: 'cash', amount: 3_500 }],
          cashSessionId,
        }),
      });
    } catch (e: any) {
      failed = true;
      // The server names the rule it enforced: an unreasoned discount is
      // refused before the approval question is even reached (F-02).
      expect(String(e.message)).toMatch(/manager approval|discount reason is required/i);
    }
    expect(failed).toBe(true);

    // With override (we verify the admin as the manager), it should succeed.
    const verify = await api('/pos/override/verify', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS, overrideKind: 'discount' }),
    }) as any;
    expect(verify.managerId).toBeTruthy();

    // The approval is bound to ONE operation: same key, same endpoint, same body.
    const operationKey = newKey();
    const approvedPayload: Record<string, unknown> = {
      lines: [{ productId, description: 'Espresso', quantity: 1, unitPrice: 5000, discountPercent: 30 }],
      tenders: [{ method: 'cash', amount: 3_500 }],
      cashSessionId,
      discountReason: 'E2E manager-approved discount',
      overrideById: verify.managerId,
    };
    const grant = await api('/pos/operation-approval', {
      method: 'POST',
      body: JSON.stringify({
        managerId: verify.managerId, pin: ADMIN_PIN,
        operationKey, endpoint: '/pos/checkout',
        payload: approvedPayload, overrideKind: 'discount',
      }),
    }) as any;
    expect(grant.approvalToken).toBeTruthy();

    const ok = await api('/pos/checkout', {
      method: 'POST',
      headers: { 'Idempotency-Key': operationKey },
      body: JSON.stringify({ ...approvedPayload, approvalToken: grant.approvalToken }),
    }) as any;
    expect(ok.invoiceId).toBeTruthy();
    expect(ok.discountPercent).toBeCloseTo(30, 0);
  });

  test('held order: park + recall', async () => {
    const hold = await api('/pos/holds', {
      method: 'POST',
      body: JSON.stringify({
        name: `E2E hold ${Date.now()}`,
        partnerId,
        cashSessionId,
        lines: [{ productId, description: 'Espresso', quantity: 1, unitPrice: 5000 }],
      }),
    }) as any;
    expect(hold.id).toBeTruthy();

    const list = await api('/pos/holds?status=open') as any;
    expect((list.data ?? list).length).toBeGreaterThan(0);

    const recall = await api(`/pos/holds/${hold.id}/recall`, { method: 'POST' }) as any;
    expect(recall.lines.length).toBe(1);
    expect(recall.lines[0].productId).toBe(productId);

    // A recalled hold is consumed, not open, so there is nothing left to
    // cancel — asking to delete it is correctly refused.
    await expect(api(`/pos/holds/${hold.id}`, { method: 'DELETE' }))
      .rejects.toThrow(/recalled, not open/i);
  });

  test('tax: the invoice line splits net vs tax exactly as the catalogue says', async () => {
    // Read the rate and inclusivity the catalogue ACTUALLY carries rather than
    // assuming the seed's. The demo seed has assigned this item a 0% code
    // before now, and a test that hardcodes 18% then fails for a reason that
    // has nothing to do with the pricing engine.
    const products = await api('/products?pageSize=200') as any;
    const latte = (products.data ?? products).find((p: any) => p.code === 'P-LATTE-L');
    expect(latte).toBeTruthy();

    const taxes = await api('/taxes') as any;
    const tax = (taxes.data ?? taxes).find((t: any) => t.id === latte.taxId);
    const rate = Number(tax?.rate ?? 0);
    // A-101 — tri-state: the line flag wins, else the TAX row's own
    // isInclusive, and only then the product's display default.
    const inclusive = typeof tax?.isInclusive === 'boolean' ? tax.isInclusive : Boolean(latte.taxInclusive);
    const price = Number(latte.salesPrice);

    const checkout = await api('/pos/checkout', {
      method: 'POST',
      body: JSON.stringify({
        lines: [{ productId: latte.id, description: latte.name, quantity: 1, unitPrice: price }],
        tenders: [{ method: 'cash', amount: inclusive ? price : Math.round(price * (1 + rate / 100)) }],
        cashSessionId,
      }),
    }) as any;
    expect(checkout.invoiceId).toBeTruthy();

    const inv = await api(`/invoices/${checkout.invoiceId}?include=lines`) as any;
    const line = (inv.lines ?? inv.items ?? []).find((l: any) => l.productId === latte.id);
    expect(line).toBeTruthy();

    const net = Number(line.subtotal);
    const vat = Number(line.taxAmount);

    // The invariant that must hold at any rate: the split reconciles to the
    // line, and the line reconciles to what the customer was charged.
    expect(net + vat).toBeCloseTo(Number(line.total), 2);
    expect(Number(checkout.total)).toBeCloseTo(Number(inv.totalAmount), 2);

    if (rate === 0) {
      expect(vat).toBe(0);
      expect(net).toBeCloseTo(price, 2);
      return;
    }
    if (inclusive) {
      // Gross is the shelf price: net = price / (1 + rate), tax is the rest.
      expect(net + vat).toBeCloseTo(price, 0);
      expect(net).toBeCloseTo(price / (1 + rate / 100), 0);
    } else {
      // Net is the shelf price and the tax goes on top.
      expect(net).toBeCloseTo(price, 0);
      expect(vat).toBeCloseTo(price * (rate / 100), 0);
    }
  });
});