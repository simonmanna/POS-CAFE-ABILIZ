/*
 * Demo activity — gives a freshly seeded DEMO organization something to look at:
 * named customers and suppliers, an open till shift and a week of cash sales
 * (real invoices, receipts, stock moves and journal entries, posted through the
 * same /pos/checkout endpoint the terminal uses).
 *
 * Runs inside the API container (Node 20, no dependencies):
 *   docker exec -i pd-api node --input-type=module - < demo-activity.mjs
 *
 * Demo databases only: it writes sales. Partners are matched by code so a
 * re-run adds another batch of sales without duplicating the contacts.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:3000/api/v1';
const ORG = process.env.ORG_CODE ?? 'DEMO';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'admin';
const SALES = Number(process.env.DEMO_SALES ?? 60);
/** The API rejects occurredAt older than 7 days; stay inside that window. */
const DAYS_BACK = 6;

let token = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (x) => (Array.isArray(x) ? x : x?.data ?? []);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Money-moving endpoints require an Idempotency-Key; every call here is distinct.
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const CUSTOMERS = [
  { code: 'DEMO-C01', name: 'Grace Nakato', phone: '+256700100201', membershipLevel: 'gold' },
  { code: 'DEMO-C02', name: 'David Okello', phone: '+256700100202', membershipLevel: 'silver' },
  { code: 'DEMO-C03', name: 'Amina Hassan', phone: '+256700100203', membershipLevel: 'bronze' },
  { code: 'DEMO-C04', name: 'Peter Mugisha', phone: '+256700100204' },
  { code: 'DEMO-C05', name: 'Kampala Tech Hub Ltd', phone: '+256700100205', isCompany: true },
  { code: 'DEMO-C06', name: 'Lakeside Events Ltd', phone: '+256700100206', isCompany: true },
].map((c) => ({ ...c, isCustomer: true }));
const SUPPLIERS = [
  { code: 'DEMO-S01', name: 'Rwenzori Coffee Growers', phone: '+256700100301' },
  { code: 'DEMO-S02', name: 'Fresh Dairy Distributors', phone: '+256700100302' },
  { code: 'DEMO-S03', name: 'Nile Packaging Supplies', phone: '+256700100303' },
  { code: 'DEMO-S04', name: 'City Bakery Wholesale', phone: '+256700100304' },
].map((s) => ({ ...s, isSupplier: true, isCompany: true }));

async function ensurePartners() {
  const existing = new Set(list(await call('GET', '/partners?pageSize=200')).map((p) => p.code));
  let created = 0;
  for (const p of [...CUSTOMERS, ...SUPPLIERS]) {
    if (existing.has(p.code)) continue;
    await call('POST', '/partners', p);
    created++;
  }
  console.log(`partners: ${created} created, ${CUSTOMERS.length + SUPPLIERS.length - created} already present`);
}

async function ensureSession() {
  const register = list(await call('GET', '/cash-registers'))[0];
  if (!register) throw new Error('no cash register — run the seed first');
  const open = await call('GET', `/cash-sessions/open?registerId=${register.id}`).catch(() => null);
  const current = Array.isArray(open) ? open[0] : open;
  if (current?.id) return current.id;
  // Empty opening float: a fresh organization has no funded safe to draw one
  // from, and a float above the drawer's ledger must name its funding account.
  const session = await call('POST', '/cash-sessions/open', {
    cashRegisterId: register.id,
    openingFloat: 0,
    notes: 'Demo shift',
  });
  return session.id;
}

/** A plausible time on a past day: mornings and lunch are busiest. */
function occurredAt(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const hour = pick([7, 8, 8, 9, 9, 10, 12, 12, 13, 13, 15, 16, 17, 18]);
  d.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  // Never in the future (rejected), e.g. "today 18:00" rung up at noon.
  return d.getTime() < Date.now() ? d.toISOString() : new Date(Date.now() - 60_000).toISOString();
}

async function main() {
  token = (await call('POST', '/auth/login', { organizationCode: ORG, email: EMAIL, password: PASSWORD })).accessToken;
  await ensurePartners();
  const cashSessionId = await ensureSession();

  const priceOf = (p) => Number(p.salesPrice ?? p.basePrice ?? p.price ?? 0);
  const products = list(await call('GET', '/products?pageSize=200')).filter((p) => p.isActive !== false && priceOf(p) > 0);
  if (!products.length) throw new Error('no sellable products — run the seed first');

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < SALES; i++) {
    const lines = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => {
      const p = pick(products);
      return { productId: p.id, description: p.name, quantity: 1 + Math.floor(Math.random() * 2), unitPrice: priceOf(p) };
    });
    const total = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    try {
      await call('POST', '/pos/checkout', {
        lines,
        paymentMethod: 'cash',
        amountTendered: total,
        expectedTotal: total,
        cashSessionId,
        occurredAt: occurredAt(i % (DAYS_BACK + 1)),
      });
      ok++;
    } catch (e) {
      failed++;
      if (failed <= 3) console.warn(`sale skipped: ${e.message}`);
    }
    await sleep(150);
  }
  console.log(`sales: ${ok} posted, ${failed} skipped`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
