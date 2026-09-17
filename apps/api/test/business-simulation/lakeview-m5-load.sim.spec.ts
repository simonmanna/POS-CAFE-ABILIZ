/**
 * Lakeview Café & Grill — M5: seeded high-volume lunch peak over HTTP against
 * the real API (12 concurrent staff, two tills, tables, discounts, refunds),
 * latency objectives, then the full oracle after load: tills, VAT, revenue,
 * stock, trial balance and the release preflight must all still agree.
 */
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET', generateURI: () => 'otpauth://stub', verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));
import * as bcrypt from 'bcryptjs';
import { StockService } from '../../src/modules/inventory/stock.service';
import { D, compare, intendedSale, intendedConsumption } from './oracle';
import { Evidence } from './evidence';
import { bootSim, simEnabled, Sim, STOCK, MENU, DIRECT, VAT, PIN, planDay, Op, Item } from './sim-kit';
import { ApiProcess, client } from './api-process';

const SEED = Number(process.env.SIMULATION_SEED ?? '20260917');
const PROFILE = process.env.SIM_PROFILE ?? 'default';
const OPS = Number(process.env.SIM_OPS ?? '400');
const WORKERS = Number(process.env.SIM_WORKERS ?? '12');
const PASSWORD = 'Sim@Pass-2026';

