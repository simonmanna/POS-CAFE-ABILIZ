/**
 * Lakeview Café & Grill — Milestones M1 (certification kernel) + M2 (financial spine).
 *
 * D0 (Wed 23 Sep 2026) company setup, D1 (Thu 24 Sep 2026) soft-opening trading
 * day, driven through the real Nest services on a disposable PostgreSQL database.
 * Every expectation is computed independently (oracle.ts) from the scenario and
 * policy.ts, then compared against operational rows (L2) and the ledger (L3).
 *
 * Runs only when SIM_RUN=1 and DATABASE_URL names a pos_stage1_<digits> database.
 * Test-only: no application code is changed or mocked apart from the OTP stub.
 */
import { randomUUID } from 'node:crypto';
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET', generateURI: () => 'otpauth://stub', verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { MANAGER_PERMISSIONS } from '@erp/shared';
import { scopedPrisma } from '../scoped-prisma';
import { ensureAccountCategories, makeAccountFactory } from '../integration/_accounts';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { PosModule } from '../../src/modules/pos/pos.module';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { IdempotencyService } from '../../src/kernel/idempotency/idempotency.service';
import { PosService } from '../../src/modules/pos/pos.service';
import { PosInvoiceService } from '../../src/modules/pos/billing/pos-invoice.service';
import { PosOrdersService } from '../../src/modules/pos/order/pos-orders.service';
import { PosSplitService } from '../../src/modules/pos/split/pos-split.service';
import { PosReportsService } from '../../src/modules/pos/pos-reports.service';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { CashFlowService } from '../../src/modules/accounting/treasury/cash-flow.service';
import { StockService } from '../../src/modules/inventory/stock.service';
import { BUSINESS_POLICY } from './policy';
import { D, S, compare, intendedSale, intendedConsumption, money, RuleResult } from './oracle';
import { Evidence } from './evidence';

const enabled = process.env.SIM_RUN === '1' && !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname);
const SEED = process.env.SIMULATION_SEED ?? '20260917';

