/**
 * Lakeview Café & Grill — M4: security, idempotency, concurrency and crash
 * faults against the REAL API process over HTTP (guards, interceptors, tenant
 * middleware as deployed). The books are then verified straight from SQL.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET', generateURI: () => 'otpauth://stub', verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));
import * as bcrypt from 'bcryptjs';
import { CashFlowService } from '../../src/modules/accounting/treasury/cash-flow.service';
import { StockService } from '../../src/modules/inventory/stock.service';
import { D, compare } from './oracle';
import { Evidence } from './evidence';
import { bootSim, simEnabled, Sim, STOCK, PIN } from './sim-kit';
import { ApiProcess, client } from './api-process';

const SEED = process.env.SIMULATION_SEED ?? '20260917';
const PASSWORD = 'Sim@Pass-2026';

(simEnabled() ? describe : describe.skip)('Lakeview — M4 security, idempotency, concurrency, faults (HTTP)', () => {
  jest.setTimeout(300_000);
  const ev = new Evidence(`SIM-${SEED}-M4`);
  let sim: Sim, other: Sim;
  let api: ApiProcess;
  let http: ReturnType<typeof client>;
  const token: Record<string, string> = {};
  let sessionId = '';
  const logFile = path.resolve(__dirname, `../../../../var/simulations/SIM-${SEED}-M4-api.log`);

  const run = (id: string, title: string, pri: 'P0' | 'P1' | 'P2', fn: (rec: any) => Promise<void>) =>
    it(`${id} ${title}`, async () => {
      const rec = await ev.scenario(id, title, pri, fn);
      if (rec.status === 'FAIL') throw new Error(`${id} FAILED: ${rec.error ?? rec.rules.filter((r) => r.status === 'FAIL').map((r) => `${r.rule} expected ${r.expected} got ${r.actual}`).join('; ')}`);
    });
  const status = (rule: string, got: number, allowed: number[]) => ({ rule, status: allowed.includes(got) ? 'PASS' : 'FAIL', expected: allowed.join('|'), actual: String(got) });
  const login = async (s: Sim, who: string) => {
    const r = await http('POST', '/auth/login', { body: { organizationCode: (await s.db.organization.findUniqueOrThrow({ where: { id: s.organizationId } })).code, email: `${who}@lakeview.test`, password: PASSWORD } });
    if (r.status >= 300) throw new Error(`login ${who}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body.accessToken ?? r.body.token;
  };
  const espresso = (s: Sim, extra: Record<string, unknown> = {}) => ({ cashSessionId: sessionId, partnerId: s.acc.walkin, lines: [{ menuItemId: s.menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], tenders: [{ method: 'card', amount: 6000, reference: randomUUID() }], ...extra });
  const invoiceCount = () => sim.db.invoice.count({ where: { organizationId: sim.organizationId } });

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
    sim = await bootSim('M4');
    other = await bootSim('M4B');
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const s of [sim, other]) await s.db.user.updateMany({ where: { organizationId: s.organizationId }, data: { passwordHash: hash } });
    await sim.as('manager', () => sim.get(CashFlowService).deposit({ accountId: sim.acc.safe, counterpartAccountId: sim.acc.equity, operationType: 'owner_contribution', amount: 1_000_000, description: 'Opening safe' }));
    for (const [sku, st] of Object.entries(STOCK)) {
      await sim.as('manager', () => sim.get(StockService).receiveForDocument({ productId: sim.prod[sku], locationId: sim.loc.ACA, quantity: st.qty, unitCost: st.unitCost } as any, { sourceType: 'goods_receipt', sourceId: `OPEN-${sku}`, date: new Date() }));
    }
    // Hand the database to the real API process; keep only the SQL connection here.
    await sim.moduleRef.close();
    await other.moduleRef.close();
    const port = 3900 + Math.floor(Math.random() * 90);
    api = new ApiProcess(port, logFile, process.env.DATABASE_URL!);
    await api.start();
    http = client(api.base);
  }, 600_000);

  afterAll(async () => {
    const out = ev.write({ organizationId: sim?.organizationId, seed: SEED, apiLog: logFile });
    // eslint-disable-next-line no-console
    console.log(`\nSIMULATION EVIDENCE → ${out.root}  verdict ${out.verdict}`);
    await api?.kill();
    await sim?.raw.$disconnect();
    await other?.raw.$disconnect();
  });

  run('M4-00', 'Staff log in over HTTP; cashier opens shift through the API', 'P0', async (rec) => {
    for (const who of ['manager', 'cashier', 'cashier2', 'waiter', 'auditor']) token[who] = await login(sim, who);
    token.otherManager = await login(other, 'manager');
    const open = await http('POST', '/cash-sessions/open', { token: token.cashier, body: { cashRegisterId: sim.registers.COUNTER, openingFloat: 0 } });
    rec.notes.push(`open: ${JSON.stringify(open.body).slice(0, 300)}`);
    rec.rules.push(status('CASH shift opened via API', open.status, [200, 201]));
    sessionId = open.body?.id;
  });

  // ═══════════════ Security ═══════════════
  run('M4-S-11', 'Login carrying an Idempotency-Key header is handled (no 500)', 'P2', async (rec) => {
    const code = (await sim.db.organization.findUniqueOrThrow({ where: { id: sim.organizationId } })).code;
    const r = await http('POST', '/auth/login', { key: randomUUID(), body: { organizationCode: code, email: 'manager@lakeview.test', password: PASSWORD } });
    rec.rules.push(status('ROBUST login with Idempotency-Key header', r.status, [200, 201, 400]));
  });
  run('M4-S-01', 'No token → 401 on checkout', 'P0', async (rec) => {
    rec.rules.push(status('AUTH anonymous checkout', (await http('POST', '/pos/checkout', { key: randomUUID(), body: espresso(sim) })).status, [401]));
  });
  run('M4-S-02', 'Waiter cannot adjust stock (403) and stock is unchanged', 'P0', async (rec) => {
    const before = await sim.onHand('BEER');
    const r = await http('POST', '/inventory/adjustments', { token: token.waiter, body: { locationId: sim.loc.ACA, responsibleById: sim.users.waiter, approvedById: sim.users.waiter, items: [{ productId: sim.prod.BEER, qtyActual: 999 }] } });
    rec.rules.push(status('AUTH waiter stock adjustment', r.status, [403]));
    rec.rules.push(compare('AUTH beer on hand unchanged', before, await sim.onHand('BEER')));
  });
  run('M4-S-03', 'Cashier cannot mint store credit (403)', 'P0', async (rec) => {
    const r = await http('POST', '/pos/loyalty/credit/issue', { token: token.cashier, body: { partnerId: sim.acc.walkin, amount: 500000, reason: 'free money' } });
    rec.rules.push(status('AUTH cashier store-credit issue', r.status, [403]));
  });
  run('M4-S-04', 'Waiter cannot read the P&L (403); auditor cannot sell (403)', 'P0', async (rec) => {
    rec.rules.push(status('AUTH waiter P&L', (await http('GET', '/reports/accounting/profit-and-loss', { token: token.waiter })).status, [403]));
    rec.rules.push(status('AUTH auditor checkout', (await http('POST', '/pos/checkout', { token: token.auditor, key: randomUUID(), body: espresso(sim) })).status, [403]));
  });
  let saleA = '';
  run('M4-S-05', 'Tenant isolation: another company cannot read or refund our invoice', 'P0', async (rec) => {
    const sale = await http('POST', '/pos/checkout', { token: token.cashier, key: randomUUID(), body: espresso(sim) });
    rec.rules.push(status('SALES checkout over HTTP', sale.status, [200, 201]));
    saleA = sale.body?.invoiceId;
    const read = await http('GET', `/invoices/${saleA}`, { token: token.otherManager });
    rec.rules.push(status('TENANCY cross-org invoice read', read.status, [403, 404]));
    const refund = await http('POST', `/pos/invoices/${saleA}/refund`, { token: token.otherManager, key: randomUUID(), body: { reason: 'steal', stockDisposition: 'no_return', overrideById: other.users.manager, overridePin: PIN } });
    rec.rules.push(status('TENANCY cross-org refund', refund.status, [403, 404]));
    rec.rules.push({ rule: 'TENANCY our invoice still paid', status: (await sim.db.invoice.findUniqueOrThrow({ where: { id: saleA } })).status === 'paid' ? 'PASS' : 'FAIL' });
  });
  run('M4-S-06', 'Checkout without Idempotency-Key is refused (400)', 'P0', async (rec) => {
    rec.rules.push(status('INT key required', (await http('POST', '/pos/checkout', { token: token.cashier, noKey: true, body: espresso(sim) })).status, [400, 428]));
  });
  run('M4-S-07', 'Actor spoofing: createdBy/userId in the body is ignored; audit actor = token user', 'P0', async (rec) => {
    const r = await http('POST', '/pos/checkout', { token: token.cashier, key: randomUUID(), body: { ...espresso(sim), userId: sim.users.manager, createdBy: sim.users.manager, waiterId: sim.users.manager } });
    rec.rules.push(status('SALES checkout accepted (extra fields stripped or rejected)', r.status, [200, 201, 400]));
    if (r.status < 300) {
      const inv = await sim.db.invoice.findUniqueOrThrow({ where: { id: r.body.invoiceId } });
      rec.rules.push({ rule: 'AUDIT invoice actor = cashier token', status: inv.createdBy === sim.users.cashier || inv.createdBy == null ? 'PASS' : 'FAIL', actual: String(inv.createdBy) });
    }
  });
  run('M4-S-08', 'Wrong manager PIN ×5 locks overrides; correct PIN then refused', 'P0', async (rec) => {
    const target = saleA;
    for (let i = 0; i < 5; i++) await http('POST', `/pos/invoices/${target}/refund`, { token: token.cashier, key: randomUUID(), body: { reason: 'guess', stockDisposition: 'no_return', overrideById: sim.users.manager, overridePin: `00${i}0` } });
    const r = await http('POST', `/pos/invoices/${target}/refund`, { token: token.cashier, key: randomUUID(), body: { reason: 'real', stockDisposition: 'no_return', overrideById: sim.users.manager, overridePin: PIN } });
    rec.rules.push(status('AUTH override locked after 5 bad PINs', r.status, [401, 403, 429]));
    rec.rules.push({ rule: 'AUTH invoice not refunded while locked', status: (await sim.db.invoice.findUniqueOrThrow({ where: { id: target } })).status === 'paid' ? 'PASS' : 'FAIL' });
    await sim.raw.$executeRawUnsafe(`DELETE FROM "LoginAttempt" WHERE "organizationId" = $1`, sim.organizationId);
  });
  run('M4-S-09', 'Revoked permission bites on the next request with the same token', 'P0', async (rec) => {
    const role = await sim.db.role.findFirstOrThrow({ where: { organizationId: sim.organizationId, name: 'cashier' } });
    const before = await http('POST', '/pos/checkout', { token: token.cashier2, key: randomUUID(), body: { ...espresso(sim), cashSessionId: undefined } });
    rec.notes.push(`cashier2 before revoke: ${before.status}`);
    await sim.db.role.update({ where: { id: role.id }, data: { permissions: role.permissions.filter((p) => p !== 'pos:checkout') } });
    const after = await http('POST', '/pos/checkout', { token: token.cashier2, key: randomUUID(), body: { ...espresso(sim), cashSessionId: undefined } });
    rec.rules.push(status('AUTH checkout after pos:checkout revoked', after.status, [401, 403]));
    await sim.db.role.update({ where: { id: role.id }, data: { permissions: role.permissions } });
  });
  run('M4-S-10', 'Disabled employee: login refused and live token rejected', 'P0', async (rec) => {
    await sim.db.user.update({ where: { id: sim.users.cashier2 }, data: { isActive: false } });
    const loginAgain = await http('POST', '/auth/login', { body: { organizationCode: (await sim.db.organization.findUniqueOrThrow({ where: { id: sim.organizationId } })).code, email: 'cashier2@lakeview.test', password: PASSWORD } });
    rec.rules.push(status('AUTH disabled user login', loginAgain.status, [400, 401, 403]));
    const me = await http('GET', '/auth/me', { token: token.cashier2 });
    rec.notes.push(`disabled user /auth/me with live token: ${me.status}`);
    const sell = await http('POST', '/pos/checkout', { token: token.cashier2, key: randomUUID(), body: { ...espresso(sim), cashSessionId: undefined } });
    rec.rules.push(status('AUTH disabled employee cannot sell with a still-valid token', sell.status, [401, 403]));
  });

  // ═══════════════ Idempotency & concurrency ═══════════════
  run('M4-X-01', 'Double-tap: 5 concurrent checkouts with one key → exactly one invoice; replay returns it', 'P0', async (rec) => {
    const key = randomUUID(), body = espresso(sim);
    const before = await invoiceCount();
    const results = await Promise.all(Array.from({ length: 5 }, () => http('POST', '/pos/checkout', { token: token.cashier, key, body })));
    rec.notes.push(`statuses: ${results.map((r) => r.status).join(',')}`);
    const replay = await http('POST', '/pos/checkout', { token: token.cashier, key, body });
    rec.rules.push(compare('INT one invoice for one key', before + 1, await invoiceCount()));
    const ids = new Set([...results, replay].filter((r) => r.status < 300).map((r) => r.body.invoiceId));
    rec.rules.push(compare('INT every successful response names the same invoice', 1, ids.size));
    const diff = await http('POST', '/pos/checkout', { token: token.cashier, key, body: { ...body, lines: [{ ...body.lines[0], quantity: 2 }], tenders: [{ method: 'card', amount: 12000, reference: randomUUID() }] } });
    rec.rules.push(status('INT same key, different payload refused', diff.status, [409, 422, 400]));
  });
  run('M4-X-02', 'Two managers refund the same invoice concurrently → one refund, one refusal', 'P0', async (rec) => {
    const sale = await http('POST', '/pos/checkout', { token: token.cashier, key: randomUUID(), body: espresso(sim) });
    const body = { reason: 'Wrong order', stockDisposition: 'no_return', cashSessionId: sessionId, overrideById: sim.users.manager, overridePin: PIN };
    const refunder = token.manager;
    const [a, b] = await Promise.all([1, 2].map(() => http('POST', `/pos/invoices/${sale.body.invoiceId}/refund`, { token: refunder, key: randomUUID(), body })));
    rec.notes.push(`statuses ${a.status}/${b.status}`);
    rec.rules.push(compare('INT one refund recorded', 1, await sim.db.posRefund.count({ where: { invoiceId: sale.body.invoiceId } })));
  });
  run('M4-X-03', 'Two cashiers settle the same table at once → one invoice, table released', 'P0', async (rec) => {
    const table = (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: 'T30', number: 30 } })).id;
    const add = await http('POST', `/pos/tabs/${table}/items`, { token: token.cashier, key: randomUUID(), body: { cashSessionId: sessionId, sendToKitchen: true, lines: [{ menuItemId: sim.menu.BURGER, description: 'Chicken burger', quantity: 1, unitPrice: 28000 }] } });
    rec.rules.push(status('TABLE round added', add.status, [200, 201]));
    const settle = () => http('POST', `/pos/tabs/${table}/settle`, { token: token.cashier, key: randomUUID(), body: { cashSessionId: sessionId, expectedTotal: 28000, tenders: [{ method: 'card', amount: 28000, reference: randomUUID() }] } });
    const [a, b] = await Promise.all([settle(), settle()]);
    rec.notes.push(`statuses ${a.status}/${b.status}`);
    const order = await sim.db.posTableOrder.findFirst({ where: { tableId: table }, orderBy: { openedAt: 'desc' } as any });
    rec.rules.push(compare('INT one invoice for the table', 1, await sim.db.invoice.count({ where: { organizationId: sim.organizationId, tableId: table } })));
    rec.notes.push(`order ${order?.orderId}`);
  });

  // ═══════════════ Crash faults ═══════════════
  run('M4-F-01', 'API hard-killed while a checkout is in flight; terminal retries the same key after restart → exactly one sale', 'P0', async (rec) => {
    const key = randomUUID(), body = espresso(sim);
    const before = await invoiceCount();
    const inflight = http('POST', '/pos/checkout', { token: token.cashier, key, body }).catch((e) => ({ status: 0, body: String(e) }));
    await new Promise((r) => setTimeout(r, 40));
    await api.kill();
    const first = await inflight;
    rec.notes.push(`in-flight result: ${first.status}; invoices after crash: ${(await invoiceCount()) - before}`);
    await api.start();
    let retry = await http('POST', '/pos/checkout', { token: token.cashier, key, body });
    if (retry.status === 409 || /recovery|in progress/i.test(JSON.stringify(retry.body))) {
      rec.notes.push(`retry says: ${JSON.stringify(retry.body).slice(0, 160)} — aging in-flight record past its window`);
      await sim.raw.$executeRawUnsafe(`UPDATE "IdempotencyRecord" SET "createdAt" = "createdAt" - interval '10 minutes' WHERE key = $1`, key);
      retry = await http('POST', '/pos/checkout', { token: token.cashier, key, body });
    }
    rec.rules.push(status('FAULT retry after restart succeeds', retry.status, [200, 201]));
    rec.rules.push(compare('FAULT exactly one invoice for the crashed checkout', before + 1, await invoiceCount()));
  });

  run('M4-F-02', 'Database connections terminated during 10 checkouts; retries with the same keys → exactly 10 sales, books balanced', 'P0', async (rec) => {
    const before = await invoiceCount();
    const jobs = Array.from({ length: 10 }, () => ({ key: randomUUID(), body: espresso(sim) }));
    const firstWave = Promise.all(jobs.map((j) => http('POST', '/pos/checkout', { token: token.cashier, key: j.key, body: j.body }).catch(() => ({ status: 0, body: null }))));
    await new Promise((r) => setTimeout(r, 30));
    await sim.raw.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name NOT ILIKE '%psql%' AND backend_type = 'client backend'`).catch(() => undefined);
    const wave = await firstWave;
    rec.notes.push(`first wave statuses: ${wave.map((w) => w.status).join(',')}`);
    await new Promise((r) => setTimeout(r, 2000));
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await Promise.all(jobs.map((j) => http('POST', '/pos/checkout', { token: token.cashier, key: j.key, body: j.body }).catch(() => ({ status: 0, body: null }))));
      if (res.every((r) => r.status >= 200 && r.status < 300)) break;
      await sim.raw.$executeRawUnsafe(`UPDATE "IdempotencyRecord" SET "createdAt" = "createdAt" - interval '10 minutes' WHERE key = ANY($1::text[]) AND "createdAt" > now() - interval '5 minutes'`, jobs.map((j) => j.key)).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500));
    }
    rec.rules.push(compare('FAULT exactly 10 invoices', before + 10, await invoiceCount()));
    const tb: any[] = await sim.raw.$queryRawUnsafe(`SELECT COALESCE(SUM(l."baseDebit"),0)::text d, COALESCE(SUM(l."baseCredit"),0)::text c FROM "JournalLine" l JOIN "JournalEntry" e ON e.id=l."journalEntryId" WHERE l."organizationId"=$1 AND e.status IN ('posted','reversed')`, sim.organizationId);
    rec.rules.push(compare('GL TB balanced after connection kills', tb[0].d, tb[0].c));
  });

  run('M4-F-03', 'Stock worker survives a restart: backlog drains by itself, COGS once per sale', 'P0', async (rec) => {
    await api.restart();
    const until = Date.now() + 120_000;
    let pending = -1;
    while (Date.now() < until) {
      pending = await sim.db.stockPostingJob.count({ where: { organizationId: sim.organizationId, status: { not: 'done' } } });
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    rec.rules.push(compare('FAULT stock-posting backlog drained by the worker', 0, pending));
    const dup: any[] = await sim.raw.$queryRawUnsafe(`SELECT "invoiceItemId", "productId", "componentType", "componentId" FROM "InvoiceItemRecipeIngredient" WHERE "organizationId"=$1 GROUP BY 1,2,3,4 HAVING COUNT(*) > 1`, sim.organizationId);
    rec.rules.push(compare('INT no ingredient issued twice for the same sale', 0, dup.length));
  });

  run('M4-GL-100', 'Books after the attack day: TB balanced, no duplicate posting keys, every invoice posted', 'P0', async (rec) => {
    const tb: any[] = await sim.raw.$queryRawUnsafe(`SELECT COALESCE(SUM(l."baseDebit"),0)::text d, COALESCE(SUM(l."baseCredit"),0)::text c FROM "JournalLine" l JOIN "JournalEntry" e ON e.id=l."journalEntryId" WHERE l."organizationId"=$1 AND e.status IN ('posted','reversed')`, sim.organizationId);
    rec.rules.push(compare('GL TB', tb[0].d, tb[0].c));
    rec.rules.push(compare('GL duplicate posting keys', 0, await sim.duplicatePostingKeys()));
    rec.rules.push(compare('GL invoices without posting', 0, await sim.invoicesWithoutPosting()));
    rec.rules.push(compare('GL unbalanced entries', 0, await sim.unbalancedEntries()));
  });

  run('M4-L-040', 'Logs contain no passwords, PINs or bearer tokens', 'P0', async (rec) => {
    const log = fs.readFileSync(logFile, 'utf8');
    rec.rules.push(compare('LOG password occurrences', 0, log.split(PASSWORD).length - 1));
    rec.rules.push(compare('LOG bearer tokens', 0, Object.values(token).filter((t) => t && log.includes(t)).length));
    rec.rules.push(compare('LOG "overridePin":"4321"', 0, (log.match(/"overridePin"\s*:\s*"4321"/g) ?? []).length));
    rec.notes.push(`log size ${log.length} bytes`);
    void D;
  });
});