(simEnabled() ? describe : describe.skip)('Lakeview — M5 seeded lunch peak under load (HTTP)', () => {
  jest.setTimeout(900_000);
  const ev = new Evidence(`SIM-${SEED}-M5-${PROFILE}`);
  let sim: Sim;
  let api: ApiProcess;
  let http: ReturnType<typeof client>;
  const token: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  const logFile = path.resolve(__dirname, `../../../../var/simulations/SIM-${SEED}-M5-api.log`);
  const L1 = { cash: { COUNTER: D(0), BAR: D(0) } as Record<string, ReturnType<typeof D>>, mtn: D(0), mtnTill: { COUNTER: D(0), BAR: D(0) } as Record<string, ReturnType<typeof D>>, card: D(0), gross: D(0), tax: D(0), sold: [] as Array<{ recipe: Record<string, number>; qty: number }>, direct: {} as Record<string, number> };
  const latency: number[] = [];
  const errors: string[] = [];

  const run = (id: string, title: string, pri: 'P0' | 'P1' | 'P2', fn: (rec: any) => Promise<void>) =>
    it(`${id} ${title}`, async () => {
      const rec = await ev.scenario(id, title, pri, fn);
      if (rec.status === 'FAIL') throw new Error(`${id} FAILED: ${rec.error ?? rec.rules.filter((r) => r.status === 'FAIL').map((r) => `${r.rule} expected ${r.expected} got ${r.actual}`).join('; ')}`);
    });

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
    sim = await bootSim('M5');
    await sim.db.user.updateMany({ where: { organizationId: sim.organizationId }, data: { passwordHash: await bcrypt.hash(PASSWORD, 10) } });
    for (const [sku, st] of Object.entries(STOCK)) {
      await sim.as('manager', () => sim.get(StockService).receiveForDocument({ productId: sim.prod[sku], locationId: sim.loc.ACA, quantity: st.qty * 4, unitCost: st.unitCost } as any, { sourceType: 'goods_receipt', sourceId: `OPEN-${sku}`, date: new Date() }));
    }
    await sim.moduleRef.close();
    api = new ApiProcess(3990 + Math.floor(Math.random() * 9), logFile, process.env.DATABASE_URL! + (process.env.SIM_API_DB_PARAMS ?? ''), (process.env.SIM_API_MODE as any) ?? 'production');
    await api.start();
    http = client(api.base);
    const code = (await sim.db.organization.findUniqueOrThrow({ where: { id: sim.organizationId } })).code;
    for (const who of ['manager', 'cashier', 'cashier2', 'waiter', 'waiter2']) {
      const r = await http('POST', '/auth/login', { body: { organizationCode: code, email: `${who}@lakeview.test`, password: PASSWORD } });
      token[who] = r.body.accessToken;
    }
  }, 900_000);

  afterAll(async () => {
    const out = ev.write({ organizationId: sim?.organizationId, seed: SEED, ops: OPS, workers: WORKERS });
    // eslint-disable-next-line no-console
    console.log(`\nSIMULATION EVIDENCE → ${out.root}  verdict ${out.verdict}`);
    await api?.kill();
    await sim?.raw.$disconnect();
  });

  run('M5-00', 'Seeded plan is deterministic (same seed → identical day)', 'P0', async (rec) => {
    const h = (ops: Op[]) => createHash('sha256').update(JSON.stringify(ops)).digest('hex');
    rec.rules.push({ rule: 'VOLUME plan hash stable for seed', status: h(planDay(SEED, OPS)) === h(planDay(SEED, OPS)) ? 'PASS' : 'FAIL' });
    rec.rules.push({ rule: 'VOLUME different seed → different plan', status: h(planDay(SEED, OPS)) !== h(planDay(SEED + 1, OPS)) ? 'PASS' : 'FAIL' });
    const open = async (who: string, till: 'COUNTER' | 'BAR') => {
      const r = await http('POST', '/cash-sessions/open', { token: token[who], body: { cashRegisterId: sim.registers[till], openingFloat: 0 } });
      if (r.status >= 300) throw new Error(`open ${till}: ${JSON.stringify(r.body)}`);
      sessions[till] = r.body.id;
    };
    await open('cashier', 'COUNTER');
    await open('cashier2', 'BAR');
  });

  run('M5-01', `Lunch peak: ${OPS} seeded operations by ${WORKERS} concurrent staff — zero failed operations, p95 checkout < 800 ms`, 'P0', async (rec) => {
    const plan = planDay(SEED, OPS);
    const cashierOf = { COUNTER: 'cashier', BAR: 'cashier2' } as const;
    const refundable: Array<{ invoiceId: string; till: 'COUNTER' | 'BAR'; gross: ReturnType<typeof D>; tax: ReturnType<typeof D>; items: Item[] }> = [];
    const lines = (items: Item[]) => items.map((i) => i.kind === 'menu'
      ? { menuItemId: sim.menu[i.sku], description: MENU[i.sku].name, quantity: i.qty, unitPrice: MENU[i.sku].price }
      : { productId: sim.prod[i.sku], description: i.sku, quantity: i.qty, unitPrice: DIRECT[i.sku].price });
    const intended = (items: Item[], discount: number) => intendedSale(items.map((i) => ({ sku: i.sku, qty: i.qty, unitPrice: i.kind === 'menu' ? MENU[i.sku].price : DIRECT[i.sku].price, taxRate: i.kind === 'menu' || DIRECT[i.sku].vat ? VAT : 0 })), discount);
    const tenders = (op: Op, gross: ReturnType<typeof D>) => {
      const g = Number(gross);
      if (op.tender === 'cash') return [{ method: 'cash', amount: g }];
      if (op.tender === 'mtn') return [{ method: 'mobile_money', accountId: sim.acc.mtn, amount: g, reference: randomUUID() }];
      if (op.tender === 'card') return [{ method: 'card', amount: g, reference: randomUUID() }];
      const half = Math.floor(g / 2);
      return [{ method: 'cash', amount: half }, { method: 'card', amount: g - half, reference: randomUUID() }];
    };
    const book = (op: Op, g: ReturnType<typeof D>, t: ReturnType<typeof D>) => {
      L1.gross = L1.gross.plus(g); L1.tax = L1.tax.plus(t);
      if (op.tender === 'cash') L1.cash[op.till] = L1.cash[op.till].plus(g);
      if (op.tender === 'mtn') { L1.mtn = L1.mtn.plus(g); L1.mtnTill[op.till] = L1.mtnTill[op.till].plus(g); }
      if (op.tender === 'card') L1.card = L1.card.plus(g);
      if (op.tender === 'mixed') { const half = Math.floor(Number(g) / 2); L1.cash[op.till] = L1.cash[op.till].plus(half); L1.card = L1.card.plus(g.minus(half)); }
      for (const i of op.items) if (i.kind === 'menu') L1.sold.push({ recipe: MENU[i.sku].recipe, qty: i.qty }); else L1.direct[i.sku] = (L1.direct[i.sku] ?? 0) + i.qty;
    };
    const tables = await Promise.all(Array.from({ length: WORKERS }, async (_, w) => (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: `L${w}`, number: 100 + w } })).id));

    const exec = async (op: Op, worker: number) => {
      const cashier = token[cashierOf[op.till]];
      const want = intended(op.items, op.discount);
      const discount = op.discount ? { transactionDiscountPercent: op.discount, discountReason: 'Regular customer' } : {};
      if (op.kind === 'refund') {
        const target = refundable.shift();
        if (!target) return;
        const r = await http('POST', `/pos/invoices/${target.invoiceId}/refund`, { token: token[cashierOf[target.till]], body: { reason: 'Guest complaint', stockDisposition: 'no_return', cashSessionId: sessions[target.till], overrideById: sim.users.manager, overridePin: PIN } });
        if (r.status >= 300) { errors.push(`refund ${op.n}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`); return; }
        L1.gross = L1.gross.minus(target.gross); L1.tax = L1.tax.minus(target.tax);
        L1.cash[target.till] = L1.cash[target.till].minus(target.gross);
        return;
      }
      if (op.kind === 'table') {
        const table = tables[worker];
        const waiter = token[worker % 2 ? 'waiter2' : 'waiter'];
        const add = await http('POST', `/pos/tabs/${table}/items`, { token: waiter, body: { cashSessionId: sessions[op.till], sendToKitchen: true, lines: lines(op.items) } });
        if (add.status >= 300) { errors.push(`tab ${op.n}: ${add.status} ${JSON.stringify(add.body).slice(0, 160)}`); return; }
        const t0 = Date.now();
        const s = await http('POST', `/pos/tabs/${table}/settle`, { token: cashier, body: { cashSessionId: sessions[op.till], expectedTotal: Number(want.gross), tenders: tenders(op, want.gross), ...discount } });
        latency.push(Date.now() - t0);
        if (s.status >= 300) { errors.push(`settle ${op.n}: ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`); return; }
        book(op, want.gross, want.tax);
        return;
      }
      const t0 = Date.now();
      const r = await http('POST', '/pos/checkout', { token: cashier, body: { cashSessionId: sessions[op.till], partnerId: sim.acc.walkin, lines: lines(op.items), expectedTotal: Number(want.gross), tenders: tenders(op, want.gross), ...discount } });
      latency.push(Date.now() - t0);
      if (r.status >= 300) { errors.push(`checkout ${op.n}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return; }
      book(op, want.gross, want.tax);
      if (op.tender === 'cash' && op.discount === 0) refundable.push({ invoiceId: r.body.invoiceId, till: op.till, gross: want.gross, tax: want.tax, items: op.items });
    };

    const queues = Array.from({ length: WORKERS }, () => [] as Op[]);
    plan.forEach((op, i) => queues[i % WORKERS].push(op));
    const started = Date.now();
    const think = Number(process.env.SIM_THINK_MS ?? '0');
    await Promise.all(queues.map(async (q, w) => { for (const op of q) { await exec(op, w); if (think) await new Promise((r) => setTimeout(r, think)); } }));
    rec.notes.push(`think time per terminal between operations: ${think} ms`);
    const seconds = (Date.now() - started) / 1000;
    latency.sort((a, b) => a - b);
    const pct = (p: number) => latency[Math.min(latency.length - 1, Math.floor((p / 100) * latency.length))] ?? 0;
    rec.notes.push(`${plan.length} ops in ${seconds.toFixed(1)}s (${(plan.length / seconds).toFixed(1)} ops/s); checkout/settle p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${latency[latency.length - 1]} ms`);
    const kinds: Record<string, number> = {};
    for (const e of errors) { const k = e.replace(/^(w+) d+: (d+).*?("error":"[^"]{0,60}|"message":"[^"]{0,60}).*$/, '$1 $2 $3'); kinds[k] = (kinds[k] ?? 0) + 1; }
    rec.notes.push(`failure kinds: ${JSON.stringify(kinds)}`);
    rec.notes.push(...errors.slice(0, 5));
    rec.rules.push(compare('LOAD failed operations', 0, errors.length));
    rec.rules.push({ rule: 'LOAD p95 checkout < 800 ms', status: pct(95) < 800 ? 'PASS' : 'FAIL', expected: '<800', actual: String(pct(95)) });
    // For refunds the sold goods were not returned (no_return), so consumption stands.
  });

  run('M5-02', 'After load: stock worker drains; recipe consumption and on-hand = oracle', 'P0', async (rec) => {
    const until = Date.now() + 240_000;
    let pending = -1;
    while (Date.now() < until) {
      pending = await sim.db.stockPostingJob.count({ where: { organizationId: sim.organizationId, status: { not: 'done' } } });
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    rec.rules.push(compare('INT stock jobs drained by the worker', 0, pending));
    const used = intendedConsumption(L1.sold);
    for (const [sku, st] of Object.entries(STOCK)) {
      const expected = D(st.qty * 4).minus(used[sku] ?? 0).minus(L1.direct[sku] ?? 0);
      rec.rules.push(compare(`INV ${sku} on hand`, expected, await sim.onHand(sku)));
    }
  });

  run('M5-03', 'After load: close both tills at oracle count; drawers, clearing, revenue, VAT and TB tie out', 'P0', async (rec) => {
    for (const till of ['COUNTER', 'BAR'] as const) {
      const who = till === 'COUNTER' ? 'cashier' : 'cashier2';
      const r = await http('POST', '/cash-sessions/close', { token: token[who], body: { sessionId: sessions[till], closingCounted: Number(L1.cash[till]), closingAccounts: { [sim.acc.mtn]: Number(L1.mtnTill[till]), [sim.acc.airtel]: 0 } } });
      rec.notes.push(`close ${till}: ${r.status} ${r.status >= 300 ? JSON.stringify(r.body).slice(0, 200) : ''}`);
      const z: any = (await sim.db.posReportSnapshot.findFirst({ where: { cashSessionId: sessions[till] } }))?.reportData;
      rec.rules.push(compare(`CASH ${till} Z expected = oracle`, L1.cash[till], z?.closingExpected ?? -1));
    }
    rec.rules.push(compare('CASH drawer COUNTER GL', L1.cash.COUNTER, await sim.balance('drawer')));
    rec.rules.push(compare('CASH drawer BAR GL', L1.cash.BAR, await sim.balance('drawer2')));
    rec.rules.push(compare('TEND MTN clearing = MoMo captures', L1.mtn, await sim.balance('mtn')));
    rec.rules.push(compare('TEND card clearing = card captures', L1.card, await sim.balance('card')));
    rec.rules.push(compare('SALES revenue GL = oracle', L1.gross.minus(L1.tax).negated(), await sim.balance('revenue')));
    rec.rules.push(compare('SALES VAT GL = oracle', L1.tax.negated(), await sim.balance('outputVat')));
    const tb = await sim.trialBalance();
    rec.rules.push(compare('GL TB balanced', tb.debit, tb.credit));
    rec.rules.push(compare('GL duplicate posting keys', 0, await sim.duplicatePostingKeys()));
    rec.rules.push(compare('GL invoices without posting', 0, await sim.invoicesWithoutPosting()));
  });

  run('M5-04', 'After load: release preflight on the simulated company is READY', 'P0', async (rec) => {
    const code = (await sim.db.organization.findUniqueOrThrow({ where: { id: sim.organizationId } })).code;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['scripts/pos-release-preflight.cjs', '--code', code], { cwd: path.resolve(__dirname, '../../../..'), env: { ...process.env }, encoding: 'utf8' });
    } catch (e: any) { out = e.stdout ?? ''; }
    const report = JSON.parse(out);
    const org = report.organizations[0];
    rec.notes.push(...org.blockers.map((b: any) => `${b.check}: ${String(b.detail ?? '').slice(0, 160)}`));
    rec.rules.push({ rule: 'PREFLIGHT simulated company READY', status: org.status === 'READY' ? 'PASS' : 'FAIL', actual: org.status });
  });
});
