/**
 * Lakeview Café & Grill — full 15-day business simulation (D0 → D14) and a
 * simulated 7-day shadow pilot.
 *
 * Every trading day runs the standard runbook: bank yesterday's tills, settle
 * MoMo/card clearing (net of fees), milk delivery paid from the safe, open two
 * tills with floats, seeded counter/table/refund volume scaled by weekday, the
 * day's calendar overlay (merge/split, procurement, counts, faults, month-end
 * transit, security, concurrency, period close, master-data change, crash
 * boundary), kitchen waste, close at the oracle's count, Z snapshot, reconcile.
 * The oracle checkpoint (CP-DAY) then compares tills, clearing, revenue, VAT,
 * stock, trial balance, posting keys and orphan postings.
 *
 * Calendar note: the clock cannot be moved, so the 15 trading days run back to
 * back on the real date. Day-dependent rules (post-midnight trading date, 7-day
 * offline window, closed periods) are exercised with past-dated operations.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET', generateURI: () => 'otpauth://stub', verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));
import { PosService } from '../../src/modules/pos/pos.service';
import { PosInvoiceService } from '../../src/modules/pos/billing/pos-invoice.service';
import { PosOrdersService } from '../../src/modules/pos/order/pos-orders.service';
import { PosSplitService } from '../../src/modules/pos/split/pos-split.service';
import { PosTablesService } from '../../src/modules/pos/pos-tables.service';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { CashFlowService } from '../../src/modules/accounting/treasury/cash-flow.service';
import { StockService } from '../../src/modules/inventory/stock.service';
import { StockDocService } from '../../src/modules/inventory/stock-doc.service';
import { InventoryCountService } from '../../src/modules/inventory/inventory-count.service';
import { PurchaseOrdersService } from '../../src/modules/procurement/purchase-orders.service';
import { LandedCostService } from '../../src/modules/procurement/landed-cost.service';
import { PeriodCloseService } from '../../src/modules/accounting/posting/period-close.service';
import { PostingService } from '../../src/modules/accounting/posting/posting.service';
import { IdempotencyService } from '../../src/kernel/idempotency/idempotency.service';
import { AuditService } from '../../src/kernel/audit/audit.service';
import { D, compare, intendedSale, money } from './oracle';
import { Evidence } from './evidence';
import { bootSim, simEnabled, Sim, STOCK, MENU, DIRECT, VAT, PIN, planDay, Op, Item } from './sim-kit';

type Dec = ReturnType<typeof D>;
const SEED = Number(process.env.SIMULATION_SEED ?? '20260917');
const BASE_OPS = Number(process.env.SIM_DAY_OPS ?? '80');
const CALENDAR = [
  { d: 0, date: 'Wed 23 Sep', mult: 0, theme: 'Setup & pre-opening' },
  { d: 1, date: 'Thu 24 Sep', mult: 1.0, theme: 'Soft opening' },
  { d: 2, date: 'Fri 25 Sep', mult: 1.4, theme: 'Friday peak: merge & split' },
  { d: 3, date: 'Sat 26 Sep', mult: 1.6, theme: 'Weekend + short supplier delivery' },
  { d: 4, date: 'Sun 27 Sep', mult: 1.1, theme: 'Short-staffed + blind count + waste' },
  { d: 5, date: 'Mon 28 Sep', mult: 0.7, theme: 'Back office: landed cost + supplier payment' },
  { d: 6, date: 'Tue 29 Sep', mult: 0.8, theme: 'Infrastructure day: worker down, offline sale' },
  { d: 7, date: 'Wed 30 Sep', mult: 0.9, theme: 'Month-end: transfer in transit' },
  { d: 8, date: 'Thu 1 Oct', mult: 1.0, theme: 'New month: transit received, settlements' },
  { d: 9, date: 'Fri 2 Oct', mult: 1.4, theme: 'Controls & security probes' },
  { d: 10, date: 'Sat 3 Oct', mult: 1.8, theme: 'Peak + concurrency' },
  { d: 11, date: 'Sun 4 Oct', mult: 1.1, theme: 'Period close' },
  { d: 12, date: 'Mon 5 Oct', mult: 0.7, theme: 'Master data: price & recipe change' },
  { d: 13, date: 'Tue 6 Oct', mult: 0.8, theme: 'Crash boundary' },
  { d: 14, date: 'Wed 7 Oct', mult: 0.9, theme: 'Clean control day' },
];

(simEnabled() ? describe : describe.skip)('Lakeview — 15-day business simulation + shadow pilot', () => {
  jest.setTimeout(1_800_000);
  const ev = new Evidence(`SIM-${SEED}-15DAY`);
  let sim: Sim;
  let pos: PosService, billing: PosInvoiceService, orders: PosOrdersService, splits: PosSplitService, tables: PosTablesService;
  let cash: CashSessionService, cashFlow: CashFlowService, stock: StockService, docs: StockDocService, counts: InventoryCountService;
  let po: PurchaseOrdersService, landed: LandedCostService, periods: PeriodCloseService, posting: PostingService, idem: IdempotencyService;

  // ── Intended books (oracle) ──────────────────────────────────────────────
  const L1 = {
    safe: D(0), bank: D(0), mtn: D(0), card: D(0), fees: D(0), gross: D(0), tax: D(0), ap: D(0), closedRevenue: D(0),
    stock: {} as Record<string, Dec>,
    price: { ...Object.fromEntries(Object.entries(MENU).map(([k, v]) => [k, v.price])) } as Record<string, number>,
  };
  const move = (sku: string, q: number | Dec) => { L1.stock[sku] = (L1.stock[sku] ?? D(0)).plus(q); };
  const consume = (items: Item[], sign = -1) => {
    for (const i of items) {
      if (i.kind === 'menu') for (const [s, q] of Object.entries(MENU[i.sku].recipe)) move(s, D(q).times(i.qty).times(sign));
      else move(i.sku, D(i.qty).times(sign));
    }
  };
  /** Legacy (authoritative) day sheets for the shadow pilot — written from the plan, never from the POS. */
  const legacySheets: Array<{ day: number; gross: Dec; tax: Dec; cash: Record<string, Dec>; mtn: Dec; card: Dec; sales: number; refunds: number }> = [];
  const dayZ: Record<number, Record<string, any>> = {};
  let yesterday: { sessions: Record<string, string>; cash: Record<string, Dec>; mtn: Dec; card: Dec } | null = null;
  let grnBeans = '', poBeans = '', transferDoc: any = null;
  const tillMtn: Record<string, Dec> = { COUNTER: D(0), BAR: D(0) };

  const run = (id: string, title: string, pri: 'P0' | 'P1' | 'P2', fn: (rec: any) => Promise<void>) =>
    it(`${id} ${title}`, async () => {
      const rec = await ev.scenario(id, title, pri, fn);
      if (rec.status === 'FAIL') throw new Error(`${id} FAILED: ${rec.error ?? rec.rules.filter((r) => r.status === 'FAIL').map((r) => `${r.rule} expected ${r.expected} got ${r.actual}`).join('; ')}`);
    });
  /** Drain until every job is done — including ones the background worker is mid-way through. */
  const drain = async () => {
    for (let i = 0; i < 40; i++) {
      const open = await sim.db.stockPostingJob.findMany({ where: { organizationId: sim.organizationId, status: { not: 'done' } } });
      if (!open.length) return;
      for (const j of open.filter((x) => x.status !== 'processing')) await sim.as('manager', () => billing.processStockPostingJob(j.id)).catch(() => undefined);
      if (open.some((x) => x.status === 'processing')) await new Promise((r) => setTimeout(r, 250));
    }
  };
  const itemsToLines = (items: Item[]) => items.map((i) => i.kind === 'menu'
    ? { menuItemId: sim.menu[i.sku], description: MENU[i.sku].name, quantity: i.qty, unitPrice: L1.price[i.sku] }
    : { productId: sim.prod[i.sku], description: i.sku, quantity: i.qty, unitPrice: DIRECT[i.sku].price });
  const intended = (items: Item[], discount = 0) => intendedSale(items.map((i) => ({ sku: i.sku, qty: i.qty, unitPrice: i.kind === 'menu' ? L1.price[i.sku] : DIRECT[i.sku].price, taxRate: i.kind === 'menu' || DIRECT[i.sku].vat ? VAT : 0 })), discount);

  beforeAll(async () => {
    sim = await bootSim('15D');
    pos = sim.get(PosService); billing = sim.get(PosInvoiceService); orders = sim.get(PosOrdersService); splits = sim.get(PosSplitService);
    tables = sim.get(PosTablesService); cash = sim.get(CashSessionService); cashFlow = sim.get(CashFlowService); stock = sim.get(StockService);
    docs = sim.get(StockDocService); counts = sim.get(InventoryCountService); po = sim.get(PurchaseOrdersService); landed = sim.get(LandedCostService);
    periods = sim.get(PeriodCloseService); posting = sim.get(PostingService); idem = sim.get(IdempotencyService);
  }, 600_000);

  afterAll(async () => {
    const out = ev.write({ organizationId: sim?.organizationId, seed: SEED, baseOpsPerDay: BASE_OPS, calendar: CALENDAR, legacySheets: legacySheets.map((s) => ({ ...s, gross: s.gross.toString(), tax: s.tax.toString(), mtn: s.mtn.toString(), card: s.card.toString(), cash: Object.fromEntries(Object.entries(s.cash).map(([k, v]) => [k, v.toString()])) })) });
    // eslint-disable-next-line no-console
    console.log(`\nSIMULATION EVIDENCE → ${out.root}  verdict ${out.verdict}`);
    await sim?.close();
  });

  // ═══════════════ D0 — setup ═══════════════
  run('D0', 'Setup: capital, opening stock at ACA and central warehouse', 'P0', async (rec) => {
    await sim.as('manager', () => cashFlow.deposit({ accountId: sim.acc.safe, counterpartAccountId: sim.acc.equity, operationType: 'owner_contribution', amount: 3_000_000, description: 'Opening safe' }));
    await sim.as('manager', () => cashFlow.deposit({ accountId: sim.acc.bank, counterpartAccountId: sim.acc.equity, operationType: 'owner_contribution', amount: 50_000_000, description: 'Opening bank' }));
    L1.safe = D(3_000_000); L1.bank = D(50_000_000);
    for (const [sku, s] of Object.entries(STOCK)) {
      await sim.as('manager', () => stock.receiveForDocument({ productId: sim.prod[sku], locationId: sim.loc.ACA, quantity: s.qty * 8, unitCost: s.unitCost } as any, { sourceType: 'goods_receipt', sourceId: `OPEN-${sku}`, date: new Date() }));
      move(sku, s.qty * 8);
    }
    await sim.as('manager', () => stock.receiveForDocument({ productId: sim.prod.WATER_500, locationId: sim.loc.CW, quantity: 100, unitCost: 1200 } as any, { sourceType: 'goods_receipt', sourceId: 'OPEN-CW-WATER', date: new Date() }));
    const tb = await sim.trialBalance();
    rec.rules.push(compare('GL TB balanced after setup', tb.debit, tb.credit));
  });

  // ═══════════════ D1 … D14 ═══════════════
  for (const day of CALENDAR.slice(1)) {
    run(`D${day.d}`, `${day.date} — ${day.theme}`, 'P0', async (rec) => {
      const d = day.d;
      const sheet = { day: d, gross: D(0), tax: D(0), cash: { COUNTER: D(0), BAR: D(0) } as Record<string, Dec>, mtn: D(0), card: D(0), sales: 0, refunds: 0 };
      const book = (till: string, tender: Op['tender'], g: Dec, t: Dec) => {
        L1.gross = L1.gross.plus(g); L1.tax = L1.tax.plus(t); sheet.gross = sheet.gross.plus(g); sheet.tax = sheet.tax.plus(t); sheet.sales++;
        if (tender === 'cash') sheet.cash[till] = sheet.cash[till].plus(g);
        if (tender === 'mtn') { sheet.mtn = sheet.mtn.plus(g); tillMtn[till] = tillMtn[till].plus(g); }
        if (tender === 'card') sheet.card = sheet.card.plus(g);
        if (tender === 'mixed') { const half = Math.floor(Number(g) / 2); sheet.cash[till] = sheet.cash[till].plus(half); sheet.card = sheet.card.plus(g.minus(half)); }
      };
      const tenders = (tender: Op['tender'], g: Dec) => {
        const n = Number(g);
        if (tender === 'cash') return [{ method: 'cash', amount: n }];
        if (tender === 'mtn') return [{ method: 'mobile_money', accountId: sim.acc.mtn, amount: n, reference: randomUUID() }];
        if (tender === 'card') return [{ method: 'card', amount: n, reference: randomUUID() }];
        const half = Math.floor(n / 2);
        return [{ method: 'cash', amount: half }, { method: 'card', amount: n - half, reference: randomUUID() }];
      };

      // ── 06:30 morning: bank yesterday, settle clearing, milk delivery ──
      if (yesterday) {
        for (const till of ['COUNTER', 'BAR']) {
          if (yesterday.cash[till].gt(0)) {
            await sim.as('manager', () => cash.recordBankDeposit(yesterday!.sessions[till], { amount: Number(yesterday!.cash[till]), bankName: 'Lakeview Bank', destinationAccountId: sim.acc.bank, reference: `SLIP-D${d - 1}-${till}` } as any));
            L1.bank = L1.bank.plus(yesterday.cash[till]);
          }
          await sim.as('manager', () => cash.reconcile(yesterday!.sessions[till], {}));
        }
        for (const [key, gross, pct, ref] of [['mtn', yesterday.mtn, 0.01, 'MTN'], ['card', yesterday.card, 0.02, 'CARD']] as const) {
          if (gross.lte(0)) continue;
          const fee = money(gross.times(pct));
          await sim.as('manager', () => cash.settleTender({ sourceAccountId: sim.acc[key], destinationAccountId: sim.acc.bank, grossAmount: Number(gross), feeAmount: Number(fee), feeAccountId: sim.acc.fees, reference: `${ref}-SETTLE-D${d - 1}`, settledAt: new Date().toISOString() }));
          L1.bank = L1.bank.plus(gross).minus(fee); L1.fees = L1.fees.plus(fee);
        }
      }

      // ── 06:45 open tills ──
      const sessions: Record<string, string> = {};
      for (const [till, who] of [['COUNTER', 'cashier'], ['BAR', 'cashier2']] as const) {
        const s: any = await sim.as(who, () => cash.open({ cashRegisterId: sim.registers[till], openingFloat: 100_000, openingSourceAccountId: sim.acc.safe, notes: `D${d} float` } as any));
        sessions[till] = s.id;
        L1.safe = L1.safe.minus(100_000);
        sheet.cash[till] = D(100_000);
      }
      const whoOf = (till: string) => (till === 'COUNTER' ? 'cashier' : 'cashier2');

      // ── 07:00 milk delivery, cash on delivery from the counter till ──
      const milk: any = await sim.as('cashier', () => po.create({ partnerId: sim.acc.dairy, warehouseId: sim.loc.ACA, paymentType: 'cash', currencyCode: 'UGX', lines: [{ productId: sim.prod.MILK_ML, description: 'Milk', quantity: 5000, unitPrice: 4, taxRate: 0 }] } as any));
      await sim.as('cashier', () => po.receive(milk.id, { warehouseId: sim.loc.ACA, lines: [{ productId: sim.prod.MILK_ML, description: 'Milk', quantity: 5000, unitCost: 4 }] } as any));
      move('MILK_ML', 5000); sheet.cash.COUNTER = sheet.cash.COUNTER.minus(20_000);

      // ── trading: seeded volume ──
      const plan = planDay(SEED * 100 + d, Math.round(BASE_OPS * day.mult));
      const refundable: Array<{ id: string; till: string; g: Dec; t: Dec; items: Item[] }> = [];
      const table = (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: `D${d}-T`, number: 1000 + d } })).id;
      const errors: string[] = [];
      for (const op of plan) {
        try {
          if (op.kind === 'refund') {
            const target = refundable.shift();
            if (!target) continue;
            await sim.as(whoOf(target.till), () => billing.refund(target.id, 'Guest complaint', { overrideById: sim.users.manager, overridePin: PIN, stockDisposition: 'no_return', cashSessionId: sessions[target.till] }));
            L1.gross = L1.gross.minus(target.g); L1.tax = L1.tax.minus(target.t);
            sheet.gross = sheet.gross.minus(target.g); sheet.tax = sheet.tax.minus(target.t); sheet.cash[target.till] = sheet.cash[target.till].minus(target.g); sheet.refunds++;
            continue;
          }
          const want = intended(op.items, op.discount);
          const discount = op.discount ? { transactionDiscountPercent: op.discount, discountReason: 'Regular customer' } : {};
          if (op.kind === 'table') {
            await sim.as(op.n % 2 ? 'waiter2' : 'waiter', () => pos.addToTab({ tableId: table, cashSessionId: sessions[op.till], sendToKitchen: true, lines: itemsToLines(op.items) }));
            await sim.as(whoOf(op.till), () => pos.settleTab({ tableId: table, cashSessionId: sessions[op.till], expectedTotal: Number(want.gross), tenders: tenders(op.tender, want.gross), ...discount } as any));
          } else {
            const r: any = await sim.as(whoOf(op.till), () => pos.checkout({ cashSessionId: sessions[op.till], partnerId: sim.acc.walkin, lines: itemsToLines(op.items), expectedTotal: Number(want.gross), tenders: tenders(op.tender, want.gross), ...discount } as any));
            if (op.tender === 'cash' && !op.discount) refundable.push({ id: r.invoiceId, till: op.till, g: want.gross, t: want.tax, items: op.items });
          }
          book(op.till, op.tender, want.gross, want.tax);
          consume(op.items);
        } catch (e: any) {
          errors.push(`op ${op.n} ${op.kind}: ${String(e.message).slice(0, 140)}`);
          const open = await sim.db.posTableOrder.findFirst({ where: { tableId: table, closedAt: null } });
          if (open) await sim.as('manager', () => orders.cancelOrder(open.orderId!, 'Harness recovery', undefined, { overrideById: sim.users.manager, overridePin: PIN })).catch(() => undefined);
        }
      }
      rec.rules.push(compare('VOLUME failed operations', 0, errors.length));
      rec.notes.push(...errors.slice(0, 5));

      // ── calendar overlay ──
      await overlay(d, { rec, sessions, sheet, book, tenders, whoOf });

      // ── 22:45 kitchen waste: a fired espresso cancelled ──
      const wt = (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: `D${d}-W`, number: 2000 + d } })).id;
      await sim.as('waiter', () => pos.addToTab({ tableId: wt, cashSessionId: sessions.COUNTER, sendToKitchen: true, lines: [{ menuItemId: sim.menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: L1.price.ESPRESSO }] }));
      const wOrder = (await sim.db.posTableOrder.findFirstOrThrow({ where: { tableId: wt, closedAt: null } })).orderId!;
      await sim.as('manager', () => orders.cancelOrder(wOrder, 'Guest left before serving', undefined, { overrideById: sim.users.manager, overridePin: PIN }));
      move('BEANS_G', -18);

      // ── 23:15 close tills at the oracle's count ──
      if (d !== 6) await drain();
      else { rec.notes.push('D6: stock worker left down all day; draining at close'); await drain(); }
      for (const till of ['COUNTER', 'BAR']) {
        const closed: any = await sim.as(whoOf(till), () => cash.close({ sessionId: sessions[till], closingCounted: Number(sheet.cash[till]), closingAccounts: { [sim.acc.mtn]: Number(tillMtn[till]), [sim.acc.airtel]: 0 } } as any)).catch((e: any) => ({ error: e.message }));
        if (closed.error) { rec.rules.push({ rule: `CASH ${till} close`, status: 'FAIL', actual: closed.error.slice(0, 160) }); continue; }
        const z: any = (await sim.db.posReportSnapshot.findFirst({ where: { cashSessionId: sessions[till] } }))?.reportData;
        dayZ[d] = { ...(dayZ[d] ?? {}), [till]: z };
        rec.rules.push(compare(`CASH ${till} Z expected = oracle count`, sheet.cash[till], z?.closingExpected ?? -1));
        rec.rules.push(compare(`CASH ${till} over/short = 0`, 0, D(z?.closingDifference ?? z?.difference ?? 0)));
      }
      tillMtn.COUNTER = D(0); tillMtn.BAR = D(0);

      // ── CP-DAY oracle ──
      rec.rules.push(compare('CP-DAY drawer COUNTER GL = counted', sheet.cash.COUNTER, await sim.balance('drawer')));
      rec.rules.push(compare('CP-DAY drawer BAR GL = counted', sheet.cash.BAR, await sim.balance('drawer2')));
      rec.rules.push(compare('CP-DAY safe GL', L1.safe, await sim.balance('safe')));
      rec.rules.push(compare('CP-DAY bank GL', L1.bank, await sim.balance('bank')));
      rec.rules.push(compare('CP-DAY MTN clearing = today\'s MoMo (yesterday settled)', sheet.mtn, await sim.balance('mtn')));
      rec.rules.push(compare('CP-DAY card clearing = today\'s card (yesterday settled)', sheet.card, await sim.balance('card')));
      rec.rules.push(compare('CP-DAY processor fees', L1.fees, await sim.balance('fees')));
      rec.rules.push(compare('CP-DAY revenue GL (cumulative, after period-close transfers)', L1.gross.minus(L1.tax).minus(L1.closedRevenue).negated(), await sim.balance('revenue')));
      rec.rules.push(compare('CP-DAY output VAT GL (cumulative)', L1.tax.negated(), await sim.balance('outputVat')));
      for (const sku of Object.keys(STOCK)) rec.rules.push(compare(`CP-DAY ${sku} on hand`, L1.stock[sku] ?? 0, await sim.onHand(sku)));
      const tb = await sim.trialBalance();
      rec.rules.push(compare('CP-DAY TB balanced', tb.debit, tb.credit));
      rec.rules.push(compare('CP-DAY duplicate posting keys', 0, await sim.duplicatePostingKeys()));
      rec.rules.push(compare('CP-DAY invoices without posting', 0, await sim.invoicesWithoutPosting()));
      rec.rules.push(compare('CP-DAY pending stock jobs', 0, await sim.db.stockPostingJob.count({ where: { organizationId: sim.organizationId, status: { not: 'done' } } })));
      const dup: any[] = await sim.raw.$queryRawUnsafe(`SELECT "invoiceItemId", "productId", "componentType", "componentId" FROM "InvoiceItemRecipeIngredient" WHERE "organizationId"=$1 GROUP BY 1,2,3,4 HAVING COUNT(*) > 1`, sim.organizationId);
      rec.rules.push(compare('CP-DAY no ingredient issued twice for one sale', 0, dup.length));
      rec.notes.push(`${plan.length} planned ops · ${sheet.sales} sales · ${sheet.refunds} refunds · gross ${sheet.gross} · VAT ${sheet.tax} · cash COUNTER ${sheet.cash.COUNTER} BAR ${sheet.cash.BAR} · MoMo ${sheet.mtn} · card ${sheet.card}`);

      legacySheets.push(sheet);
      yesterday = { sessions, cash: sheet.cash, mtn: sheet.mtn, card: sheet.card };
    });
  }

  // ═══════════════ Calendar overlays ═══════════════
  async function overlay(d: number, ctx: { rec: any; sessions: Record<string, string>; sheet: any; book: (till: string, tender: Op['tender'], g: Dec, t: Dec) => void; tenders: (t: Op['tender'], g: Dec) => any[]; whoOf: (t: string) => string }) {
    const { rec, sessions, book, tenders } = ctx;
    const sale = async (who: string, till: string, items: Item[], tender: Op['tender'], extra: Record<string, unknown> = {}) => {
      const want = intendedSale(items.map((i) => ({ sku: i.sku, qty: i.qty, unitPrice: i.kind === 'menu' ? L1.price[i.sku] : DIRECT[i.sku].price, taxRate: i.kind === 'menu' || DIRECT[i.sku].vat ? VAT : 0 })));
      const r: any = await sim.as(who, () => pos.checkout({ cashSessionId: sessions[till], partnerId: sim.acc.walkin, lines: itemsToLines(items), expectedTotal: Number(want.gross), tenders: tenders(tender, want.gross), ...extra } as any));
      book(till, tender, want.gross, want.tax); consume(items);
      return { r, want };
    };
    switch (d) {
      case 2: {
        const [a, b] = await Promise.all([1, 2].map(async (n) => (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: `D2-M${n}`, number: 3000 + n } })).id));
        await sim.as('waiter', () => pos.addToTab({ tableId: a, cashSessionId: sessions.COUNTER, sendToKitchen: true, lines: itemsToLines([{ kind: 'menu', sku: 'BURGER', qty: 1 }]) }));
        await sim.as('waiter2', () => pos.addToTab({ tableId: b, cashSessionId: sessions.COUNTER, sendToKitchen: true, lines: itemsToLines([{ kind: 'menu', sku: 'CAPP_M', qty: 1 }]) }));
        await sim.as('manager', () => tables.merge(b, a));
        const tab = await sim.db.posTableOrder.findFirstOrThrow({ where: { tableId: a, closedAt: null } });
        const order: any = await sim.db.order.findUniqueOrThrow({ where: { id: tab.orderId! }, include: { items: true } });
        let st: any = await sim.as('cashier', () => splits.addBills(a, 2));
        const live = order.items.filter((i: any) => !i.cancelled);
        st = await sim.as('cashier', () => splits.assign(st.bills[0].id, [{ sourceItemId: live.find((i: any) => i.menuItemId === sim.menu.BURGER).id, quantity: 1 }]));
        st = await sim.as('cashier', () => splits.assign(st.bills[1].id, [{ sourceItemId: live.find((i: any) => i.menuItemId === sim.menu.CAPP_M).id, quantity: 1 }]));
        for (const [i, item] of [[0, 'BURGER'], [1, 'CAPP_M']] as const) {
          const want = intendedSale([{ sku: item, qty: 1, unitPrice: L1.price[item], taxRate: VAT }]);
          await sim.as('cashier', () => splits.settleBill(st.bills[i].id, { cashSessionId: sessions.COUNTER, expectedTotal: Number(want.gross), tenders: tenders('card', want.gross) } as any));
          book('COUNTER', 'card', want.gross, want.tax); consume([{ kind: 'menu', sku: item, qty: 1 }]);
        }
        rec.rules.push({ rule: 'D2 merged table fully settled across split bills', status: (await sim.db.posTableOrder.count({ where: { tableId: a, closedAt: null } })) === 0 ? 'PASS' : 'FAIL' });
        break;
      }
      case 3: {
        const p: any = await sim.as('manager', () => po.create({ partnerId: sim.acc.kakira, warehouseId: sim.loc.ACA, paymentType: 'credit', currencyCode: 'UGX', lines: [{ productId: sim.prod.BEANS_G, description: 'Beans', quantity: 10_000, unitPrice: 60, taxRate: 0 }] } as any));
        poBeans = p.id;
        await sim.as('manager', () => po.receive(p.id, { warehouseId: sim.loc.ACA, lines: [{ productId: sim.prod.BEANS_G, description: 'Beans (short delivery)', quantity: 8_000, unitCost: 60 }] } as any));
        move('BEANS_G', 8000); L1.ap = L1.ap.plus(480_000);
        grnBeans = (await sim.db.goodsReceiptNote.findFirstOrThrow({ where: { organizationId: sim.organizationId } as any, orderBy: { createdAt: 'desc' } })).id;
        rec.rules.push(compare('D3 AP = short delivery vouchered (8 kg)', L1.ap.negated(), await sim.balance('ap')));
        break;
      }
      case 4: {
        await drain();
        const system = await sim.onHand('BEER');
        const s: any = await sim.as('manager', () => counts.start({ locationId: sim.loc.ACA, countType: 'spot', blind: true, scopeProductIds: [sim.prod.BEER] } as any));
        await sim.as('manager', () => counts.saveDraft(s.id, { lines: [{ lineId: s.lines[0].id, countedQty: Number(system) - 2, reason: 'breakage' }] }));
        await sim.as('manager', () => counts.submit(s.id, {}));
        move('BEER', -2);
        const w: any = await sim.as('manager', () => docs.createWaste({ locationId: sim.loc.ACA, responsibleById: sim.users.storekeeper, approvedById: sim.users.manager, category: 'spoiled', notes: 'Milk spilled', items: [{ productId: sim.prod.MILK_ML, qty: 1000 }] } as any));
        await sim.as('manager', () => docs.approveWaste(w.id));
        move('MILK_ML', -1000);
        break;
      }
      case 5: {
        const lc: any = await sim.as('manager', () => landed.create({ goodsReceiptId: grnBeans, creditAccountId: sim.acc.ap, charges: [{ kind: 'freight', amount: 60_000 }] } as any));
        const posted: any = await sim.as('manager', () => landed.post(lc.id));
        L1.ap = L1.ap.plus(60_000);
        rec.rules.push(compare('D5 landed cost fully allocated (capitalised + expensed)', 60_000, D(posted.capitalizedAmount).plus(posted.expensedAmount)));
        await sim.as('manager', () => po.pay(poBeans, { amount: 300_000, method: 'bank' } as any));
        L1.ap = L1.ap.minus(300_000); L1.bank = L1.bank.minus(300_000);
        rec.rules.push(compare('D5 AP after freight and part payment', L1.ap.negated(), await sim.balance('ap')));
        break;
      }
      case 6: {
        const { want } = await sale('cashier', 'COUNTER', [{ kind: 'menu', sku: 'ESPRESSO', qty: 2 }], 'card', { occurredAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
        rec.notes.push(`D6 offline sale synced 3h late: ${want.gross}`);
        break;
      }
      case 7: {
        transferDoc = await sim.as('manager', () => docs.createTransfer({ fromLocationId: sim.loc.CW, toLocationId: sim.loc.ACA, mode: 'transit', responsibleById: sim.users.storekeeper, approvedById: sim.users.manager, items: [{ productId: sim.prod.WATER_500, qtyRequested: 24 }] } as any));
        await sim.as('manager', () => docs.approveTransfer(transferDoc.id));
        await sim.as('manager', () => docs.dispatchTransfer(transferDoc.id));
        rec.rules.push(compare('D7 month-end: 24 bottles in transit', 24, (await sim.db.stockItem.aggregate({ where: { organizationId: sim.organizationId, productId: sim.prod.WATER_500, location: { type: 'transit' } } as any, _sum: { quantity: true } }))._sum.quantity ?? 0));
        break;
      }
      case 8: {
        await sim.as('manager', () => docs.receiveTransfer(transferDoc.id, { lines: [{ itemId: transferDoc.items[0].id, received: 23, damaged: 1 }] }));
        move('WATER_500', 23);
        rec.rules.push(compare('D8 CW water = 100 − 24', 76, await sim.onHand('WATER_500', 'CW')));
        break;
      }
      case 9: {
        const { r } = await sale('cashier', 'COUNTER', [{ kind: 'menu', sku: 'CAPP_M', qty: 1 }], 'cash');
        let selfApproved = false, fakeIn = false, noPin = false;
        await sim.as('cashier', () => billing.refund(r.invoiceId, 'self', { overrideById: sim.users.cashier, overridePin: PIN, stockDisposition: 'no_return', cashSessionId: sessions.COUNTER })).then(() => { selfApproved = true; }).catch(() => undefined);
        await sim.as('cashier', () => cash.recordMovement(sessions.COUNTER, { movementType: 'pay_in', amount: 99_000, reason: 'unrecorded sale', counterpartAccountId: sim.acc.revenue } as any)).then(() => { fakeIn = true; }).catch(() => undefined);
        await sim.as('cashier', () => cash.recordMovement(sessions.COUNTER, { movementType: 'pay_out', amount: 40_000, reason: 'personal', counterpartAccountId: sim.acc.expense } as any)).then(() => { noPin = true; }).catch(() => undefined);
        rec.rules.push({ rule: 'D9 cashier cannot approve own refund', status: selfApproved ? 'FAIL' : 'PASS' });
        rec.rules.push({ rule: 'D9 pay-in cannot create revenue', status: fakeIn ? 'FAIL' : 'PASS' });
        rec.rules.push({ rule: 'D9 pay-out needs a manager', status: noPin ? 'FAIL' : 'PASS' });
        break;
      }
      case 10: {
        const { r, want } = await sale('cashier2', 'BAR', [{ kind: 'direct', sku: 'BEER', qty: 2 }], 'cash');
        const attempts = await Promise.allSettled([1, 2].map(() => sim.as('cashier2', () => billing.refund(r.invoiceId, 'double tap', { overrideById: sim.users.manager, overridePin: PIN, stockDisposition: 'no_return', cashSessionId: sessions.BAR }))));
        const ok = attempts.filter((a) => a.status === 'fulfilled').length;
        rec.rules.push(compare('D10 concurrent refunds of one receipt → one refund', 1, await sim.db.posRefund.count({ where: { invoiceId: r.invoiceId } })));
        if (ok >= 1) { L1.gross = L1.gross.minus(want.gross); L1.tax = L1.tax.minus(want.tax); ctx.sheet.gross = ctx.sheet.gross.minus(want.gross); ctx.sheet.tax = ctx.sheet.tax.minus(want.tax); ctx.sheet.cash.BAR = ctx.sheet.cash.BAR.minus(want.gross); }
        const key = randomUUID(), body = { cashSessionId: sessions.COUNTER, partnerId: sim.acc.walkin, lines: itemsToLines([{ kind: 'menu', sku: 'ESPRESSO', qty: 1 }]), tenders: [{ method: 'card', amount: L1.price.ESPRESSO, reference: randomUUID() }] };
        const before = await sim.db.invoice.count({ where: { organizationId: sim.organizationId } });
        await Promise.allSettled([1, 2, 3].map(() => sim.as('cashier', () => idem.executeWithKey({ key, path: '/api/v1/pos/checkout', requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await pos.checkout(body as any) }) }))));
        rec.rules.push(compare('D10 triple-tap with one key → one invoice', before + 1, await sim.db.invoice.count({ where: { organizationId: sim.organizationId } })));
        const esp = intendedSale([{ sku: 'E', qty: 1, unitPrice: L1.price.ESPRESSO, taxRate: VAT }]);
        book('COUNTER', 'card', esp.gross, esp.tax); consume([{ kind: 'menu', sku: 'ESPRESSO', qty: 1 }]);
        break;
      }
      case 11: {
        const start = new Date(Date.now() - 6 * 86400_000), end = new Date(Date.now() - 2 * 86400_000);
        const period = await sim.db.fiscalPeriod.create({ data: { organizationId: sim.organizationId, name: 'SIM-15D-PREV', startDate: start, endDate: end } });
        const inPeriod = await sale('cashier', 'COUNTER', [{ kind: 'menu', sku: 'BURGER', qty: 1 }], 'card', { occurredAt: new Date(end.getTime() - 86400_000).toISOString() });
        await drain();
        let closed = 'ok';
        await sim.as('manager', () => periods.close(period.id)).catch((e) => { closed = e.message; });
        rec.rules.push({ rule: 'D11 period closed', status: closed === 'ok' ? 'PASS' : 'FAIL', actual: closed.slice(0, 140) });
        // Closing zeroes the period's income into retained earnings: that sale's net revenue leaves the revenue account.
        if (closed === 'ok') L1.closedRevenue = L1.closedRevenue.plus(inPeriod.want.gross.minus(inPeriod.want.tax));
        let backdated = false;
        await sim.as('manager', () => posting.post({ journalCode: 'GEN', date: new Date(end.getTime() - 3600_000).toISOString(), description: 'backdated', sourceType: 'manual', sourceId: randomUUID(), lines: [{ accountId: sim.acc.expense, debit: '500' }, { accountId: sim.acc.safe, credit: '500' }] } as any)).catch(() => { backdated = true; });
        rec.rules.push({ rule: 'D11 backdated journal into closed period refused', status: backdated ? 'PASS' : 'FAIL' });
        break;
      }
      case 12: {
        await sim.db.menuItem.update({ where: { id: sim.menu.CAPP_M }, data: { basePrice: 11_000 } });
        L1.price.CAPP_M = 11_000;
        await sim.db.menuProduct.updateMany({ where: { menuItemId: sim.menu.CAPP_M, productId: sim.prod.MILK_ML }, data: { quantity: 180 } });
        MENU.CAPP_M.recipe.MILK_ML = 180;
        rec.notes.push('D12: cappuccino price 10,000 → 11,000 and milk 200 → 180 ml from this morning');
        break;
      }
      case 13: {
        const audit = sim.get(AuditService);
        const key = randomUUID();
        const body = { cashSessionId: sessions.COUNTER, partnerId: sim.acc.walkin, lines: itemsToLines([{ kind: 'menu', sku: 'BURGER', qty: 1 }]), tenders: [{ method: 'card', amount: L1.price.BURGER, reference: randomUUID() }] };
        const attempt = () => sim.as('cashier', () => idem.executeWithKey({ key, path: '/api/v1/pos/checkout', requestHash: 'crash', runHandler: async () => ({ statusCode: 201, body: await pos.checkout(body as any) }) }));
        const before = await sim.db.invoice.count({ where: { organizationId: sim.organizationId } });
        const spy = jest.spyOn(audit, 'recordInTx').mockRejectedValueOnce(new Error('simulated crash inside the sale transaction'));
        await attempt().catch(() => undefined);
        spy.mockRestore();
        rec.rules.push(compare('D13 crashed sale left no invoice', before, await sim.db.invoice.count({ where: { organizationId: sim.organizationId } })));
        await sim.raw.$executeRawUnsafe(`UPDATE "IdempotencyRecord" SET "createdAt" = "createdAt" - interval '10 minutes' WHERE key = $1`, key);
        await attempt();
        await attempt();
        rec.rules.push(compare('D13 retry after crash → exactly one invoice', before + 1, await sim.db.invoice.count({ where: { organizationId: sim.organizationId } })));
        const want = intendedSale([{ sku: 'B', qty: 1, unitPrice: L1.price.BURGER, taxRate: VAT }]);
        book('COUNTER', 'card', want.gross, want.tax); consume([{ kind: 'menu', sku: 'BURGER', qty: 1 }]);
        break;
      }
      default:
        break;
    }
  }

  // ═══════════════ Final certification checks ═══════════════
  run('C-DAY-01', 'Close-out: bank the last day, settle clearing, AP/AR/stock valuation tie, preflight READY', 'P0', async (rec) => {
    for (const till of ['COUNTER', 'BAR']) {
      if (yesterday!.cash[till].gt(0)) {
        await sim.as('manager', () => cash.recordBankDeposit(yesterday!.sessions[till], { amount: Number(yesterday!.cash[till]), bankName: 'Lakeview Bank', destinationAccountId: sim.acc.bank, reference: `SLIP-FINAL-${till}` } as any));
        L1.bank = L1.bank.plus(yesterday!.cash[till]);
      }
      await sim.as('manager', () => cash.reconcile(yesterday!.sessions[till], {}));
    }
    rec.rules.push(compare('CERT drawers empty', 0, (await sim.balance('drawer')).plus(await sim.balance('drawer2'))));
    rec.rules.push(compare('CERT bank GL = oracle', L1.bank, await sim.balance('bank')));
    rec.rules.push(compare('CERT AP control = supplier balance', L1.ap.negated(), await sim.balance('ap')));
    const sub: any[] = await sim.raw.$queryRawUnsafe(`SELECT COALESCE(SUM(quantity * "runningAverageCost"),0)::text v FROM "StockItem" WHERE "organizationId"=$1`, sim.organizationId);
    rec.rules.push(compare('CERT stock valuation (Σ qty × avg cost) = inventory + transit GL', D(sub[0].v).toDecimalPlaces(0), (await sim.balance('inventory')).plus(await sim.balance('transit')).toDecimalPlaces(0), undefined, '2'));
    const code = (await sim.db.organization.findUniqueOrThrow({ where: { id: sim.organizationId } })).code;
    let out = '';
    try { out = execFileSync(process.execPath, ['scripts/pos-release-preflight.cjs', '--code', code], { cwd: path.resolve(__dirname, '../../../..'), env: { ...process.env }, encoding: 'utf8' }); } catch (e: any) { out = e.stdout ?? ''; }
    const org = JSON.parse(out).organizations[0];
    rec.notes.push(...org.blockers.map((b: any) => `${b.check}: ${String(b.detail ?? '').slice(0, 140)}`));
    rec.rules.push({ rule: 'CERT release preflight READY after 15 days', status: org.status === 'READY' ? 'PASS' : 'FAIL', actual: org.status });
    const totals = legacySheets.reduce((a, s) => ({ sales: a.sales + s.sales, refunds: a.refunds + s.refunds, gross: a.gross.plus(s.gross) }), { sales: 0, refunds: 0, gross: D(0) });
    rec.notes.push(`15-day totals: ${totals.sales} sales, ${totals.refunds} refunds, net sales ${totals.gross} UGX, VAT ${L1.tax}`);
  });

  run('SHADOW-01', 'Shadow pilot (simulated, D8–D14): legacy day sheets vs new POS Z reports and ledger', 'P0', async (rec) => {
    const days = legacySheets.filter((s) => s.day >= 8);
    let matched = 0;
    for (const s of days) {
      const z = dayZ[s.day] ?? {};
      const zCash = D(z.COUNTER?.closingExpected ?? -1).plus(D(z.BAR?.closingExpected ?? -1));
      const legacyCash = s.cash.COUNTER.plus(s.cash.BAR);
      const zGross = D(z.COUNTER?.totals?.netSalesAfterRefunds ?? 0).plus(D(z.BAR?.totals?.netSalesAfterRefunds ?? 0));
      const zVat = D(z.COUNTER?.totals?.taxAfterRefunds ?? 0).plus(D(z.BAR?.totals?.taxAfterRefunds ?? 0));
      const cashOk = zCash.eq(legacyCash), grossOk = zGross.eq(s.gross), vatOk = zVat.eq(s.tax);
      rec.rules.push(compare(`SHADOW D${s.day} till cash: legacy sheet = POS Z`, legacyCash, zCash));
      rec.rules.push(compare(`SHADOW D${s.day} net sales: legacy sheet = POS Z`, s.gross, zGross));
      rec.rules.push(compare(`SHADOW D${s.day} VAT: legacy sheet = POS Z`, s.tax, zVat));
      if (cashOk && grossOk && vatOk) matched++;
    }
    rec.notes.push(`${matched}/${days.length} consecutive shadow days matched on cash, net sales and VAT`);
    rec.rules.push(compare('SHADOW consecutive green days (promotion rule: 7)', 7, matched));
  });
});
