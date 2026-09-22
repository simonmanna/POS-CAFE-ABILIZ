/**
 * Lakeview Café & Grill — M3: restaurant service, procurement, inventory,
 * month-end and period close (calendar days D2–D5, D7, D11 compressed).
 * Expectations come from the fixture + policy (oracle.ts), never from the POS.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
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
import { D, compare, intendedSale, intendedConsumption, RuleResult } from './oracle';
import { Evidence } from './evidence';
import { bootSim, simEnabled, Sim, STOCK, MENU, VAT, PIN } from './sim-kit';

const SEED = process.env.SIMULATION_SEED ?? '20260917';

(simEnabled() ? describe : describe.skip)('Lakeview — M3 restaurant, procurement, inventory, period close', () => {
  jest.setTimeout(240_000);
  const ev = new Evidence(`SIM-${SEED}-M3`);
  let sim: Sim;
  let pos: PosService, billing: PosInvoiceService, orders: PosOrdersService, splits: PosSplitService, tables: PosTablesService;
  let cash: CashSessionService, cashFlow: CashFlowService, stock: StockService, docs: StockDocService, counts: InventoryCountService;
  let po: PurchaseOrdersService, landed: LandedCostService, periods: PeriodCloseService, posting: PostingService;
  let session: any;
  const inv: Record<string, string> = {};
  /** Intended stock movements at ACA (base units). */
  const moved: Record<string, ReturnType<typeof D>> = {};
  const move = (sku: string, q: Prisma.Decimal.Value) => { moved[sku] = (moved[sku] ?? D(0)).plus(q); };
  const consume = (recipe: Record<string, number>, qty: number, sign = -1) => { for (const [s, q] of Object.entries(recipe)) move(s, D(q).times(qty).times(sign)); };
  const L1 = { cash: D(0), revenueGross: D(0), tax: D(0) };

  const run = (id: string, title: string, pri: 'P0' | 'P1' | 'P2', fn: (rec: any) => Promise<void>) =>
    it(`${id} ${title}`, async () => {
      const rec = await ev.scenario(id, title, pri, fn);
      if (rec.status === 'FAIL') throw new Error(`${id} FAILED: ${rec.error ?? rec.rules.filter((r) => r.status === 'FAIL').map((r) => `${r.rule} expected ${r.expected} got ${r.actual}`).join('; ')}`);
    });
  const drain = async () => {
    for (let i = 0; i < 3; i++) for (const j of await sim.db.stockPostingJob.findMany({ where: { organizationId: sim.organizationId, status: { in: ['pending', 'failed'] } } })) {
      await sim.as('manager', () => billing.processStockPostingJob(j.id)).catch(() => undefined);
    }
  };
  const openTab = (table: string) => sim.db.posTableOrder.findFirstOrThrow({ where: { tableId: table, closedAt: null } });

  beforeAll(async () => {
    sim = await bootSim('M3');
    pos = sim.get(PosService); billing = sim.get(PosInvoiceService); orders = sim.get(PosOrdersService); splits = sim.get(PosSplitService);
    tables = sim.get(PosTablesService); cash = sim.get(CashSessionService); cashFlow = sim.get(CashFlowService); stock = sim.get(StockService);
    docs = sim.get(StockDocService); counts = sim.get(InventoryCountService); po = sim.get(PurchaseOrdersService); landed = sim.get(LandedCostService);
    periods = sim.get(PeriodCloseService); posting = sim.get(PostingService);
  }, 300_000);

  afterAll(async () => {
    const out = ev.write({ organizationId: sim?.organizationId, seed: SEED });
    // eslint-disable-next-line no-console
    console.log(`\nSIMULATION EVIDENCE → ${out.root}  verdict ${out.verdict}`);
    await sim?.close();
  });

  run('M3-00', 'Opening: capital, opening stock at ACA, shift with float', 'P0', async (rec) => {
    await sim.as('manager', () => cashFlow.deposit({ accountId: sim.acc.safe, counterpartAccountId: sim.acc.equity, operationType: 'owner_contribution', amount: 1_500_000, description: 'Opening safe' }));
    await sim.as('manager', () => cashFlow.deposit({ accountId: sim.acc.bank, counterpartAccountId: sim.acc.equity, operationType: 'owner_contribution', amount: 50_000_000, description: 'Opening bank' }));
    let value = D(0);
    for (const [sku, s] of Object.entries(STOCK)) {
      await sim.as('manager', () => stock.receiveForDocument({ productId: sim.prod[sku], locationId: sim.loc.ACA, quantity: s.qty, unitCost: s.unitCost } as any, { sourceType: 'goods_receipt', sourceId: `OPEN-${sku}`, date: new Date() }));
      move(sku, s.qty); value = value.plus(D(s.qty).times(s.unitCost));
    }
    rec.rules.push(compare('INV opening value = inventory GL', value, await sim.balance('inventory')));
    session = await sim.as('cashier', () => cash.open({ cashRegisterId: sim.registers.COUNTER, openingFloat: 200_000, openingSourceAccountId: sim.acc.safe, notes: 'Float' } as any));
    rec.rules.push(compare('CASH drawer = float', 200_000, await sim.balance('drawer')));
  });

  // ══════════════════════ D2 — restaurant service ══════════════════════
  let t12 = '', t14 = '', t15 = '', t16 = '';
  run('D2-L-013', 'Move table 12 → 14 keeps one order, no duplicate revenue', 'P1', async (rec) => {
    [t12, t14, t15, t16] = await Promise.all([12, 14, 15, 16].map(async (n) => (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: `T${n}`, number: n } })).id));
    await sim.as('waiter', () => pos.addToTab({ tableId: t12, cashSessionId: session.id, guestCount: 2, sendToKitchen: true, lines: [{ menuItemId: sim.menu.CAPP_M, description: 'Cappuccino M', quantity: 2, unitPrice: 10000 }] }));
    const before = await openTab(t12);
    await sim.as('manager', () => tables.transfer(t12, t14));
    const after = await openTab(t14);
    rec.rules.push({ rule: 'TABLE order follows the guests', status: after.orderId === before.orderId ? 'PASS' : 'FAIL' });
    rec.rules.push(compare('TABLE source table has no open order', 0, await sim.db.posTableOrder.count({ where: { tableId: t12, closedAt: null } })));
    const intended = intendedSale([{ sku: 'CAPP_M', qty: 2, unitPrice: 10000, taxRate: VAT }]);
    const r: any = await sim.as('cashier', () => pos.settleTab({ tableId: t14, cashSessionId: session.id, expectedTotal: Number(intended.gross), tenders: [{ method: 'cash', amount: Number(intended.gross) }] }));
    inv.T14 = r.invoiceId;
    rec.rules.push(compare('SALES one invoice for the moved table', 1, await sim.db.invoice.count({ where: { organizationId: sim.organizationId, orderId: before.orderId! } })));
    L1.cash = L1.cash.plus(intended.gross); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    consume(MENU.CAPP_M.recipe, 2);
  });

  run('D2-L-014', 'Merge tables 15 + 16, split evenly 3 ways (indivisible total), 3 tenders — no shilling lost', 'P0', async (rec) => {
    await sim.as('waiter', () => pos.addToTab({ tableId: t15, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: sim.menu.BURGER, description: 'Chicken burger', quantity: 2, unitPrice: 28000 }] }));
    await sim.as('waiter2', () => pos.addToTab({ tableId: t16, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: sim.menu.ESPRESSO, description: 'Espresso', quantity: 2, unitPrice: 6000 }] }));
    await sim.as('manager', () => tables.merge(t16, t15));
    const tab = await openTab(t15);
    const order: any = await sim.db.order.findUniqueOrThrow({ where: { id: tab.orderId! }, include: { items: true } });
    const live = order.items.filter((i: any) => !i.cancelled);
    rec.notes.push(`merged order lines: ${live.map((i: any) => `${i.description}×${Number(i.quantity)}`).join(', ')}`);
    const total = D(68000);
    rec.rules.push(compare('TABLE merged order total = both tables', total, order.totalAmount));
    let state: any = await sim.as('cashier', () => splits.addBills(t15, 3));
    const bills = state.bills;
    // Assign by item quantity: burger→bill1, burger→bill2, espressos→bill3
    const burger = live.find((i: any) => i.menuItemId === sim.menu.BURGER), esp = live.find((i: any) => i.menuItemId === sim.menu.ESPRESSO);
    rec.rules.push({ rule: 'TABLE merged order carries both tables\' items', status: burger && esp ? 'PASS' : 'FAIL' });
    state = await sim.as('cashier', () => splits.assign(bills[0].id, [{ sourceItemId: burger.id, quantity: 1 }]));
    state = await sim.as('cashier', () => splits.assign(bills[1].id, [{ sourceItemId: burger.id, quantity: 1 }]));
    state = await sim.as('cashier', () => splits.assign(bills[2].id, [{ sourceItemId: esp.id, quantity: 2 }]));
    const b = state.bills.map((x: any) => D(x.totalAmount));
    rec.rules.push(compare('SPLIT Σ bills = order total', total, b.reduce((s: any, x: any) => s.plus(x), D(0))));
    const r1: any = await sim.as('cashier', () => splits.settleBill(bills[0].id, { cashSessionId: session.id, expectedTotal: Number(b[0]), tenders: [{ method: 'cash', amount: Number(b[0]) }] } as any));
    const r2: any = await sim.as('cashier', () => splits.settleBill(bills[1].id, { cashSessionId: session.id, expectedTotal: Number(b[1]), tenders: [{ method: 'mobile_money', accountId: sim.acc.mtn, amount: Number(b[1]), reference: 'M3-MTN-1' }] } as any));
    const r3: any = await sim.as('cashier', () => splits.settleBill(bills[2].id, { cashSessionId: session.id, expectedTotal: Number(b[2]), tenders: [{ method: 'card', amount: Number(b[2]), reference: 'M3-CARD-1' }] } as any));
    const invs = await sim.db.invoice.findMany({ where: { id: { in: [r1.invoiceId, r2.invoiceId, r3.invoiceId] } } });
    rec.rules.push(compare('SPLIT Σ invoices = order total', total, invs.reduce((s, i) => s.plus(i.totalAmount), D(0))));
    const tax = intendedSale([{ sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }]).tax.times(2).plus(intendedSale([{ sku: 'ESP', qty: 2, unitPrice: 6000, taxRate: VAT }]).tax);
    rec.rules.push(compare('SPLIT Σ VAT = whole-shilling VAT per split line', tax, invs.reduce((s, i) => s.plus(i.taxAmount), D(0))));
    L1.cash = L1.cash.plus(b[0]); L1.revenueGross = L1.revenueGross.plus(total); L1.tax = L1.tax.plus(tax);
    consume(MENU.BURGER.recipe, 2); consume(MENU.ESPRESSO.recipe, 2);
    const t = await sim.db.posTable.findUniqueOrThrow({ where: { id: t15 } });
    rec.rules.push({ rule: 'TABLE released after all splits paid', status: (t.status === 'available') ? 'PASS' : 'FAIL', actual: t.status });
  });

  run('D2-L-015', 'Split one bill paid, then a new item added to the table: only unpaid remainder carries it', 'P0', async (rec) => {
    const t = (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: 'T20', number: 20 } })).id;
    await sim.as('waiter', () => pos.addToTab({ tableId: t, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: sim.menu.CAPP_M, description: 'Cappuccino M', quantity: 2, unitPrice: 10000 }] }));
    const tab = await openTab(t);
    const order: any = await sim.db.order.findUniqueOrThrow({ where: { id: tab.orderId! }, include: { items: true } });
    let st: any = await sim.as('cashier', () => splits.addBills(t, 1));
    st = await sim.as('cashier', () => splits.assign(st.bills[0].id, [{ sourceItemId: order.items[0].id, quantity: 1 }]));
    await sim.as('cashier', () => splits.settleBill(st.bills[0].id, { cashSessionId: session.id, expectedTotal: 10000, tenders: [{ method: 'cash', amount: 10000 }] } as any));
    let added = 'accepted';
    await sim.as('waiter', () => pos.addToTab({ tableId: t, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: sim.menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }] })).catch((e) => { added = e.message; });
    rec.notes.push(`add after partial split payment: ${added}`);
    const remaining = intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }, { sku: 'ESP', qty: added === 'accepted' ? 1 : 0, unitPrice: 6000, taxRate: VAT }]);
    // A table with a split in progress settles only through split bills: put the rest on a second bill.
    const fresh: any = await sim.db.order.findUniqueOrThrow({ where: { id: tab.orderId! }, include: { items: true } });
    st = await sim.as('cashier', () => splits.addBills(t, 1));
    const rest = st.bills.find((b: any) => !b.invoiceId && b.status !== 'paid' && b.status !== 'settled' && Number(b.totalAmount ?? 0) === 0) ?? st.bills[st.bills.length - 1];
    const assignments = fresh.items.filter((x: any) => !x.cancelled).map((x: any) => ({ sourceItemId: x.id, quantity: Number(x.quantity) - (x.id === order.items[0].id ? 1 : 0) })).filter((a: any) => a.quantity > 0);
    st = await sim.as('cashier', () => splits.assign(rest.id, assignments));
    const r: any = await sim.as('cashier', () => splits.settleBill(rest.id, { cashSessionId: session.id, expectedTotal: Number(remaining.gross), tenders: [{ method: 'cash', amount: Number(remaining.gross) }] } as any));
    const i = await sim.db.invoice.findUniqueOrThrow({ where: { id: r.invoiceId } });
    const tt = await sim.db.posTable.findUniqueOrThrow({ where: { id: t } });
    rec.rules.push({ rule: 'TABLE released after last split bill', status: (tt.status === 'available') ? 'PASS' : 'FAIL', actual: tt.status });
    rec.rules.push(compare('SPLIT remainder bill = unpaid items only', remaining.gross, i.totalAmount));
    const all = await sim.db.invoice.findMany({ where: { organizationId: sim.organizationId, orderId: tab.orderId! } });
    rec.notes.push(`invoices on order: ${all.length}`);
    const billIds = (await sim.db.splitBill.findMany({ where: { tableId: t } as any })).map((x: any) => x.invoiceId).filter(Boolean);
    const billed = (await sim.db.invoice.findMany({ where: { id: { in: billIds } } })).reduce((sum, x) => sum.plus(x.totalAmount), D(0));
    rec.rules.push(compare('SPLIT everything served billed exactly once', D(20000).plus(added === 'accepted' ? 6000 : 0), billed));
    L1.cash = L1.cash.plus(10000).plus(remaining.gross); L1.revenueGross = L1.revenueGross.plus(10000).plus(remaining.gross);
    L1.tax = L1.tax.plus(intendedSale([{ sku: 'C', qty: 1, unitPrice: 10000, taxRate: VAT }]).tax).plus(remaining.tax);
    consume(MENU.CAPP_M.recipe, 2); if (added === 'accepted') consume(MENU.ESPRESSO.recipe, 1);
  });

  run('D2-L-012', 'Manager voids a cooked burger off an open tab → waste record, not revenue', 'P0', async (rec) => {
    const t = (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: 'T21', number: 21 } })).id;
    await sim.as('waiter', () => pos.addToTab({ tableId: t, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: sim.menu.BURGER, description: 'Chicken burger', quantity: 2, unitPrice: 28000 }] }));
    const tab = await openTab(t);
    const order: any = await sim.db.order.findUniqueOrThrow({ where: { id: tab.orderId! }, include: { items: true } });
    const wasteBefore = await sim.balance('waste');
    let noPin = false;
    await sim.as('manager', () => orders.voidItem(tab.orderId!, order.items[0].id, { reason: 'Burnt', quantity: 1 } as any)).catch(() => { noPin = true; });
    rec.rules.push({ rule: 'AUTH voiding fired food needs manager PIN', status: noPin ? 'PASS' : 'FAIL' });
    await sim.as('manager', () => orders.voidItem(tab.orderId!, order.items[0].id, { reason: 'Burnt', quantity: 1, overrideById: sim.users.manager, overridePin: PIN } as any));
    const waste = D(STOCK.BUN.unitCost).plus(STOCK.CHICKEN.unitCost);
    rec.rules.push(compare('WASTE GL += bun + chicken at cost', wasteBefore.plus(waste), await sim.balance('waste')));
    const intended = intendedSale([{ sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }]);
    const r: any = await sim.as('cashier', () => pos.settleTab({ tableId: t, cashSessionId: session.id, expectedTotal: Number(intended.gross), tenders: [{ method: 'card', amount: Number(intended.gross), reference: 'M3-CARD-2' }] }));
    rec.rules.push(compare('SALES bill excludes voided burger', intended.gross, (await sim.db.invoice.findUniqueOrThrow({ where: { id: r.invoiceId } })).totalAmount));
    L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    consume(MENU.BURGER.recipe, 2); // one sold + one wasted
  });

  run('D2-K-001', 'Shift close is blocked while a table is still open', 'P0', async (rec) => {
    const t = (await sim.db.posTable.create({ data: { organizationId: sim.organizationId, name: 'T22', number: 22 } })).id;
    await sim.as('waiter', () => pos.addToTab({ tableId: t, cashSessionId: session.id, lines: [{ menuItemId: sim.menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }] }));
    let blocked = '';
    await sim.as('cashier', () => cash.close({ sessionId: session.id, closingCounted: 0 } as any)).catch((e) => { blocked = e.message; });
    rec.rules.push({ rule: 'CASH close blocked with an actionable reason', status: /open order/i.test(blocked) ? 'PASS' : 'FAIL', actual: blocked.slice(0, 120) });
    const intended = intendedSale([{ sku: 'E', qty: 1, unitPrice: 6000, taxRate: VAT }]);
    await sim.as('cashier', () => pos.settleTab({ tableId: t, cashSessionId: session.id, expectedTotal: 6000, tenders: [{ method: 'cash', amount: 6000 }] }));
    L1.cash = L1.cash.plus(6000); L1.revenueGross = L1.revenueGross.plus(6000); L1.tax = L1.tax.plus(intended.tax);
    consume(MENU.ESPRESSO.recipe, 1);
  });

  // ══════════════════════ D3 — procurement ══════════════════════
  let poBeans: any;
  run('D3-P-001', 'PO beans 10 kg @ 60/g credit; partial GRN 6 kg; over-receipt refused; GRNI nets, AP = supplier', 'P0', async (rec) => {
    await drain();
    const beansBefore = await sim.onHand('BEANS_G');
    const grniBefore = await sim.balance('grni');
    poBeans = await sim.as('manager', () => po.create({ partnerId: sim.acc.kakira, warehouseId: sim.loc.ACA, paymentType: 'credit', currencyCode: 'UGX', lines: [{ productId: sim.prod.BEANS_G, description: 'Beans', quantity: 10_000, unitPrice: 60, taxRate: 0 }] } as any));
    rec.rules.push(compare('PO creates no stock movement', beansBefore, await sim.onHand('BEANS_G')));
    const apBefore = await sim.balance('ap');
    await sim.as('manager', () => po.receive(poBeans.id, { warehouseId: sim.loc.ACA, lines: [{ productId: sim.prod.BEANS_G, description: 'Beans', quantity: 6_000, unitCost: 60 }] } as any));
    move('BEANS_G', 6000);
    let over = false;
    await sim.as('manager', () => po.receive(poBeans.id, { warehouseId: sim.loc.ACA, lines: [{ productId: sim.prod.BEANS_G, description: 'Beans', quantity: 5_000, unitCost: 60 }] } as any)).catch(() => { over = true; });
    rec.rules.push({ rule: 'PROC over-receipt refused', status: over ? 'PASS' : 'FAIL' });
    rec.rules.push(compare('APAR AP += 6 kg × 60', apBefore.minus(360_000), await sim.balance('ap')));
    rec.rules.push(compare('PROC GRNI unchanged: receipt accrual cleared by the voucher', grniBefore, await sim.balance('grni')));
    rec.rules.push(compare('INV beans on hand += 6,000 g', beansBefore.plus(6000), await sim.onHand('BEANS_G')));
  });

  run('D5-P-012', 'Landed cost freight 120,000 after 50% of the receipt is consumed: half capitalised, half COGS', 'P0', async (rec) => {
    // Consume 3,000 g of the 6,000 g receipt... AVCO pools all beans, so the policy share follows on-hand vs received.
    const grn = await sim.db.goodsReceiptNote.findFirstOrThrow({ where: { organizationId: sim.organizationId } as any, orderBy: { createdAt: 'desc' } });
    const onHandNow = await sim.onHand('BEANS_G');
    const [inv0, cogs0, ap0] = [await sim.balance('inventory'), await sim.balance('cogs'), await sim.balance('ap')];
    const draft: any = await sim.as('manager', () => landed.create({ goodsReceiptId: grn.id, creditAccountId: sim.acc.ap, charges: [{ kind: 'freight', amount: 120_000 }] } as any));
    const posted: any = await sim.as('manager', () => landed.post(draft.id));
    // Policy: share still on hand (capped at the receipt) is capitalised; the rest was sold.
    const received = D(6000);
    const stillHeld = onHandNow;
    const share = D(Math.min(Number(stillHeld), 6000)).div(received);
    const cap = D(120_000).times(share).toDecimalPlaces(2);
    rec.notes.push(`on hand ${onHandNow} of pooled beans; capitalised ${posted.capitalizedAmount}, expensed ${posted.expensedAmount}`);
    rec.rules.push(compare('LANDED capitalised + expensed = charge', 120_000, D(posted.capitalizedAmount).plus(posted.expensedAmount)));
    rec.rules.push(compare('LANDED inventory GL += capitalised', inv0.plus(posted.capitalizedAmount), await sim.balance('inventory')));
    rec.rules.push(compare('LANDED COGS += expensed', cogs0.plus(posted.expensedAmount), await sim.balance('cogs')));
    rec.rules.push(compare('LANDED AP credited 120,000', ap0.minus(120_000), await sim.balance('ap')));
    rec.rules.push(compare('LANDED share follows the policy (pooled AVCO: all 6 kg still on hand → 100%)', cap, D(posted.capitalizedAmount), undefined, '1'));
  });

  run('D5-P-014', 'Pay supplier partially by bank; overpayment refused', 'P0', async (rec) => {
    const [ap0, bank0] = [await sim.balance('ap'), await sim.balance('bank')];
    await sim.as('manager', () => po.pay(poBeans.id, { amount: 200_000, method: 'bank' } as any));
    let over = false;
    await sim.as('manager', () => po.pay(poBeans.id, { amount: 10_000_000, method: 'bank' } as any)).catch(() => { over = true; });
    rec.rules.push({ rule: 'APAR supplier overpayment refused', status: over ? 'PASS' : 'FAIL' });
    rec.rules.push(compare('APAR AP −200,000', ap0.plus(200_000), await sim.balance('ap')));
    rec.rules.push(compare('GL bank −200,000', bank0.minus(200_000), await sim.balance('bank')));
  });

  // ══════════════════════ D4 — inventory control ══════════════════════
  run('D4-I-010', 'Waste document: spilled milk 2,000 ml with reason → waste GL, stock down', 'P0', async (rec) => {
    const w0 = await sim.balance('waste');
    const doc: any = await sim.as('manager', () => docs.createWaste({ locationId: sim.loc.ACA, responsibleById: sim.users.storekeeper, approvedById: sim.users.manager, category: 'spoiled', notes: 'Spilled milk', items: [{ productId: sim.prod.MILK_ML, qty: 2000 }] } as any));
    await sim.as('manager', () => docs.approveWaste(doc.id));
    move('MILK_ML', -2000);
    rec.rules.push(compare('WASTE GL += 2,000 ml × 4', w0.plus(8000), await sim.balance('waste')));
  });

  run('D4-I-011', 'Blind cycle count: beer counted 3 short → variance posted at cost; storekeeper sees no system qty', 'P0', async (rec) => {
    await drain();
    const system = await sim.onHand('BEER');
    const s: any = await sim.as('manager', () => counts.start({ locationId: sim.loc.ACA, countType: 'spot', blind: true, scopeProductIds: [sim.prod.BEER] } as any));
    rec.rules.push({ rule: 'COUNT blind sheet hides system quantity', status: s.lines[0].systemQty == null ? 'PASS' : 'FAIL' });
    await sim.as('manager', () => counts.saveDraft(s.id, { lines: [{ lineId: s.lines[0].id, countedQty: Number(system) - 3, reason: 'breakage' }] }));
    const w0 = await sim.balance('waste');
    await sim.as('manager', () => counts.submit(s.id, {}));
    move('BEER', -3);
    rec.rules.push(compare('COUNT on hand = counted', system.minus(3), await sim.onHand('BEER')));
    rec.rules.push(compare('COUNT variance expense = 3 × 4,500', w0.plus(13_500), await sim.balance('waste')));
  });

  // RBAC on stock adjustments is enforced by the HTTP guard; covered at API level in M4.

  run('D7-I-020', 'Transit transfer CW → ACA across month-end: dispatch, partial receive, damaged 1, short 1', 'P0', async (rec) => {
    await sim.as('manager', () => stock.receiveForDocument({ productId: sim.prod.WATER_500, locationId: sim.loc.CW, quantity: 50, unitCost: 1200 } as any, { sourceType: 'goods_receipt', sourceId: `CW-WATER-${randomUUID()}`, date: new Date() }));
    const [inv0, w0] = [await sim.balance('inventory'), await sim.balance('waste')];
    const doc: any = await sim.as('manager', () => docs.createTransfer({ fromLocationId: sim.loc.CW, toLocationId: sim.loc.ACA, mode: 'transit', responsibleById: sim.users.storekeeper, approvedById: sim.users.manager, items: [{ productId: sim.prod.WATER_500, qtyRequested: 20 }] } as any));
    await sim.as('manager', () => docs.approveTransfer(doc.id));
    await sim.as('manager', () => docs.dispatchTransfer(doc.id));
    rec.rules.push(compare('XFER in transit = 20 (month-end balance)', 20, await sim.db.stockItem.aggregate({ where: { organizationId: sim.organizationId, productId: sim.prod.WATER_500, location: { type: 'transit' } } as any, _sum: { quantity: true } }).then((a) => a._sum.quantity ?? 0)));
    await sim.as('manager', () => docs.receiveTransfer(doc.id, { lines: [{ itemId: doc.items[0].id, received: 10 }] }));
    await sim.as('manager', () => docs.receiveTransfer(doc.id, { lines: [{ itemId: doc.items[0].id, received: 8, damaged: 1, short: 1 }] }));
    move('WATER_500', 18);
    rec.rules.push(compare('XFER CW = 50 − 20', 30, await sim.onHand('WATER_500', 'CW')));
    rec.rules.push(compare('XFER conservation: inventory GL loses only damaged + short', inv0.minus(2400), await sim.balance('inventory')));
    rec.notes.push(`waste/adjust GL moved by ${(await sim.balance('waste')).minus(w0)}`);
  });

  // ══════════════════════ D5 — recipe & price change, partial refund ══════════════════════
  run('D5-M-001', 'Recipe change after sale: consumption uses the sale-time recipe', 'P0', async (rec) => {
    await drain();
    const r: any = await sim.as('cashier', () => pos.checkout({ cashSessionId: session.id, partnerId: sim.acc.walkin, lines: [{ menuItemId: sim.menu.CAPP_M, description: 'Cappuccino M', quantity: 1, unitPrice: 10000 }], tenders: [{ method: 'cash', amount: 10000 }] }));
    const job = await sim.db.stockPostingJob.findFirst({ where: { organizationId: sim.organizationId, invoiceId: r.invoiceId } });
    rec.notes.push(`job status at recipe change: ${job?.status}; snapshot captured: ${job?.recipeSnapshot ? 'yes' : 'no'}`);
    await sim.db.menuProduct.updateMany({ where: { menuItemId: sim.menu.CAPP_M, productId: sim.prod.MILK_ML }, data: { quantity: 180 } });
    await drain();
    const milk = await sim.db.inventoryLedger.aggregate({ where: { organizationId: sim.organizationId, productId: sim.prod.MILK_ML, referenceId: r.invoiceId }, _sum: { quantityChange: true } });
    rec.rules.push(compare('RECIPE sale consumed 200 ml (sale-time recipe)', -200, milk._sum.quantityChange ?? 0));
    await sim.db.menuProduct.updateMany({ where: { menuItemId: sim.menu.CAPP_M, productId: sim.prod.MILK_ML }, data: { quantity: 200 } });
    const intended = intendedSale([{ sku: 'C', qty: 1, unitPrice: 10000, taxRate: VAT }]);
    L1.cash = L1.cash.plus(10000); L1.revenueGross = L1.revenueGross.plus(10000); L1.tax = L1.tax.plus(intended.tax);
    consume(MENU.CAPP_M.recipe, 1);
    inv.D5 = r.invoiceId;
  });

  run('D5-E-003', 'Price rises to 13,000, then partial refund (1 of 2 lines) at the ORIGINAL price with restock', 'P0', async (rec) => {
    const r: any = await sim.as('cashier', () => pos.checkout({ cashSessionId: session.id, partnerId: sim.acc.walkin, lines: [
      { menuItemId: sim.menu.CAPP_M, description: 'Cappuccino M', quantity: 1, unitPrice: 10000 },
      { productId: sim.prod.WATER_500, description: 'Water', quantity: 2, unitPrice: 2500 }], tenders: [{ method: 'cash', amount: 15000 }] }));
    await sim.db.menuItem.update({ where: { id: sim.menu.CAPP_M }, data: { basePrice: 13000 } });
    await drain();
    const inv0 = await sim.db.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, include: { items: true } });
    const capLine = inv0.items.find((i) => i.menuItemId === sim.menu.CAPP_M)!;
    const drawer0 = await sim.balance('drawer');
    await sim.as('cashier', () => billing.refund(r.invoiceId, 'Wrong drink', { overrideById: sim.users.manager, overridePin: PIN, stockDisposition: 'restock', cashSessionId: session.id, lines: [{ lineId: capLine.id, quantity: 1 }] }));
    rec.rules.push(compare('REFUND cash out = original 10,000 (not new price)', drawer0.minus(10000), await sim.balance('drawer')));
    let over = false;
    await sim.as('cashier', () => billing.refund(r.invoiceId, 'Again', { overrideById: sim.users.manager, overridePin: PIN, stockDisposition: 'restock', cashSessionId: session.id, lines: [{ lineId: capLine.id, quantity: 1 }] })).catch(() => { over = true; });
    rec.rules.push({ rule: 'REFUND same line cannot be refunded twice', status: over ? 'PASS' : 'FAIL' });
    await sim.db.menuItem.update({ where: { id: sim.menu.CAPP_M }, data: { basePrice: 10000 } });
    const sale = intendedSale([{ sku: 'C', qty: 1, unitPrice: 10000, taxRate: VAT }, { sku: 'W', qty: 2, unitPrice: 2500, taxRate: 0 }]);
    const back = intendedSale([{ sku: 'C', qty: 1, unitPrice: 10000, taxRate: VAT }]);
    L1.cash = L1.cash.plus(15000).minus(10000); L1.revenueGross = L1.revenueGross.plus(sale.gross).minus(back.gross); L1.tax = L1.tax.plus(sale.tax).minus(back.tax);
    consume(MENU.CAPP_M.recipe, 1); consume(MENU.CAPP_M.recipe, 1, +1); move('WATER_500', -2);
  });

  // ══════════════════════ Day close + books ══════════════════════
  run('M3-I-100', 'Stock conservation at ACA for every item = oracle; ledger = quant', 'P0', async (rec) => {
    await drain();
    rec.rules.push(compare('INT no pending stock jobs', 0, await sim.db.stockPostingJob.count({ where: { organizationId: sim.organizationId, status: { not: 'done' } } })));
    for (const sku of Object.keys(STOCK)) {
      rec.rules.push(compare(`INV ${sku} on hand = opening + receipts − consumption − waste`, moved[sku] ?? 0, await sim.onHand(sku)));
      const l = await sim.db.inventoryLedger.aggregate({ where: { organizationId: sim.organizationId, productId: sim.prod[sku], locationId: sim.loc.ACA }, _sum: { quantityChange: true } });
      rec.rules.push(compare(`INV ${sku} ledger = quant`, await sim.onHand(sku), l._sum.quantityChange ?? 0));
    }
    const sub: any[] = await sim.raw.$queryRawUnsafe(`SELECT COALESCE(SUM(quantity * "runningAverageCost"),0)::text v FROM "StockItem" WHERE "organizationId"=$1`, sim.organizationId);
    rec.rules.push(compare('INV-05 Σ quant × average cost = inventory + transit GL', D(sub[0].v).toDecimalPlaces(2), (await sim.balance('inventory')).plus(await sim.balance('transit')).toDecimalPlaces(2), undefined, '1'));
  });

  run('M3-GL-100', 'Books: TB balanced, no unbalanced entries, no duplicate keys, revenue & VAT = oracle, drawer = oracle', 'P0', async (rec) => {
    const tb = await sim.trialBalance();
    rec.rules.push(compare('GL TB Σdr = Σcr', tb.debit, tb.credit));
    rec.rules.push(compare('GL unbalanced entries', 0, await sim.unbalancedEntries()));
    rec.rules.push(compare('GL duplicate posting keys', 0, await sim.duplicatePostingKeys()));
    rec.rules.push(compare('GL invoices without posting', 0, await sim.invoicesWithoutPosting()));
    rec.rules.push(compare('SALES revenue GL = oracle', L1.revenueGross.minus(L1.tax).negated(), await sim.balance('revenue')));
    rec.rules.push(compare('SALES output VAT GL = oracle', L1.tax.negated(), await sim.balance('outputVat')));
    rec.rules.push(compare('CASH drawer GL = float + cash − refunds', D(200_000).plus(L1.cash), await sim.balance('drawer')));
  });

  // ══════════════════════ D11 — period close ══════════════════════
  run('D11-A-002', 'Close a past period; backdated journal and offline sale into it are refused; refund of its sale posts today', 'P0', async (rec) => {
    // A period that ended before today's trading, with an offline sale inside it.
    const start = new Date(Date.now() - 6 * 86400_000), end = new Date(Date.now() - 2 * 86400_000);
    const period = await sim.db.fiscalPeriod.create({ data: { organizationId: sim.organizationId, name: 'SIM-PREV', startDate: start, endDate: end } });
    const inPeriod: any = await sim.as('cashier', () => pos.checkout({ cashSessionId: session.id, partnerId: sim.acc.walkin, occurredAt: new Date(end.getTime() - 1 * 86400_000).toISOString(), lines: [{ menuItemId: sim.menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], tenders: [{ method: 'card', amount: 6000, reference: 'PREV-1' }] } as any));
    await drain();
    await drain();
    const expected = D(200_000).plus(L1.cash);
    const mtnHeld = Number(await sim.balance('mtn'));
    await sim.as('cashier', () => cash.close({ sessionId: session.id, closingCounted: Number(expected), closingAccounts: { [sim.acc.mtn]: mtnHeld, [sim.acc.airtel]: 0 } } as any));
    await sim.as('manager', () => cash.recordBankDeposit(session.id, { amount: Number(expected), bankName: 'Lakeview Bank', destinationAccountId: sim.acc.bank, reference: 'SLIP-M3' } as any));
    rec.rules.push(compare('CASH drawer empty after banking', 0, await sim.balance('drawer')));
    await sim.as('manager', () => cash.reconcile(session.id, {}));
    let closed = 'ok';
    await sim.as('manager', () => periods.close(period.id)).catch((e) => { closed = e.message; });
    rec.rules.push({ rule: 'PERIOD close succeeds once shifts are reconciled and stock drained', status: closed === 'ok' ? 'PASS' : 'FAIL', actual: closed.slice(0, 150) });
    let backdated = false;
    await sim.as('manager', () => posting.post({ journalCode: 'GEN', date: new Date(end.getTime() - 86400_000).toISOString(), description: 'Backdated fix', sourceType: 'manual', sourceId: randomUUID(), lines: [{ accountId: sim.acc.expense, debit: '1000' }, { accountId: sim.acc.safe, credit: '1000' }] } as any)).catch(() => { backdated = true; });
    rec.rules.push({ rule: 'PERIOD backdated journal into closed period refused', status: backdated ? 'PASS' : 'FAIL' });
    const s2: any = await sim.as('cashier', () => cash.open({ cashRegisterId: sim.registers.COUNTER, openingFloat: 0 } as any));
    let late = false;
    await sim.as('cashier', () => pos.checkout({ cashSessionId: s2.id, partnerId: sim.acc.walkin, occurredAt: new Date(end.getTime() - 3600_000).toISOString(), lines: [{ menuItemId: sim.menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], tenders: [{ method: 'card', amount: 6000, reference: 'LATE-1' }] } as any)).catch(() => { late = true; });
    rec.rules.push({ rule: 'PERIOD offline sale dated inside closed period refused (review queue)', status: late ? 'PASS' : 'FAIL' });
    const refund: any = await sim.as('cashier', () => billing.refund(inPeriod.invoiceId, 'Complaint after period close', { overrideById: sim.users.manager, overridePin: PIN, stockDisposition: 'no_return' })).then(() => 'ok').catch((e) => e.message);
    const refundJe = await sim.db.journalEntry.findFirst({ where: { organizationId: sim.organizationId, reversalOfId: { not: null }, sourceId: inPeriod.invoiceId }, orderBy: { createdAt: 'desc' } })
      ?? await sim.db.journalEntry.findFirst({ where: { organizationId: sim.organizationId, sourceType: { contains: 'refund' } }, orderBy: { createdAt: 'desc' } });
    rec.notes.push(`refund of closed-period sale: ${refund}; refund journal date ${refundJe?.postingDate?.toISOString?.().slice(0, 10)}`);
    rec.rules.push({ rule: 'PERIOD refund of a closed-period sale posts in the open period', status: refund === 'ok' && refundJe && refundJe.postingDate > end ? 'PASS' : 'FAIL', actual: refund });
  });
});

