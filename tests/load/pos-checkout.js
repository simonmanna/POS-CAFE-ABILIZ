/**
 * POS P12 — Load test (k6): concurrent /pos/checkout.
 *
 * Run with:
 *   k6 run --env BASE=http://localhost:3001 --env POS_ORG_CODE=DEMO tests/load/pos-checkout.js
 *
 * Asserts:
 *   - p95 < 800ms at 10 sales/sec for 30s (lunch-peak for a small café)
 *   - 0 failed checkouts (every request carries its own Idempotency-Key, so a
 *     transient blip is retried safely and never double-charges)
 *
 * Prerequisite: API + DB up; `pnpm db:migrate && pnpm db:seed`. The script logs
 * in (organizationCode is required), picks a sellable product, opens a shift on
 * the first register with a zero float when none is open, and card-tenders
 * every sale so the drawer is untouched. Run the reconciliation oracle after
 * load: load must never break the books.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// The API mounts everything under /api/v1; accept a BASE with or without it.
const RAW_BASE = __ENV.BASE || 'http://localhost:3001';
const BASE = /\/api\/v1$/.test(RAW_BASE) ? RAW_BASE : `${RAW_BASE.replace(/\/$/, '')}/api/v1`;
const ORG_CODE = __ENV.POS_ORG_CODE || 'DEMO';
const ADMIN_EMAIL = __ENV.POS_ADMIN_EMAIL || 'admin@demo.test';
const ADMIN_PASS = __ENV.POS_ADMIN_PASS || 'Admin@123';

const checkoutDuration = new Trend('checkout_duration', true);
const checkoutErrors = new Rate('checkout_errors');

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 25,
      maxVUs: 50,
    },
  },
  thresholds: {
    'http_req_duration{name:checkout}': ['p(95)<800'],
    checkout_errors: ['rate==0'],
  },
};

const key = (tag) => `k6-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const json = (token, extra = {}) => ({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra } });

export function setup() {
  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ organizationCode: ORG_CODE, email: ADMIN_EMAIL, password: ADMIN_PASS }), { headers: { 'Content-Type': 'application/json' } });
  if (login.status !== 200 && login.status !== 201) throw new Error(`login failed: ${login.status} ${login.body}`);
  const token = JSON.parse(login.body).accessToken || JSON.parse(login.body).token;

  const products = http.get(`${BASE}/products?pageSize=50`, json(token));
  if (products.status !== 200) throw new Error(`products failed: ${products.status} ${products.body}`);
  const list = JSON.parse(products.body);
  const p = (list.data ?? list).find((x) => Number(x.salesPrice) > 0);
  if (!p) throw new Error('No priced product in the catalog — run pnpm db:seed first');

  const regs = http.get(`${BASE}/cash-registers`, json(token));
  const reg = (JSON.parse(regs.body).data ?? JSON.parse(regs.body))[0];
  if (!reg) throw new Error('No cash register configured');
  const existing = http.get(`${BASE}/cash-sessions/open?registerId=${reg.id}`, json(token));
  let sessionId = existing.status === 200 && existing.body ? (JSON.parse(existing.body) || {}).id : undefined;
  if (!sessionId) {
    const open = http.post(`${BASE}/cash-sessions/open`, JSON.stringify({ cashRegisterId: reg.id, openingFloat: 0 }), json(token, { 'Idempotency-Key': key('open') }));
    if (open.status !== 200 && open.status !== 201) throw new Error(`open shift failed: ${open.status} ${open.body}`);
    sessionId = JSON.parse(open.body).id;
  }
  return { token, productId: p.id, price: Number(p.salesPrice), sessionId };
}

export default function (data) {
  const body = JSON.stringify({
    cashSessionId: data.sessionId,
    lines: [{ productId: data.productId, description: 'Load item', quantity: 1, unitPrice: data.price }],
    tenders: [{ method: 'card', amount: data.price, reference: key('card') }],
  });
  const started = Date.now();
  const res = http.post(`${BASE}/pos/checkout`, body, { tags: { name: 'checkout' }, ...json(data.token, { 'Idempotency-Key': key(`${__VU}-${__ITER}`) }) });
  checkoutDuration.add(Date.now() - started);
  const ok = res.status === 201 || res.status === 200;
  checkoutErrors.add(!ok);
  check(res, {
    'checkout ok': () => ok,
    'has invoiceId': (r) => { try { return !!JSON.parse(r.body).invoiceId; } catch { return false; } },
  });
  sleep(0.05);
}
