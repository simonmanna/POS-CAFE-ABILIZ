/**
 * Release certification: one realistic café business day through the real Nest
 * services on real PostgreSQL (triggers, locks, keys), then the auditor's
 * invariants:
 *
 *   payments by tender = drawer movements = expected drawer = Z snapshot = GL
 *   stock ledger       = on-hand          = COGS
 *
 * and "nothing after close rewrites the closed day". Runs only against a
 * disposable `pos_stage1_<digits>` database.
 */
import { randomUUID } from 'node:crypto';
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET',
  generateURI: () => 'otpauth://stub',
  verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { MANAGER_PERMISSIONS } from '@erp/shared';
import { scopedPrisma } from '../scoped-prisma';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { PosModule } from '../../src/modules/pos/pos.module';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { IdempotencyService } from '../../src/kernel/idempotency/idempotency.service';
import { AuditService } from '../../src/kernel/audit/audit.service';
import { PosService } from '../../src/modules/pos/pos.service';
import { PosInvoiceService } from '../../src/modules/pos/billing/pos-invoice.service';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { CashFlowService } from '../../src/modules/accounting/treasury/cash-flow.service';
import { PaymentService } from '../../src/modules/invoicing/payment/payment.service';
import { StockService } from '../../src/modules/inventory/stock.service';
import { accountLedgerBalance, reconcileSession } from '../../src/modules/accounting/treasury/session-reconciliation';

const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname);