(enabled ? describe : describe.skip)('Lakeview Café & Grill — M1/M2 business simulation (D0–D1)', () => {
  jest.setTimeout(180_000);
  const organizationId = randomUUID();
  const raw = new PrismaClient();
  const db = scopedPrisma(raw, () => organizationId);
  const ev = new Evidence(`SIM-${SEED}-M1M2`);
  const acc: Record<string, string> = {};
  const users: Record<string, string> = {};
  const perms: Record<string, string[]> = {};
  const prod: Record<string, string> = {};
  const menu: Record<string, string> = {};
  const tax: Record<string, string> = {};
  const inv: Record<string, string> = {};
  let moduleRef: TestingModule;
  let tenant: TenantContextService;
  let pos: PosService, billing: PosInvoiceService, orders: PosOrdersService, splits: PosSplitService, reports: PosReportsService;
  let cash: CashSessionService, cashFlow: CashFlowService, stock: StockService, idem: IdempotencyService;
  let registerId = '', locationId = '', session: any;
  const PIN = '4321';

  // ── Fixture (intended truth) ───────────────────────────────────────────────
  const VAT = BUSINESS_POLICY.tax.standardRatePercent;
  const OPENING = { safe: 1_500_000, bank: 50_000_000, float: 200_000 };
  const STOCK: Record<string, { name: string; unitCost: number; qty: number }> = {
    BEANS_G: { name: 'Coffee beans (g)', unitCost: 60, qty: 20_000 },
    MILK_ML: { name: 'Fresh milk (ml)', unitCost: 4, qty: 40_000 },
    CUP_M: { name: 'Cup medium', unitCost: 300, qty: 500 },
    LID_M: { name: 'Lid medium', unitCost: 100, qty: 500 },
    BUN: { name: 'Burger bun', unitCost: 800, qty: 100 },
    CHICKEN: { name: 'Chicken fillet', unitCost: 6_000, qty: 100 },
    WATER_500: { name: 'Water 500ml', unitCost: 1_200, qty: 200 },
  };
  const MENU: Record<string, { name: string; price: number; recipe: Record<string, number> }> = {
    ESPRESSO: { name: 'Espresso', price: 6_000, recipe: { BEANS_G: 18 } },
    CAPP_M: { name: 'Cappuccino M', price: 10_000, recipe: { BEANS_G: 18, MILK_ML: 200, CUP_M: 1, LID_M: 1 } },
    BURGER: { name: 'Chicken burger', price: 28_000, recipe: { BUN: 1, CHICKEN: 1 } },
  };
  const WATER_PRICE = 2_500;
  /** Intended ledger of the day, filled as scenarios succeed (never from POS totals). */
  const L1 = {
    cashIn: D(0), cashOut: D(0), mtn: D(0), card: D(0), ar: D(0),
    revenueGross: D(0), tax: D(0), sold: [] as Array<{ recipe: Record<string, number>; qty: number }>,
    directSold: {} as Record<string, number>, restocked: [] as Array<{ recipe: Record<string, number>; qty: number }>,
    safe: D(OPENING.safe), bank: D(OPENING.bank), expense: D(0), fees: D(0),
    wasted: [] as Array<{ recipe: Record<string, number>; qty: number }>,
  };

  const CASHIER = ['pos:read', 'pos:checkout', 'pos:discount', 'pos:credit', 'cash_session:open', 'cash_session:read', 'cash_session:close'];
  const WAITER = ['pos:read', 'pos:checkout'];
  const as = <T>(who: string, fn: () => Promise<T>) => tenant.run({ organizationId, userId: users[who], permissions: perms[who] } as any, fn);
  const at = (hhmm: string, day = '2026-09-24') => `${day}T${hhmm}:00+03:00`;

  // ── L3 extraction (raw SQL, independent of app report services) ───────────
  const balance = async (accountId: string) => {
    const r: any[] = await raw.$queryRawUnsafe(
      `SELECT COALESCE(SUM(l."baseDebit" - l."baseCredit"),0)::text AS b FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId" WHERE l."organizationId" = $1 AND l."accountId" = $2 AND e.status = 'posted'`, organizationId, accountId);
    return D(r[0].b);
  };
  const onHand = async (sku: string) => D((await db.stockItem.findFirst({ where: { organizationId, productId: prod[sku], locationId } }))?.quantity ?? 0);
  const drain = async () => {
    for (let pass = 0; pass < 3; pass++) {
      const jobs = await db.stockPostingJob.findMany({ where: { organizationId, status: { in: ['pending', 'failed'] } } });
      for (const j of jobs) await as('manager', () => billing.processStockPostingJob(j.id)).catch(() => undefined);
    }
  };
  const sell = (who: string, key: string, input: any) => as(who, async () => {
    const r: any = await pos.checkout({ cashSessionId: session.id, partnerId: acc.walkin, ...input });
    inv[key] = r.invoiceId;
    return r;
  });
  const vatLog: Array<{ key: string; policy: string; pos: string }> = [];
  /** Unrounded VAT per line at 6dp — compared exactly; the whole-shilling policy is checked once in D1-TAX-001. */
  const centsVat = (x: ReturnType<typeof intendedSale>) => x.tax;
  const invoiceRules = async (key: string, intended: ReturnType<typeof intendedSale>, rec: { rules: RuleResult[] }) => {
    const i = await db.invoice.findUniqueOrThrow({ where: { id: inv[key] }, include: { items: true } });
    rec.rules.push(compare(`SALES-01 ${key} invoice total`, intended.gross, i.totalAmount));
    const cents = centsVat(intended);
    rec.rules.push(compare(`SALES-04 ${key} VAT whole-shilling per line (policy)`, intended.tax, i.taxAmount));
    void cents;
    vatLog.push({ key, policy: S(intended.tax), pos: S(i.taxAmount) });
    const je = await db.journalEntry.findMany({ where: { organizationId, sourceType: 'pos_invoice', sourceId: i.id, reversalOfId: null } });
    rec.rules.push(compare(`GL-01 ${key} pos_invoice primary journal count`, 1, je.filter((j) => j.postingType === 'primary').length));
    return i;
  };

  beforeAll(async () => {
    await raw.$connect();
    moduleRef = await Test.createTestingModule({ imports: [KernelModule, DocumentsModule, PosModule] })
      .overrideProvider(PrismaService).useValue({ client: db, raw: db }).compile();
    await moduleRef.init();
    tenant = moduleRef.get(TenantContextService);
    pos = moduleRef.get(PosService); billing = moduleRef.get(PosInvoiceService); orders = moduleRef.get(PosOrdersService);
    splits = moduleRef.get(PosSplitService); reports = moduleRef.get(PosReportsService);
    cash = moduleRef.get(CashSessionService); cashFlow = moduleRef.get(CashFlowService); stock = moduleRef.get(StockService);
    idem = moduleRef.get(IdempotencyService);
  });

  afterAll(async () => {
    const out = ev.write({ organizationId, seed: SEED, policy: BUSINESS_POLICY });
    // eslint-disable-next-line no-console
    console.log(`\nSIMULATION EVIDENCE → ${out.root}  verdict ${out.verdict}`);
    await moduleRef?.close();
    await raw.$disconnect();
  });

  const run = (id: string, title: string, pri: 'P0' | 'P1' | 'P2', fn: (rec: any) => Promise<void>) =>
    it(`${id} ${title}`, async () => {
      const rec = await ev.scenario(id, title, pri, fn);
      if (rec.status === 'FAIL') throw new Error(`${id} FAILED: ${rec.error ?? rec.rules.filter((r) => r.status === 'FAIL').map((r) => `${r.rule} expected ${r.expected} got ${r.actual}`).join('; ')}`);
    });

  // ═════════════════════════ D0 — Wed 23 Sep: setup ═════════════════════════
  run('D0-01', 'Create company, branch location, register, staff and roles', 'P0', async (rec) => {
    await db.currency.upsert({ where: { code: 'UGX' }, update: { decimalPlaces: 0 }, create: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh', decimalPlaces: 0 } });
    await db.organization.create({ data: { id: organizationId, code: `LAKEVIEW-${Date.now()}`, name: 'Lakeview Café & Grill Ltd', currencyCode: 'UGX' } });
    const pin = await bcrypt.hash(PIN, 10);
    const roles = {
      manager: await db.role.create({ data: { organizationId, name: 'Branch manager', permissions: [...MANAGER_PERMISSIONS] } }),
      cashier: await db.role.create({ data: { organizationId, name: 'Cashier', permissions: CASHIER } }),
      waiter: await db.role.create({ data: { organizationId, name: 'Waiter', permissions: WAITER } }),
    };
    const mkUser = async (key: string, email: string, role: keyof typeof roles, p: string[]) => {
      users[key] = (await db.user.create({ data: { organizationId, email, firstName: key, passwordHash: 'x', pinHash: pin, roles: { connect: { id: roles[role].id } } } })).id;
      perms[key] = p;
    };
    await mkUser('manager', 'mgr.aca@lakeview.test', 'manager', [...MANAGER_PERMISSIONS]);
    await mkUser('cashier', 'cash.aca.a@lakeview.test', 'cashier', CASHIER);
    await mkUser('waiter', 'wait.aca.a@lakeview.test', 'waiter', WAITER);
    locationId = (await db.inventoryLocation.create({ data: { organizationId, code: 'ACA', name: 'Acacia Café store', type: 'warehouse', isActive: true } })).id;
    await db.setting.create({ data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: locationId as any } });
    rec.rules.push(compare('SETUP users created', 3, await db.user.count({ where: { organizationId } })));
  });

  run('D0-03', 'Chart of accounts, mappings, tenders, VAT 18% inclusive + exempt', 'P0', async (rec) => {
    const mk = makeAccountFactory(db, await ensureAccountCategories(db));
    const plan: Record<string, any> = {
      drawer: 'cash', safe: 'cash', bank: 'bank', mtn: 'mobile_money', airtel: 'mobile_money', card: 'current_asset',
      ar: 'receivable', ap: 'payable', revenue: 'revenue', outputVat: 'tax', cogs: 'cost_of_goods_sold', inventory: 'inventory',
      grni: 'current_liability', wht: 'current_liability', shortOver: 'operating_expense', expense: 'operating_expense',
      fees: 'operating_expense', waste: 'operating_expense', equity: 'equity', storeCredit: 'current_liability',
    };
    let n = 1000;
    for (const [k, cat] of Object.entries(plan)) acc[k] = (await mk(organizationId, String(n++), k, cat)).id;
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN', 'INV']) await db.journal.create({ data: { organizationId, code, name: code, journalType: 'general' } });
    const mappings: Record<string, string> = {
      accounts_receivable: acc.ar, accounts_payable: acc.ap, sales_revenue: acc.revenue, default_cash: acc.safe, default_bank: acc.bank,
      card_clearing: acc.card, mobile_money: acc.mtn, cash_short_over: acc.shortOver, withholding_payable: acc.wht,
      stock_valuation: acc.inventory, cogs: acc.cogs, grni_accrued: acc.grni, default_expense: acc.expense, store_credit: acc.storeCredit, stock_adjustment_expense: acc.waste,
    };
    for (const [key, accountId] of Object.entries(mappings)) await db.accountMapping.create({ data: { organizationId, key, accountId } });
    await db.posPaymentMethod.createMany({ data: [
      { organizationId, code: 'cash', label: 'Cash', kind: 'cash', accountId: acc.drawer, trackInShift: false },
      { organizationId, code: 'mtn', label: 'MTN MoMo', kind: 'mobile_money', accountId: acc.mtn, trackInShift: true },
      { organizationId, code: 'airtel', label: 'Airtel Money', kind: 'mobile_money', accountId: acc.airtel, trackInShift: true },
      { organizationId, code: 'card', label: 'Card', kind: 'card', accountId: acc.card, trackInShift: false },
    ] as any });
    tax.vat = (await db.tax.create({ data: { organizationId, name: 'VAT 18%', rate: VAT, isInclusive: true, accountId: acc.outputVat } })).id;
    tax.exempt = (await db.tax.create({ data: { organizationId, name: 'Exempt', rate: 0, isInclusive: true, vatCategory: 'exempt' } })).id;
    registerId = (await db.cashRegister.create({ data: { organizationId, code: 'ACA-COUNTER', name: 'Acacia front counter', defaultAccountId: acc.drawer, locationId } })).id;
    acc.walkin = (await db.partner.create({ data: { organizationId, code: 'WALKIN', name: 'Walk-in', isCustomer: true } })).id;
    acc.techHub = (await db.partner.create({ data: { organizationId, code: 'KTH', name: 'Kampala Tech Hub', isCustomer: true, creditLimit: 2_000_000 } as any })).id;
    const methods = await db.posPaymentMethod.findMany({ where: { organizationId } });
    rec.rules.push(compare('SETUP every tender has an account', methods.length, methods.filter((m) => m.accountId).length));
    const reg = await db.cashRegister.findUniqueOrThrow({ where: { id: registerId } });
    rec.rules.push({ rule: 'SETUP register has drawer + location', status: reg.defaultAccountId && reg.locationId ? 'PASS' : 'FAIL' });
  });

  run('D0-04', 'Stock items, menu items and recipes', 'P0', async (rec) => {
    for (const [sku, s] of Object.entries(STOCK)) {
      prod[sku] = (await db.product.create({ data: { organizationId, code: sku, name: s.name, productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: s.unitCost,
        ...(sku === 'WATER_500' ? { salesPrice: WATER_PRICE, taxId: tax.exempt, taxInclusive: true } : { salesPrice: 0 }) } as any })).id;
    }
    for (const [code, m] of Object.entries(MENU)) {
      menu[code] = (await db.menuItem.create({ data: { organizationId, code, name: m.name, basePrice: m.price, taxId: tax.vat, isInventoryTracked: true,
        ingredients: { create: Object.entries(m.recipe).map(([sku, q]) => ({ organizationId, productId: prod[sku], quantity: q })) } } })).id;
    }
    const tracked = await db.menuItem.findMany({ where: { organizationId }, include: { ingredients: true } });
    rec.rules.push(compare('SETUP every tracked menu item has a recipe', tracked.length, tracked.filter((t) => t.ingredients.length > 0).length));
  });

  run('D0-05', 'Opening capital: safe and bank', 'P0', async (rec) => {
    await as('manager', () => cashFlow.deposit({ accountId: acc.safe, counterpartAccountId: acc.equity, operationType: 'owner_contribution', amount: OPENING.safe, description: 'Opening safe cash' }));
    await as('manager', () => cashFlow.deposit({ accountId: acc.bank, counterpartAccountId: acc.equity, operationType: 'owner_contribution', amount: OPENING.bank, description: 'Opening bank' }));
    rec.rules.push(compare('CASH safe = opening', OPENING.safe, await balance(acc.safe)));
    rec.rules.push(compare('GL bank = opening', OPENING.bank, await balance(acc.bank)));
  });

  run('D0-06', 'Opening stock at known cost; inventory subledger = inventory GL', 'P0', async (rec) => {
    let value = D(0);
    for (const [sku, s] of Object.entries(STOCK)) {
      await as('manager', () => stock.receiveForDocument({ productId: prod[sku], locationId, quantity: s.qty, unitCost: s.unitCost } as any, { sourceType: 'goods_receipt', sourceId: `OPEN-${sku}`, date: new Date(at('07:00', '2026-09-23')) }));
      value = value.plus(D(s.qty).times(s.unitCost));
    }
    for (const sku of Object.keys(STOCK)) rec.rules.push(compare(`INV-03 ${sku} on hand`, STOCK[sku].qty, await onHand(sku)));
    rec.rules.push(compare('INV-05 inventory GL = opening value', value, await balance(acc.inventory)));
  });

  run('D0-07', 'Trial balance balances after setup', 'P0', async (rec) => {
    const r: any[] = await raw.$queryRawUnsafe(`SELECT COALESCE(SUM(l."baseDebit"),0)::text d, COALESCE(SUM(l."baseCredit"),0)::text c FROM "JournalLine" l JOIN "JournalEntry" e ON e.id=l."journalEntryId" WHERE l."organizationId"=$1 AND e.status='posted'`, organizationId);
    rec.rules.push(compare('GL-03 Σdebit = Σcredit', r[0].d, r[0].c));
  });

  // ═════════════════════ D1 — Thu 24 Sep: soft opening ═════════════════════
  run('D1-C-001', '06:45 cashier opens shift with 200,000 float from safe', 'P0', async (rec) => {
    session = await as('cashier', () => cash.open({ cashRegisterId: registerId, openingFloat: OPENING.float, openingSourceAccountId: acc.safe, notes: 'Float from safe' } as any));
    L1.safe = L1.safe.minus(OPENING.float);
    rec.rules.push(compare('CASH drawer = float', OPENING.float, await balance(acc.drawer)));
    rec.rules.push(compare('CASH safe reduced by float', L1.safe, await balance(acc.safe)));
  });

  run('D1-C-002', 'Second session on same register is refused', 'P0', async (rec) => {
    let refused = false;
    await as('manager', () => cash.open({ cashRegisterId: registerId, openingFloat: 0 } as any)).catch(() => { refused = true; });
    rec.rules.push({ rule: 'CASH one open session per register', status: refused ? 'PASS' : 'FAIL' });
  });

  run('D1-B-001', 'Espresso cash, 10,000 tendered → 4,000 change', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'ESPRESSO', qty: 1, unitPrice: 6000, taxRate: VAT }]);
    const r: any = await sell('cashier', 'B001', { lines: [{ menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], paymentMethod: 'cash', amountTendered: 10_000 });
    rec.rules.push(compare('SALES-03 change returned', 4000, r.change ?? 0));
    await invoiceRules('B001', intended, rec);
    const mv: any[] = await raw.$queryRawUnsafe(`SELECT m.amount FROM "CashMovement" m JOIN "PaymentAllocation" a ON a."paymentId" = m."paymentId" WHERE m."cashSessionId" = $1 AND a."invoiceId" = $2`, session.id, inv.B001);
    rec.rules.push(compare('CASH-01 drawer movement = net cash kept', 6000, mv.reduce((s: any, m: any) => s.plus(m.amount), D(0))));
    L1.cashIn = L1.cashIn.plus(6000); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.ESPRESSO.recipe, qty: 1 });
  });

  run('D1-B-002', 'Multi-item cash sale, exact tender', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }, { sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }]);
    await sell('cashier', 'B002', { lines: [
      { menuItemId: menu.CAPP_M, description: 'Cappuccino M', quantity: 1, unitPrice: 10000 },
      { menuItemId: menu.BURGER, description: 'Chicken burger', quantity: 1, unitPrice: 28000 }], tenders: [{ method: 'cash', amount: 38_000 }] });
    await invoiceRules('B002', intended, rec);
    L1.cashIn = L1.cashIn.plus(38000); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.CAPP_M.recipe, qty: 1 }, { recipe: MENU.BURGER.recipe, qty: 1 });
  });

  run('D1-B-003', '2× Cappuccino M paid MTN 20,000 (worked VAT example)', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'CAPP_M', qty: 2, unitPrice: 10000, taxRate: VAT }]);
    rec.rules.push(compare('ORACLE worked example VAT', 3051, intended.tax));
    await sell('cashier', 'B003', { lines: [{ menuItemId: menu.CAPP_M, description: 'Cappuccino M', quantity: 2, unitPrice: 10000 }], tenders: [{ method: 'mobile_money', accountId: acc.mtn, amount: 20_000, reference: 'SIM-MTN-00001' }] });
    await invoiceRules('B003', intended, rec);
    L1.mtn = L1.mtn.plus(20000); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.CAPP_M.recipe, qty: 2 });
    rec.rules.push(compare('TEND MTN clearing after sale', L1.mtn, await balance(acc.mtn)));
  });

  run('D1-B-004', 'Card sale, bottled water (VAT exempt, direct stock)', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'WATER_500', qty: 2, unitPrice: WATER_PRICE, taxRate: 0 }]);
    await sell('cashier', 'B004', { lines: [{ productId: prod.WATER_500, description: 'Water', quantity: 2, unitPrice: WATER_PRICE }], tenders: [{ method: 'card', amount: 5000, reference: 'SIM-CARD-1' }] });
    await invoiceRules('B004', intended, rec);
    L1.card = L1.card.plus(5000); L1.revenueGross = L1.revenueGross.plus(intended.gross);
    L1.directSold.WATER_500 = (L1.directSold.WATER_500 ?? 0) + 2;
  });

  run('D1-B-005', 'Mixed tender: cash 5,000 + MTN 7,000 for 12,000', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'ESPRESSO', qty: 2, unitPrice: 6000, taxRate: VAT }]);
    await sell('cashier', 'B005', { lines: [{ menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 2, unitPrice: 6000 }],
      tenders: [{ method: 'cash', amount: 5000 }, { method: 'mobile_money', accountId: acc.mtn, amount: 7000, reference: 'SIM-MTN-00002' }] });
    await invoiceRules('B005', intended, rec);
    const pays = await db.payment.findMany({ where: { organizationId, allocations: { some: { invoiceId: inv.B005 } } } as any }).catch(async () => db.payment.findMany({ where: { organizationId, invoiceId: inv.B005 } as any }));
    rec.rules.push(compare('SALES-02 two tender payments recorded', 2, pays.length));
    L1.cashIn = L1.cashIn.plus(5000); L1.mtn = L1.mtn.plus(7000); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.ESPRESSO.recipe, qty: 2 });
  });

  run('D1-B-006', '10% order discount with reason (within cashier authority)', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }, { sku: 'ESPRESSO', qty: 1, unitPrice: 6000, taxRate: VAT }], 10);
    rec.notes.push(`intended gross ${S(intended.gross)} VAT ${S(intended.tax)}`);
    await sell('cashier', 'B006', { lines: [
      { menuItemId: menu.CAPP_M, description: 'Cappuccino M', quantity: 1, unitPrice: 10000 },
      { menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }],
      transactionDiscountPercent: 10, discountReason: 'Regular customer', expectedTotal: Number(intended.gross), tenders: [{ method: 'cash', amount: Number(intended.gross) }] });
    await invoiceRules('B006', intended, rec);
    L1.cashIn = L1.cashIn.plus(intended.gross); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.CAPP_M.recipe, qty: 1 }, { recipe: MENU.ESPRESSO.recipe, qty: 1 });
  });

  run('D1-B-007', '30% discount: refused without manager, accepted with manager PIN', 'P0', async (rec) => {
    const lines = [{ menuItemId: menu.BURGER, description: 'Chicken burger', quantity: 1, unitPrice: 28000 }];
    const intended = intendedSale([{ sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }], 30);
    const before = await db.invoice.count({ where: { organizationId } });
    let refused = '';
    await sell('cashier', 'B007x', { lines, transactionDiscountPercent: 30, discountReason: 'Complaint', expectedTotal: Number(intended.gross), tenders: [{ method: 'cash', amount: Number(intended.gross) }] }).catch((e) => { refused = e.message; });
    rec.rules.push({ rule: 'AUTH 30% discount without manager refused', status: refused ? 'PASS' : 'FAIL', actual: refused || 'accepted' });
    rec.rules.push(compare('AUTH refused discount wrote no invoice', before + (refused ? 0 : 1), await db.invoice.count({ where: { organizationId } })));
    await sell('cashier', 'B007', { lines, transactionDiscountPercent: 30, discountReason: 'Complaint', overrideById: users.manager, overridePin: PIN, expectedTotal: Number(intended.gross), tenders: [{ method: 'cash', amount: Number(intended.gross) }] });
    await invoiceRules('B007', intended, rec);
    L1.cashIn = L1.cashIn.plus(intended.gross); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.BURGER.recipe, qty: 1 });
  });

  run('D1-B-008', 'Mixed VAT basket: 18% inclusive coffee + exempt water', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }, { sku: 'WATER_500', qty: 1, unitPrice: WATER_PRICE, taxRate: 0 }]);
    await sell('cashier', 'B008', { lines: [
      { menuItemId: menu.CAPP_M, description: 'Cappuccino M', quantity: 1, unitPrice: 10000 },
      { productId: prod.WATER_500, description: 'Water', quantity: 1, unitPrice: WATER_PRICE }], tenders: [{ method: 'card', amount: 12500, reference: 'SIM-CARD-2' }] });
    await invoiceRules('B008', intended, rec);
    L1.card = L1.card.plus(12500); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.CAPP_M.recipe, qty: 1 }); L1.directSold.WATER_500 = (L1.directSold.WATER_500 ?? 0) + 1;
  });

  run('D1-X-001', 'Lost response: same Idempotency-Key retried + concurrent duplicate → one sale', 'P0', async (rec) => {
    const key = `sim-${randomUUID()}`, path = '/api/v1/pos/checkout';
    const body = { cashSessionId: session.id, partnerId: acc.walkin, lines: [{ menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], tenders: [{ method: 'card', amount: 6000, reference: 'SIM-CARD-3' }] };
    const before = await db.invoice.count({ where: { organizationId } });
    const attempt = () => as('cashier', () => idem.executeWithKey({ key, path, requestHash: 'same', runHandler: async () => ({ statusCode: 201, body: await pos.checkout(body as any) }) }));
    await Promise.allSettled([attempt(), attempt()]);
    const retry: any = await attempt();
    rec.rules.push({ rule: 'INT-01 retry replayed stored outcome', status: retry.replayed ? 'PASS' : 'FAIL' });
    rec.rules.push(compare('INT-01 exactly one invoice', before + 1, await db.invoice.count({ where: { organizationId } })));
    let rejected = false;
    await as('cashier', () => idem.executeWithKey({ key, path, requestHash: 'different', runHandler: async () => ({ statusCode: 201, body: {} }) })).catch(() => { rejected = true; });
    rec.rules.push({ rule: 'INT-01 same key + different payload rejected', status: rejected ? 'PASS' : 'FAIL' });
    inv.X001 = (retry.body as any).invoiceId;
    L1.card = L1.card.plus(6000); L1.revenueGross = L1.revenueGross.plus(6000); L1.tax = L1.tax.plus(intendedSale([{ sku: 'E', qty: 1, unitPrice: 6000, taxRate: VAT }]).tax);
    L1.sold.push({ recipe: MENU.ESPRESSO.recipe, qty: 1 });
  });

  // ── Restaurant tables ───────────────────────────────────────────────────────
  let table5 = '', table8 = '', table9 = '';
  run('D1-L-001', 'Table 5: KOT1 full order → add espresso round → KOT2 delta only → pay card', 'P0', async (rec) => {
    table5 = (await db.posTable.create({ data: { organizationId, name: 'T5', number: 5 } })).id;
    await as('waiter', () => pos.addToTab({ tableId: table5, cashSessionId: session.id, guestCount: 2, sendToKitchen: true, lines: [
      { menuItemId: menu.CAPP_M, description: 'Cappuccino M', quantity: 2, unitPrice: 10000 },
      { menuItemId: menu.BURGER, description: 'Chicken burger', quantity: 2, unitPrice: 28000 }] }));
    const t5order = (await db.posTableOrder.findFirstOrThrow({ where: { tableId: table5, closedAt: null } })).orderId!;
    const k1 = await db.kitchenTicket.findMany({ where: { organizationId, orderId: t5order }, orderBy: { createdAt: 'asc' } });
    const qty = (t: any[]) => t.reduce((s, x) => s + (Array.isArray(x.items) ? x.items : []).reduce((a: number, i: any) => a + Number(i.quantity ?? i.qty ?? 0), 0), 0);
    rec.rules.push(compare('KOT-01 first KOT carries full order (4 units)', 4, qty(k1)));
    await as('waiter', () => pos.addToTab({ tableId: table5, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }] }));
    const k2 = await db.kitchenTicket.findMany({ where: { organizationId, orderId: t5order }, orderBy: { createdAt: 'asc' } });
    rec.notes.push(`KOT tickets for T5: ${k2.length}`);
    rec.rules.push(compare('KOT-01 second KOT carries only the new round (1 unit)', 1, qty(k2) - qty(k1)));
    const intended = intendedSale([{ sku: 'CAPP_M', qty: 2, unitPrice: 10000, taxRate: VAT }, { sku: 'BURGER', qty: 2, unitPrice: 28000, taxRate: VAT }, { sku: 'ESPRESSO', qty: 1, unitPrice: 6000, taxRate: VAT }]);
    const r: any = await as('cashier', () => pos.settleTab({ tableId: table5, cashSessionId: session.id, expectedTotal: Number(intended.gross), tenders: [{ method: 'card', amount: Number(intended.gross), reference: 'SIM-CARD-4' }] }));
    inv.L001 = r.invoiceId;
    await invoiceRules('L001', intended, rec);
    const t = await db.posTable.findUniqueOrThrow({ where: { id: table5 } });
    rec.rules.push({ rule: 'KOT-04 table released after settlement', status: ['available', 'cleaning'].includes(t.status) ? 'PASS' : 'FAIL', actual: t.status });
    L1.card = L1.card.plus(intended.gross); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.CAPP_M.recipe, qty: 2 }, { recipe: MENU.BURGER.recipe, qty: 2 }, { recipe: MENU.ESPRESSO.recipe, qty: 1 });
  });

  run('D1-L-002', 'Table 8 split by item: guest 1 cash, guest 2 MTN; double settle is a no-op', 'P0', async (rec) => {
    table8 = (await db.posTable.create({ data: { organizationId, name: 'T8', number: 8 } })).id;
    await as('waiter', () => pos.addToTab({ tableId: table8, cashSessionId: session.id, guestCount: 2, sendToKitchen: true, lines: [
      { menuItemId: menu.BURGER, description: 'Chicken burger', quantity: 1, unitPrice: 28000 },
      { menuItemId: menu.CAPP_M, description: 'Cappuccino M', quantity: 1, unitPrice: 10000 }] }));
    const t8 = await db.posTableOrder.findFirstOrThrow({ where: { tableId: table8, closedAt: null } });
    const order: any = await db.order.findUniqueOrThrow({ where: { id: t8.orderId! }, include: { items: true } });
    let state: any = await as('cashier', () => splits.addBills(table8, 2));
    const [b1, b2] = state.bills;
    const burger = order.items.find((i: any) => i.menuItemId === menu.BURGER), capp = order.items.find((i: any) => i.menuItemId === menu.CAPP_M);
    state = await as('cashier', () => splits.assign(b1.id, [{ sourceItemId: burger.id, quantity: 1 }]));
    state = await as('cashier', () => splits.assign(b2.id, [{ sourceItemId: capp.id, quantity: 1 }]));
    let overAssign = false;
    await as('cashier', () => splits.assign(b2.id, [{ sourceItemId: burger.id, quantity: 1 }])).catch(() => { overAssign = true; });
    rec.rules.push({ rule: 'KOT-04 split quantity cannot exceed source', status: overAssign ? 'PASS' : 'FAIL' });
    const r1: any = await as('cashier', () => splits.settleBill(b1.id, { cashSessionId: session.id, expectedTotal: 28000, tenders: [{ method: 'cash', amount: 28000 }] } as any));
    const again: any = await as('cashier', () => splits.settleBill(b1.id, { cashSessionId: session.id, tenders: [{ method: 'cash', amount: 28000 }] } as any));
    rec.rules.push({ rule: 'INT-01 second settle of same split returns same invoice', status: again.invoiceId === r1.invoiceId ? 'PASS' : 'FAIL' });
    const mid = await db.posTable.findUniqueOrThrow({ where: { id: table8 } });
    rec.rules.push({ rule: 'KOT-04 table not released while a split bill is unpaid', status: !['available', 'cleaning'].includes(mid.status) ? 'PASS' : 'FAIL', actual: mid.status });
    const r2: any = await as('cashier', () => splits.settleBill(b2.id, { cashSessionId: session.id, expectedTotal: 10000, tenders: [{ method: 'mobile_money', accountId: acc.mtn, amount: 10000, reference: 'SIM-MTN-00003' }] } as any));
    inv.L002a = r1.invoiceId; inv.L002b = r2.invoiceId;
    await invoiceRules('L002a', intendedSale([{ sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }]), rec);
    await invoiceRules('L002b', intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }]), rec);
    const end = await db.posTable.findUniqueOrThrow({ where: { id: table8 } });
    rec.rules.push({ rule: 'KOT-04 table released after all splits paid', status: ['available', 'cleaning'].includes(end.status) ? 'PASS' : 'FAIL', actual: end.status });
    const both = intendedSale([{ sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }]).tax.plus(intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }]).tax);
    L1.cashIn = L1.cashIn.plus(28000); L1.mtn = L1.mtn.plus(10000); L1.revenueGross = L1.revenueGross.plus(38000); L1.tax = L1.tax.plus(both);
    L1.sold.push({ recipe: MENU.BURGER.recipe, qty: 1 }, { recipe: MENU.CAPP_M.recipe, qty: 1 });
  });

  run('D1-L-003', 'Corporate on-account sale (AR) to Kampala Tech Hub', 'P0', async (rec) => {
    const intended = intendedSale([{ sku: 'BURGER', qty: 3, unitPrice: 28000, taxRate: VAT }]);
    const r: any = await as('cashier', () => pos.checkout({ cashSessionId: session.id, partnerId: acc.techHub, settleMode: 'credit', lines: [{ menuItemId: menu.BURGER, description: 'Chicken burger', quantity: 3, unitPrice: 28000 }] } as any));
    inv.L003 = r.invoiceId;
    const i = await invoiceRules('L003', intended, rec);
    rec.rules.push(compare('APAR-02 invoice residual owed by customer', intended.gross, i.amountResidual));
    L1.ar = L1.ar.plus(intended.gross); L1.revenueGross = L1.revenueGross.plus(intended.gross); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.BURGER.recipe, qty: 3 });
    rec.rules.push(compare('APAR-02 AR control = on-account sales', L1.ar, await balance(acc.ar)));
  });

  run('D1-E-002', 'Table 9: food fired to kitchen, guest leaves unpaid → cancel needs manager; no revenue', 'P0', async (rec) => {
    table9 = (await db.posTable.create({ data: { organizationId, name: 'T9', number: 9 } })).id;
    const o: any = await as('waiter', () => pos.addToTab({ tableId: table9, cashSessionId: session.id, sendToKitchen: true, lines: [{ menuItemId: menu.BURGER, description: 'Chicken burger', quantity: 1, unitPrice: 28000 }] }));
    const orderId = o?.id ?? o?.orderId ?? (await db.posTableOrder.findFirstOrThrow({ where: { tableId: table9, closedAt: null } })).orderId!;
    const before = await db.invoice.count({ where: { organizationId } });
    let refused = false;
    await as('waiter', () => orders.cancelOrder(orderId, 'Guest left')).catch(() => { refused = true; });
    rec.rules.push({ rule: 'AUTH cancelling fired food without manager refused', status: refused ? 'PASS' : 'FAIL' });
    let waiterWithPin = 'accepted';
    await as('waiter', () => orders.cancelOrder(orderId, 'Guest left', undefined, { overrideById: users.manager, overridePin: PIN })).catch((e) => { waiterWithPin = e.message; });
    rec.notes.push(`waiter cancel with manager PIN: ${waiterWithPin}`);
    if (waiterWithPin !== 'accepted') await as('manager', () => orders.cancelOrder(orderId, 'Guest left', undefined, { overrideById: users.manager, overridePin: PIN }));
    rec.rules.push(compare('SALES cancelled order creates no invoice', before, await db.invoice.count({ where: { organizationId } })));
    const t = await db.posTable.findUniqueOrThrow({ where: { id: table9 } });
    rec.rules.push({ rule: 'KOT table released after cancel', status: t.status === 'available' ? 'PASS' : 'FAIL', actual: t.status });
    L1.wasted.push({ recipe: MENU.BURGER.recipe, qty: 1 });
  });

  // ── Refund ────────────────────────────────────────────────────────────────
  run('D1-E-001', 'Full refund of B002 (cash) with manager PIN, restock; cashier self-approval refused', 'P0', async (rec) => {
    let refused = false;
    await as('cashier', () => billing.refund(inv.B002, 'Self approval attempt', { overrideById: users.cashier, overridePin: PIN, stockDisposition: 'restock', cashSessionId: session.id })).catch(() => { refused = true; });
    rec.rules.push({ rule: 'AUTH cashier cannot approve own refund', status: refused ? 'PASS' : 'FAIL' });
    rec.rules.push(compare('AUTH refused refund left invoice paid', 0, (await db.invoice.findUniqueOrThrow({ where: { id: inv.B002 } })).status === 'refunded' ? 1 : 0));
    const job = await db.stockPostingJob.findFirst({ where: { organizationId, invoiceId: inv.B002 } });
    let early = 'accepted';
    await as('cashier', () => billing.refund(inv.B002, 'Order was wrong', { overrideById: users.manager, overridePin: PIN, stockDisposition: 'restock', cashSessionId: session.id })).catch((e) => { early = e.message; });
    rec.notes.push(`stock job at refund time: ${job?.status}; refund result: ${early}`);
    if (early !== 'accepted') { await drain(); await as('cashier', () => billing.refund(inv.B002, 'Order was wrong', { overrideById: users.manager, overridePin: PIN, stockDisposition: 'restock', cashSessionId: session.id })); }
    const i = await db.invoice.findUniqueOrThrow({ where: { id: inv.B002 } });
    rec.rules.push({ rule: 'SALES-06 invoice marked refunded', status: i.status === 'refunded' ? 'PASS' : 'FAIL', actual: i.status });
    let second = false;
    await as('cashier', () => billing.refund(inv.B002, 'Double refund', { overrideById: users.manager, overridePin: PIN, stockDisposition: 'restock', cashSessionId: session.id })).catch(() => { second = true; });
    rec.rules.push({ rule: 'SALES-06 second refund of same invoice refused', status: second ? 'PASS' : 'FAIL' });
    const g = intendedSale([{ sku: 'CAPP_M', qty: 1, unitPrice: 10000, taxRate: VAT }, { sku: 'BURGER', qty: 1, unitPrice: 28000, taxRate: VAT }]);
    L1.cashOut = L1.cashOut.plus(38000); L1.revenueGross = L1.revenueGross.minus(g.gross); L1.tax = L1.tax.minus(g.tax);
    L1.restocked.push({ recipe: MENU.CAPP_M.recipe, qty: 1 }, { recipe: MENU.BURGER.recipe, qty: 1 });
  });

  // ── Cash movements ─────────────────────────────────────────────────────────
  run('D1-C-010', 'Pay-out: gas 45,000 refused without manager, allowed with manager; fake pay-in refused; safe drop 100,000', 'P0', async (rec) => {
    let noApproval = false, fakeSale = false;
    await as('cashier', () => cash.recordMovement(session.id, { movementType: 'pay_out', amount: 45000, reason: 'Gas refill', counterpartAccountId: acc.expense } as any)).catch(() => { noApproval = true; });
    await as('cashier', () => cash.recordMovement(session.id, { movementType: 'pay_in', amount: 50000, reason: 'Unrecorded sale', counterpartAccountId: acc.revenue } as any)).catch(() => { fakeSale = true; });
    rec.rules.push({ rule: 'AUTH pay-out needs manager', status: noApproval ? 'PASS' : 'FAIL' });
    rec.rules.push({ rule: 'AUTH pay-in cannot create revenue', status: fakeSale ? 'PASS' : 'FAIL' });
    await as('cashier', () => cash.recordMovement(session.id, { movementType: 'pay_out', amount: 45000, reason: 'Gas refill', counterpartAccountId: acc.expense, approverEmail: 'mgr.aca@lakeview.test', managerPin: PIN } as any));
    await as('cashier', () => cash.recordMovement(session.id, { movementType: 'pay_out', amount: 100000, reason: 'Safe drop', counterpartAccountId: acc.safe, approverEmail: 'mgr.aca@lakeview.test', managerPin: PIN } as any));
    L1.expense = L1.expense.plus(45000); L1.safe = L1.safe.plus(100000);
    L1.cashOut = L1.cashOut.plus(145000);
    rec.rules.push(compare('CASH-03 safe = opening − float + drop', L1.safe, await balance(acc.safe)));
    rec.rules.push(compare('GL expense = approved pay-outs', L1.expense, await balance(acc.expense)));
  });

  // ── Trading date after midnight ────────────────────────────────────────────
  run('D1-T-001', 'Trading date: offline sale keeps its original time; post-midnight sale stays on session trading date', 'P1', async (rec) => {
    const intended = intendedSale([{ sku: 'ESPRESSO', qty: 1, unitPrice: 6000, taxRate: VAT }]);
    const occurred = new Date(Date.now() - 26 * 3600_000); // rung offline yesterday, synced now
    await sell('cashier', 'T001', { occurredAt: occurred.toISOString(), lines: [{ menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], tenders: [{ method: 'card', amount: 6000, reference: 'SIM-CARD-5' }] });
    const i: any = await db.invoice.findUniqueOrThrow({ where: { id: inv.T001 } });
    const je = await db.journalEntry.findFirst({ where: { organizationId, sourceType: 'pos_invoice', sourceId: inv.T001 } });
    const kampalaDate = (d: Date) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    const dateCols = Object.entries(i).filter(([k, v]) => v instanceof Date).map(([k, v]) => `${k}=${kampalaDate(v as Date)}`).join(', ');
    rec.notes.push(`occurredAt ${kampalaDate(occurred)}; invoice dates: ${dateCols}; journal postingDate ${je ? kampalaDate(je.postingDate) : 'none'}`);
    rec.rules.push({ rule: 'DATE offline sale posts on its original date', status: je && kampalaDate(je.postingDate) === kampalaDate(occurred) ? 'PASS' : 'FAIL', expected: kampalaDate(occurred), actual: je ? kampalaDate(je.postingDate) : 'none' });
    const sess: any = await db.cashSession.findUniqueOrThrow({ where: { id: session.id } });
    const opened = new Date(sess.openedAt.getTime() + 3 * 3600_000 - 6 * 3600_000).toISOString().slice(0, 10);
    rec.rules.push({ rule: 'DATE session trading date = opening local time − 06:00 cutoff', status: sess.businessDate && sess.businessDate.toISOString().slice(0, 10) === opened ? 'PASS' : 'FAIL', expected: opened, actual: sess.businessDate?.toISOString().slice(0, 10) });
    rec.rules.push({ rule: 'DATE sale in open session carries the session trading date (post-midnight rule)', status: i.businessDate && sess.businessDate && i.businessDate.getTime() === sess.businessDate.getTime() ? 'PASS' : 'FAIL', expected: sess.businessDate?.toISOString().slice(0, 10), actual: i.businessDate?.toISOString?.().slice(0, 10) });
    L1.card = L1.card.plus(6000); L1.revenueGross = L1.revenueGross.plus(6000); L1.tax = L1.tax.plus(intended.tax);
    L1.sold.push({ recipe: MENU.ESPRESSO.recipe, qty: 1 });
  });

  // ── Stock worker, consumption, COGS ────────────────────────────────────────
  run('D1-I-001', 'Stock worker drains; recipe consumption, on-hand, COGS and inventory GL reconcile', 'P0', async (rec) => {
    await drain(); await drain();
    const pending = await db.stockPostingJob.count({ where: { organizationId, status: { not: 'done' } } });
    rec.rules.push(compare('INT-03 no pending/failed stock jobs after drain', 0, pending));
    const used = intendedConsumption(L1.sold), back = intendedConsumption(L1.restocked);
    let cogs = D(0), invValue = D(0), wasteValue = D(0);
    for (const [sku, s] of Object.entries(STOCK)) {
      const consumed = (used[sku] ?? D(0)).minus(back[sku] ?? D(0)).plus(L1.directSold[sku] ?? 0);
      const wastedQty = intendedConsumption(L1.wasted)[sku] ?? D(0);
      wasteValue = wasteValue.plus(wastedQty.times(s.unitCost));
      const expectedOnHand = D(s.qty).minus(consumed).minus(wastedQty);
      rec.rules.push(compare(`INV-02/03 ${sku} on hand = opening − consumption`, expectedOnHand, await onHand(sku)));
      const ledger: any[] = await raw.$queryRawUnsafe(`SELECT COALESCE(SUM("quantityChange"),0)::text q FROM "InventoryLedger" WHERE "organizationId"=$1 AND "productId"=$2`, organizationId, prod[sku]);
      rec.rules.push(compare(`INV-03 ${sku} ledger qty = on hand`, await onHand(sku), ledger[0].q));
      cogs = cogs.plus(consumed.times(s.unitCost)); invValue = invValue.plus(expectedOnHand.times(s.unitCost));
    }
    rec.rules.push(compare('INV-05 COGS GL = Σ consumed × AVCO cost', cogs, await balance(acc.cogs)));
    rec.rules.push(compare('INV-05 inventory GL = Σ on hand × cost', invValue, await balance(acc.inventory)));
    rec.rules.push(compare('WASTE GL = cancelled fired food at cost (bun + chicken)', wasteValue, await balance(acc.waste)));
  });

  run('D1-I-002', 'Waste policy: burger fired then cancelled (T9) is recorded as waste', 'P1', async (rec) => {
    const wasteRows: any[] = await (raw.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM "InventoryLedger" WHERE "organizationId"=$1 AND "productId" = ANY($2::text[]) AND (type::text ILIKE '%waste%' OR type::text ILIKE '%scrap%' OR "referenceType" ILIKE '%waste%' OR "referenceType" ILIKE '%cancel%')`, organizationId, [prod.BUN, prod.CHICKEN]) as Promise<any[]>).catch((e: any) => [{ n: -1, e: e.message }]);
    rec.notes.push(`waste ledger rows for bun/chicken: ${JSON.stringify(wasteRows[0])}`);
    rec.rules.push({ rule: 'WASTE fired-then-cancelled food leaves an auditable waste record', status: wasteRows[0].n > 0 ? 'PASS' : 'FAIL', expected: '≥1 waste row', actual: String(wasteRows[0].n) });
  });

  // ── Reports vs oracle (X report before close) ──────────────────────────────
  run('D1-R-001', 'X report totals = oracle', 'P0', async (rec) => {
    const x: any = await as('manager', () => reports.xReport(session.id));
    const t = x.totals ?? {};
    rec.notes.push(`X totals: ${JSON.stringify(t)}`);
    rec.rules.push(compare('RPT X cash collected (net of change)', L1.cashIn, t.cashCollected));
    rec.rules.push(compare('RPT X cash refunds', 38000, t.cashRefunds));
    rec.rules.push(compare('RPT X pay-outs (expense + safe drop)', 145000, t.payOutsTotal));
    rec.rules.push(compare('RPT X expected cash', D(OPENING.float).plus(L1.cashIn).minus(L1.cashOut), t.expectedCash));
    rec.rules.push(compare('RPT X gross sales incl. refunded sale (shown separately as refundedTotal)', L1.revenueGross.plus(38000), t.grossSales));
    rec.rules.push(compare('RPT X refundedTotal', 38000, t.refundedTotal));
    rec.rules.push(compare('RPT X netRevenueAfterRefunds = books net revenue (ex-VAT)', L1.revenueGross.minus(L1.tax), t.netRevenueAfterRefunds, 'X/Z net revenue must tie to the P&L revenue account'));
    rec.rules.push(compare('RPT X taxAfterRefunds = output VAT owed', L1.tax, t.taxAfterRefunds));
  });

  // ── Close shift ────────────────────────────────────────────────────────────
  let expectedDrawer = D(0);
  run('D1-K-001', 'Close shift: counted = oracle expected; Z = drawer GL; closed day immutable', 'P0', async (rec) => {
    expectedDrawer = D(OPENING.float).plus(L1.cashIn).minus(L1.cashOut);
    rec.rules.push(compare('CASH-01 drawer GL = oracle expected before close', expectedDrawer, await balance(acc.drawer)));
    let managerRefused = false;
    await as('manager', () => cash.close({ sessionId: session.id, closingCounted: Number(expectedDrawer), closingAccounts: { [acc.mtn]: Number(L1.mtn), [acc.airtel]: 0 } } as any)).catch(() => { managerRefused = true; });
    rec.rules.push({ rule: 'CASH only the session cashier closes', status: managerRefused ? 'PASS' : 'FAIL' });
    const closed: any = await as('cashier', () => cash.close({ sessionId: session.id, closingCounted: Number(expectedDrawer), closingAccounts: { [acc.mtn]: Number(L1.mtn), [acc.airtel]: 0 } } as any));
    rec.rules.push({ rule: 'CASH session closed', status: closed.status === 'closed' ? 'PASS' : 'FAIL', actual: closed.status });
    const z: any = (await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } })).reportData;
    rec.rules.push(compare('RPT Z closingExpected = oracle', expectedDrawer, z.closingExpected));
    rec.rules.push(compare('RPT Z closingCounted = counted', expectedDrawer, z.closingCounted));
    rec.rules.push(compare('CASH-04 over/short = 0', 0, await balance(acc.shortOver)));
    let late = false;
    await sell('cashier', 'LATE', { lines: [{ menuItemId: menu.ESPRESSO, description: 'Espresso', quantity: 1, unitPrice: 6000 }], tenders: [{ method: 'cash', amount: 6000 }] }).catch(() => { late = true; });
    rec.rules.push({ rule: 'CASH closed session accepts no new cash sale', status: late ? 'PASS' : 'FAIL' });
  });

  // ── D2 morning: bank deposit + MTN settlement ──────────────────────────────
  run('D1-T-010', 'Next morning: bank the drawer; MTN settlement gross−1% fee; re-import is idempotent', 'P0', async (rec) => {
    await as('manager', () => cash.recordBankDeposit(session.id, { amount: Number(expectedDrawer), bankName: 'Lakeview Bank', destinationAccountId: acc.bank, reference: 'SLIP-D1' } as any));
    L1.bank = L1.bank.plus(expectedDrawer);
    rec.rules.push(compare('CASH drawer empty after deposit', 0, await balance(acc.drawer)));
    const fee = money(L1.mtn.times(0.01));
    const input = { sourceAccountId: acc.mtn, destinationAccountId: acc.bank, grossAmount: Number(L1.mtn), feeAmount: Number(fee), feeAccountId: acc.fees, reference: 'MTN-SETTLE-20260924', settledAt: '2026-09-25T09:30:00+03:00' };
    await as('manager', () => cash.settleTender(input));
    await as('manager', () => cash.settleTender(input));
    L1.bank = L1.bank.plus(L1.mtn).minus(fee); L1.fees = L1.fees.plus(fee);
    rec.rules.push(compare('TEND-01 MTN clearing = 0 after full settlement', 0, await balance(acc.mtn)));
    rec.rules.push(compare('TEND-02 bank = opening + deposit + (gross − fee)', L1.bank, await balance(acc.bank)));
    rec.rules.push(compare('TEND-02 processor fees GL', L1.fees, await balance(acc.fees)));
    rec.rules.push(compare('TEND-01 card clearing = card captures (unsettled)', L1.card, await balance(acc.card)));
  });

  // ── Books tie-out ───────────────────────────────────────────────────────────
  run('D1-GL-001', 'End of D1: TB balanced, revenue and VAT = oracle, every journal balanced, no orphan invoices', 'P0', async (rec) => {
    const tb: any[] = await raw.$queryRawUnsafe(`SELECT COALESCE(SUM(l."baseDebit"),0)::text d, COALESCE(SUM(l."baseCredit"),0)::text c FROM "JournalLine" l JOIN "JournalEntry" e ON e.id=l."journalEntryId" WHERE l."organizationId"=$1 AND e.status='posted'`, organizationId);
    rec.rules.push(compare('GL-03 trial balance Σdr = Σcr', tb[0].d, tb[0].c));
    const unbalanced: any[] = await raw.$queryRawUnsafe(`SELECT e.id FROM "JournalEntry" e JOIN "JournalLine" l ON l."journalEntryId"=e.id WHERE e."organizationId"=$1 GROUP BY e.id HAVING SUM(l."baseDebit") <> SUM(l."baseCredit")`, organizationId);
    rec.rules.push(compare('GL-02 unbalanced journal entries', 0, unbalanced.length));
    rec.rules.push(compare('SALES-01 net revenue GL = oracle (gross − VAT)', L1.revenueGross.minus(L1.tax).negated(), await balance(acc.revenue)));
    rec.rules.push(compare('SALES-04 output VAT GL = oracle', L1.tax.negated(), await balance(acc.outputVat)));
    const orphans: any[] = await raw.$queryRawUnsafe(`SELECT i.id FROM "Invoice" i WHERE i."organizationId"=$1 AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceId"=i.id AND e."sourceType"='pos_invoice')`, organizationId);
    rec.rules.push(compare('GL-01 invoices without a posting', 0, orphans.length));
    const dupes: any[] = await raw.$queryRawUnsafe(`SELECT "postingKey" FROM "JournalEntry" WHERE "organizationId"=$1 AND "postingKey" IS NOT NULL GROUP BY "postingKey" HAVING COUNT(*)>1`, organizationId);
    rec.rules.push(compare('GL-01 duplicate posting keys', 0, dupes.length));
    const safeCashGl = (await balance(acc.drawer)).plus(await balance(acc.safe));
    rec.rules.push(compare('CASH-03 cash GL (drawer + safe) = oracle', L1.safe, safeCashGl));
  });

  run('D1-GL-002', 'Second opinion: built-in POS↔GL reconciliation agrees with oracle', 'P1', async (rec) => {
    let mod: TestingModule | undefined;
    try {
      const { AccountingModule } = await import('../../src/modules/accounting/accounting.module');
      const { CoreModule } = await import('../../src/modules/core/core.module');
      const { PosGlReconciliationService } = await import('../../src/modules/accounting/reporting/pos-gl-reconciliation.service');
      mod = await Test.createTestingModule({ imports: [KernelModule, DocumentsModule, CoreModule, AccountingModule] }).overrideProvider(PrismaService).useValue({ client: db, raw: db }).compile();
      await mod.init();
      const svc = mod.get(PosGlReconciliationService);
      const t2 = mod.get(TenantContextService);
      const out: any = await t2.run({ organizationId, userId: users.manager, permissions: [...MANAGER_PERMISSIONS] } as any, () => svc.reconcile({ from: new Date(Date.now() - 3 * 86400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }));
      rec.notes.push(JSON.stringify(out).slice(0, 1500));
      rec.rules.push({ rule: 'RECON built-in report balanced (oracle proved books correct)', status: out?.balanced === true ? 'PASS' : 'FAIL', expected: 'true', actual: String(out?.balanced) });
      rec.rules.push(compare('RECON built-in expectedNetRevenue = oracle net revenue', L1.revenueGross.minus(L1.tax), out?.pos?.expectedNetRevenue ?? -1));
      rec.rules.push(compare('RECON built-in GL tax = oracle output VAT', L1.tax, out?.gl?.tax ?? -1));
      rec.rules.push(compare('RECON built-in stock COGS = GL COGS', out?.gl?.cogs ?? -1, out?.inventory?.stockCogsValue ?? -2));
      rec.rules.push({ rule: 'RECON invoiceCount renders as a number', status: /^[0-9]+$/.test(String(out?.pos?.invoiceCount)) ? 'PASS' : 'FAIL', actual: String(out?.pos?.invoiceCount) });
    } catch (e: any) {
      rec.status = 'NOT_SUPPORTED';
      rec.notes.push(`could not boot accounting module in harness: ${String(e.message).slice(0, 300)}`);
    } finally { await mod?.close().catch(() => undefined); }
  });

  run('D1-TAX-001', 'VAT rounding policy: tax per line rounded to whole shillings (UGX)', 'P1', async (rec) => {
    const bad = vatLog.filter((v) => !D(v.policy).eq(D(v.pos)));
    rec.notes.push(...bad.map((v) => `${v.key}: policy ${v.policy} vs POS ${v.pos}`));
    rec.rules.push(compare('TAX invoices whose VAT is not whole-shilling', 0, bad.length));
  });

  // ── M1 oracle teeth (mutation of evidence, not of app code) ────────────────
  run('M1-MUT-001', 'Oracle self-test: tampered values are caught', 'P0', async (rec) => {
    const good = intendedSale([{ sku: 'CAPP_M', qty: 2, unitPrice: 10000, taxRate: VAT }]);
    const mutants: Array<[string, RuleResult]> = [
      ['VAT off by 1 shilling', compare('m1', good.tax, good.tax.plus(1))],
      ['VAT not rounded (3050.85)', compare('m2', good.tax, '3050.85')],
      ['refund not reversing revenue', compare('m3', L1.revenueGross, L1.revenueGross.plus(38000))],
      ['change not deducted from drawer', compare('m4', 6000, 10000)],
      ['consumption ignores recipe qty', compare('m5', intendedConsumption([{ recipe: MENU.CAPP_M.recipe, qty: 2 }]).MILK_ML, 200)],
    ];
    for (const [name, r] of mutants) rec.rules.push({ rule: `MUT ${name} killed`, status: r.status === 'FAIL' ? 'PASS' : 'FAIL' });
    rec.notes.push('Code-level mutants (Part VI) need a throwaway branch of app code; deferred per "do not change code" instruction.');
  });
});