(isolated ? describe : describe.skip)('Cash flow certification: a full café day', () => {
  const organizationId = randomUUID();
  const raw = new PrismaClient();
  const db = scopedPrisma(raw, () => organizationId);
  const ids: Record<string, string> = {};
  const users: Record<string, string> = {};
  let moduleRef: TestingModule;
  let tenant: TenantContextService;
  let pos: PosService;
  let billing: PosInvoiceService;
  let cash: CashSessionService;
  let cashFlow: CashFlowService;
  let payments: PaymentService;
  let stock: StockService;
  let idempotency: IdempotencyService;
  let registerId: string;
  let day1: any;
  const invoices: Record<string, string> = {};
  const supplierPayments: Record<string, string> = {};

  const CASHIER_PERMS = ['pos:read', 'pos:checkout', 'pos:discount', 'cash_session:open', 'cash_session:read', 'cash_session:close'];
  const as = <T>(who: 'cashier' | 'manager' | 'manager2', fn: () => Promise<T>) =>
    tenant.run({ organizationId, userId: users[who], permissions: who === 'cashier' ? CASHIER_PERMS : [...MANAGER_PERMISSIONS] } as any, fn);
  const txRun = <T>(fn: (tx: any) => Promise<T>) => db.$transaction(async (tx: any) => fn(tx));
  const bal = async (id: string) => Number((await txRun((tx) => accountLedgerBalance(tx, organizationId, id))).toString());
  const onHand = async () => Number((await db.stockItem.findFirst({ where: { organizationId, productId: ids.water, locationId: ids.warehouse } }))?.quantity ?? 0);
  const drainStock = async () => {
    const jobs = await db.stockPostingJob.findMany({ where: { organizationId, status: { not: 'done' } } });
    for (const job of jobs) await as('manager', () => billing.processStockPostingJob(job.id));
  };
  const sell = (key: string, input: any) => as('cashier', async () => {
    const result: any = await pos.checkout({ partnerId: ids.customer, cashSessionId: day1.id, ...input });
    invoices[key] = result.invoiceId;
    return result;
  });

  beforeAll(async () => {
    await raw.$connect();
    await db.currency.upsert({ where: { code: 'UGX' }, update: {}, create: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh' } });
    await db.organization.create({ data: { id: organizationId, code: `DAY-${Date.now()}`, name: 'Certification café', currencyCode: 'UGX' } });
    const pin = await bcrypt.hash('5555', 10);
    const cashierRole = await db.role.create({ data: { organizationId, name: 'Cashier', permissions: CASHIER_PERMS } });
    const managerRole = await db.role.create({ data: { organizationId, name: 'Manager', permissions: [...MANAGER_PERMISSIONS] } });
    users.cashier = (await db.user.create({ data: { organizationId, email: 'cashier@day.test', firstName: 'Cash', passwordHash: 'x', pinHash: pin, roles: { connect: { id: cashierRole.id } } } })).id;
    users.manager = (await db.user.create({ data: { organizationId, email: 'manager@day.test', firstName: 'Mgr', passwordHash: 'x', pinHash: pin, roles: { connect: { id: managerRole.id } } } })).id;
    users.manager2 = (await db.user.create({ data: { organizationId, email: 'manager2@day.test', firstName: 'Mgr2', passwordHash: 'x', pinHash: pin, roles: { connect: { id: managerRole.id } } } })).id;
    ids.customer = (await db.partner.create({ data: { organizationId, code: 'WALKIN', name: 'Walk-in', isCustomer: true } })).id;
    ids.supplier = (await db.partner.create({ data: { organizationId, code: 'MILK', name: 'Milk supplier', isSupplier: true } })).id;

    const mk = makeAccountFactory(db, await ensureAccountCategories(db));
    const plan: Record<string, string> = {
      drawer: 'cash', safe: 'cash', bank: 'bank', airtel: 'mobile_money', card: 'current_asset', ar: 'receivable', ap: 'payable',
      revenue: 'revenue', cogs: 'cost_of_goods_sold', stockValuation: 'inventory', grni: 'current_liability', wht: 'current_liability',
      shortOver: 'operating_expense', expense: 'operating_expense', equity: 'equity', storeCredit: 'current_liability',
    };
    for (const [key, category] of Object.entries(plan)) ids[key] = (await mk(organizationId, key.toUpperCase(), key, category as any)).id;
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN', 'INV']) await db.journal.create({ data: { organizationId, code, name: code, journalType: 'general' } });
    const mappings: Record<string, string> = {
      accounts_receivable: ids.ar, accounts_payable: ids.ap, sales_revenue: ids.revenue, default_cash: ids.safe, default_bank: ids.bank,
      card_clearing: ids.card, mobile_money: ids.airtel, cash_short_over: ids.shortOver, withholding_payable: ids.wht,
      stock_valuation: ids.stockValuation, cogs: ids.cogs, grni_accrued: ids.grni, default_expense: ids.expense, store_credit: ids.storeCredit,
    };
    for (const [key, accountId] of Object.entries(mappings)) await db.accountMapping.create({ data: { organizationId, key, accountId } });
    ids.warehouse = (await db.inventoryLocation.create({ data: { organizationId, code: 'MAIN', name: 'Main store', type: 'warehouse', isActive: true } })).id;
    await db.setting.create({ data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: ids.warehouse as any } });
    ids.water = (await db.product.create({ data: { organizationId, code: 'WATER', name: 'Bottled water', productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 40, salesPrice: 100 } as any })).id;
    await db.posPaymentMethod.createMany({ data: [
      { organizationId, code: 'cash', label: 'Cash', kind: 'cash', accountId: ids.drawer, trackInShift: false },
      { organizationId, code: 'card', label: 'Card', kind: 'card', accountId: ids.card, trackInShift: false },
      { organizationId, code: 'airtel', label: 'Airtel Money', kind: 'mobile_money', accountId: ids.airtel, trackInShift: true },
    ] as any });
    registerId = (await db.cashRegister.create({ data: { organizationId, code: 'TILL1', name: 'Front till', defaultAccountId: ids.drawer, locationId: ids.warehouse } })).id;

    moduleRef = await Test.createTestingModule({ imports: [KernelModule, DocumentsModule, PosModule] })
      .overrideProvider(PrismaService).useValue({ client: db, raw: db }).compile();
    await moduleRef.init();
    tenant = moduleRef.get(TenantContextService);
    pos = moduleRef.get(PosService);
    billing = moduleRef.get(PosInvoiceService);
    cash = moduleRef.get(CashSessionService);
    cashFlow = moduleRef.get(CashFlowService);
    payments = moduleRef.get(PaymentService);
    stock = moduleRef.get(StockService);
    idempotency = moduleRef.get(IdempotencyService);

    await as('manager', async () => {
      await cashFlow.deposit({ accountId: ids.safe, counterpartAccountId: ids.equity, operationType: 'owner_contribution', amount: 10000, description: 'Opening capital' });
      await stock.receiveForDocument({ productId: ids.water, locationId: ids.warehouse, quantity: 50, unitCost: 40 } as any, { sourceType: 'goods_receipt', sourceId: 'GRN-DAY', date: new Date() });
    });
  }, 120000);

  afterAll(async () => {
    await moduleRef?.close();
    await raw.$disconnect();
  });

  it('1. opens the shift with a counted float funded from the safe', async () => {
    day1 = await as('cashier', () => cash.open({ cashRegisterId: registerId, openingFloat: 100, openingSourceAccountId: ids.safe, notes: 'Float from safe' }));
    expect(day1.drawerAccountId).toBe(ids.drawer);
    expect(day1.registerLocationId).toBe(ids.warehouse);
    expect(await bal(ids.drawer)).toBe(100);
  });

  it('2. sells in cash, card, mobile money, mixed tender and with a discount', async () => {
    await sell('cash', { lines: [{ productId: ids.water, description: 'Water', quantity: 2, unitPrice: 100 }], tenders: [{ method: 'cash', amount: 200 }] });
    await sell('card', { lines: [{ productId: ids.water, description: 'Water', quantity: 1, unitPrice: 100 }], tenders: [{ method: 'card', amount: 100 }] });
    await sell('mobile', { lines: [{ productId: ids.water, description: 'Water', quantity: 1, unitPrice: 100 }], tenders: [{ method: 'mobile_money', amount: 100 }] });
    await sell('mixed', { lines: [{ productId: ids.water, description: 'Water', quantity: 3, unitPrice: 100 }], tenders: [{ method: 'cash', amount: 100 }, { method: 'card', amount: 100 }, { method: 'mobile_money', amount: 100 }] });
    await sell('discount', { lines: [{ productId: ids.water, description: 'Water', quantity: 2, unitPrice: 100 }], transactionDiscountPercent: 10, discountReason: 'Loyal customer', expectedTotal: 180, tenders: [{ method: 'cash', amount: 180 }] });
    expect(await bal(ids.drawer)).toBe(100 + 200 + 100 + 180);
    expect(await bal(ids.card)).toBe(200);
    expect(await bal(ids.airtel)).toBe(200);
  }, 120000);

  it('3. a retried checkout (lost response) and a concurrent duplicate produce ONE sale', async () => {
    const key = `checkout-${randomUUID()}`;
    const path = '/api/v1/pos/checkout';
    const body = { partnerId: ids.customer, cashSessionId: day1.id, lines: [{ productId: ids.water, description: 'Water', quantity: 1, unitPrice: 100 }], tenders: [{ method: 'card', amount: 100 }] };
    const before = await db.invoice.count({ where: { organizationId } });
    const attempt = () => as('cashier', () => idempotency.executeWithKey({ key, path, requestHash: 'same', runHandler: async () => ({ statusCode: 201, body: await pos.checkout(body as any) }) }));
    const concurrent = await Promise.allSettled([attempt(), attempt()]);
    expect(concurrent.some((o) => o.status === 'fulfilled')).toBe(true);
    const retry = await attempt(); // the terminal never saw a response and retries
    expect(retry.replayed).toBe(true);
    expect(await db.invoice.count({ where: { organizationId } })).toBe(before + 1);
    invoices.retried = (retry.body as any).invoiceId;
    await expect(as('cashier', () => idempotency.executeWithKey({ key, path, requestHash: 'different', runHandler: async () => ({ statusCode: 201, body: {} }) }))).rejects.toThrow(/different request/);
    expect(await bal(ids.card)).toBe(300);
  }, 120000);

  it('4. refunds the cash sale with manager approval, out of the current drawer', async () => {
    await as('cashier', () => billing.refund(invoices.cash, 'Customer returned sealed water', { overrideById: users.manager, overridePin: '5555', stockDisposition: 'no_return', cashSessionId: day1.id }));
    await as('cashier', async () => {
      await expect(billing.refund(invoices.card, 'No approval', { overrideById: users.cashier, overridePin: '5555', stockDisposition: 'no_return', cashSessionId: day1.id })).rejects.toThrow();
    });
    expect(await bal(ids.drawer)).toBe(580 - 200);
  }, 60000);

  it('5. records cash in, cash out and a cash drop to the safe under manager approval', async () => {
    await as('cashier', () => cash.recordMovement(day1.id, { movementType: 'pay_in', amount: 50, reason: 'Change from safe', counterpartAccountId: ids.safe }));
    await as('cashier', async () => {
      await expect(cash.recordMovement(day1.id, { movementType: 'pay_in', amount: 999, reason: 'Fake sale', counterpartAccountId: ids.revenue })).rejects.toThrow(/sales are recorded only through payments/);
      await expect(cash.recordMovement(day1.id, { movementType: 'pay_out', amount: 30, reason: 'Ice', counterpartAccountId: ids.expense })).rejects.toThrow(/manager approval/);
    });
    await as('cashier', () => cash.recordMovement(day1.id, { movementType: 'pay_out', amount: 30, reason: 'Ice', counterpartAccountId: ids.expense, approverEmail: 'manager@day.test', managerPin: '5555' }));
    await as('cashier', () => cash.recordMovement(day1.id, { movementType: 'pay_out', amount: 200, reason: 'Cash drop to safe', counterpartAccountId: ids.safe, approverEmail: 'manager@day.test', managerPin: '5555' }));
    expect(await bal(ids.drawer)).toBe(380 + 50 - 30 - 200);
  });

  it('6. pays suppliers from the till, one with withholding tax, and voids one exactly once', async () => {
    const plain: any = await as('cashier', () => payments.createSupplierPayment({ partnerId: ids.supplier, paymentDate: new Date().toISOString(), paymentMethod: 'cash', amount: 60, cashSessionId: day1.id, allowOverpayment: true } as any));
    const withWht: any = await as('cashier', () => payments.createSupplierPayment({ partnerId: ids.supplier, paymentDate: new Date().toISOString(), paymentMethod: 'cash', amount: 100, withholdingAmount: 6, cashSessionId: day1.id, allowOverpayment: true } as any));
    supplierPayments.plain = plain.id;
    supplierPayments.wht = withWht.id;
    expect((await db.cashMovement.findFirstOrThrow({ where: { paymentId: withWht.id } })).movementType).toBe('supplier_payment');
    expect(await bal(ids.drawer)).toBe(200 - 60 - 94);

    await as('cashier', async () => {
      await expect(payments.void(plain.id, { reason: 'Cashier cannot void' })).rejects.toThrow(/payment:void|permission/i);
    });
    await expect(as('manager', () => payments.void(plain.id, {}))).rejects.toThrow(/reason/);
    const voids = await Promise.allSettled([
      as('manager', () => payments.void(plain.id, { reason: 'Duplicate delivery note' })),
      as('manager', () => payments.void(plain.id, { reason: 'Duplicate delivery note' })),
    ]);
    expect(voids.map((v) => (v.status === 'fulfilled' ? 'ok' : String((v as any).reason?.message)))).toContain('ok');
    await as('manager', () => payments.void(plain.id, { reason: 'Duplicate delivery note' })); // a replay is a no-op
    const payment = await db.payment.findUniqueOrThrow({ where: { id: plain.id } });
    expect(payment.status).toBe('cancelled');
    expect(payment.voidReason).toBe('Duplicate delivery note');
    expect(await db.cashMovement.count({ where: { reversalOfMovementId: { not: null }, cashSessionId: day1.id } })).toBe(1);
    expect(await db.journalEntry.count({ where: { organizationId, reversalOfId: payment.journalEntryId } })).toBe(1);
    expect(await bal(ids.drawer)).toBe(46 + 60);
  }, 60000);

  it('7. relieves stock and posts COGS exactly once for every bottle sold', async () => {
    await drainStock();
    await drainStock(); // a second worker pass changes nothing
    const sold = 2 + 1 + 1 + 3 + 2 + 1;
    expect(await onHand()).toBe(50 - sold);
    expect(await bal(ids.cogs)).toBe(sold * 40);
    expect(await bal(ids.stockValuation)).toBe((50 - sold) * 40);
    const ledgerQty = await db.inventoryLedger.aggregate({ where: { organizationId, productId: ids.water }, _sum: { quantityChange: true } });
    expect(Number(ledgerQty._sum.quantityChange)).toBe(50 - sold);
    expect(await db.stockPostingJob.count({ where: { organizationId, status: { not: 'done' } } })).toBe(0);
  }, 120000);

  it('8. closes the shift: payments = movements = expected = Z = GL', async () => {
    const recon: any = await as('cashier', () => txRun((tx) => reconcileSession(tx, organizationId, day1)));
    expect(recon.issues).toEqual([]);
    const expected = 106;
    expect(recon.report.totals.expectedCash).toBe(String(expected));
    expect(Number(recon.ledgerCash)).toBe(expected);

    const cashPayments = await db.payment.findMany({ where: { organizationId, cashSessionId: day1.id, paymentMethod: 'cash', status: { not: 'cancelled' } } });
    const movements = await db.cashMovement.findMany({ where: { cashSessionId: day1.id } });
    for (const p of cashPayments) {
      const m = movements.filter((mv) => mv.paymentId === p.id);
      expect(m).toHaveLength(1);
      expect(Number(m[0].amount)).toBe(Number(p.amount) - Number(p.withholdingAmount));
    }

    await expect(as('manager', () => cash.close({ sessionId: day1.id, closingCounted: expected, closingAccounts: { [ids.airtel]: 200 } }))).rejects.toThrow(/Only the session cashier/);
    const closed: any = await as('cashier', () => cash.close({ sessionId: day1.id, closingCounted: expected, closingDenomination: { '50': 2, '5': 1, '1': 1 }, closingAccounts: { [ids.airtel]: 200 } }));
    expect(closed.status).toBe('closed');
    const z: any = (await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: day1.id } })).reportData;
    expect(z.closingExpected).toBe(String(expected));
    expect(z.closingCounted).toBe(String(expected));
    expect(z.totals.expectedCash).toBe(String(expected));
    expect(z.totals.supplierPayouts).toBe('154');
    expect(await bal(ids.drawer)).toBe(expected);
  }, 60000);

  it('9. next day: banking, reconciliation and corrections never rewrite the closed day', async () => {
    const frozen = await db.cashSession.findUniqueOrThrow({ where: { id: day1.id } });
    const z = (await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: day1.id } })).reportData;
    const movementCount = await db.cashMovement.count({ where: { cashSessionId: day1.id } });

    await as('manager', () => cash.recordBankDeposit(day1.id, { amount: 106, bankName: 'Stanbic', destinationAccountId: ids.bank, reference: 'SLIP-1' }));
    expect(await bal(ids.drawer)).toBe(0);
    await as('manager', () => cash.reconcile(day1.id, {}));

    // A cash supplier payment from the closed day is voided today: the
    // correction lands in today's shift, linked to the closed one.
    const day2: any = await as('manager', () => cash.open({ cashRegisterId: registerId, openingFloat: 0 }));
    await expect(as('manager', () => payments.void(supplierPayments.wht, { reason: 'Supplier refunded' }))).rejects.toThrow(/closed shift/);
    await as('manager', () => payments.void(supplierPayments.wht, { reason: 'Supplier refunded', correctionSessionId: day2.id }));
    const correction = await db.cashMovement.findFirstOrThrow({ where: { cashSessionId: day2.id, correctionOfSessionId: day1.id } });
    expect(Number(correction.amount)).toBe(94);

    const after = await db.cashSession.findUniqueOrThrow({ where: { id: day1.id } });
    expect(after.closingCounted?.toString()).toBe(frozen.closingCounted?.toString());
    expect(after.closingDifference?.toString()).toBe(frozen.closingDifference?.toString());
    expect(after.status).toBe('reconciled');
    expect(await db.cashMovement.count({ where: { cashSessionId: day1.id } })).toBe(movementCount);
    expect((await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: day1.id } })).reportData).toEqual(z);
    const recon: any = await as('manager', () => txRun((tx) => reconcileSession(tx, organizationId, day2)));
    expect(recon.issues).toEqual([]);
    expect(recon.report.totals.expectedCash).toBe('94');

    // Trial balance still balances after the whole day.
    const totals = await db.journalLine.aggregate({ where: { organizationId }, _sum: { baseDebit: true, baseCredit: true } });
    expect(Number(totals._sum.baseDebit)).toBeCloseTo(Number(totals._sum.baseCredit), 6);
  }, 120000);

  it('10. a crash inside a money operation leaves nothing behind, and the retry posts once', async () => {
    const audit = moduleRef.get(AuditService);
    const key = `deposit-crash-${randomUUID()}`;
    const path = '/api/v1/accounts/cash-flow/deposit';
    const body = { accountId: ids.bank, counterpartAccountId: ids.equity, operationType: 'owner_contribution', amount: 777, description: 'Crash probe' };
    const run = () => as('manager', () => idempotency.executeWithKey({ key, path, requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await cashFlow.deposit(body) }) }));
    const spy = jest.spyOn(audit, 'recordInTx').mockRejectedValueOnce(new Error('simulated crash after journal'));
    await expect(run()).rejects.toThrow(/simulated crash/);
    spy.mockRestore();
    expect(await db.journalEntry.count({ where: { organizationId, description: { contains: 'Crash probe' } } })).toBe(0);
    await expect(run()).rejects.toThrow(/needs recovery/); // still inside the in-flight window
    // Age the attempt past the in-flight window (relative to its own timestamp).
    await raw.$executeRawUnsafe(`UPDATE "IdempotencyRecord" SET "createdAt" = "createdAt" - interval '10 minutes' WHERE key = $1`, key);
    await run();
    await run(); // lost response: replayed
    expect(await db.journalEntry.count({ where: { organizationId, description: { contains: 'Crash probe' } } })).toBe(1);
  }, 60000);
});
