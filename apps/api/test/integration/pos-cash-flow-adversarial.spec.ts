/**
 * Release certification — adversarial suite on the REAL PrismaService (tenancy
 * extension active), real triggers and real locks:
 *   - cross-tenant read / update / delete / money operations must all fail;
 *   - a bad inventory line never erases good lines, retries post only what is
 *     missing, modifier snapshots hang off the InvoiceItem;
 *   - account running balances are authoritative across pages;
 *   - races: register configuration vs shift open, payment void vs shift close;
 *   - lost responses for drawer movement, shift close and expense payment.
 * Runs only against a disposable `pos_stage1_<digits>` database.
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
import { ensureAccountCategories, makeAccountFactory } from './_accounts';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { PosModule } from '../../src/modules/pos/pos.module';
import { ExpensesModule } from '../../src/modules/expenses/expenses.module';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { IdempotencyService } from '../../src/kernel/idempotency/idempotency.service';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { CashFlowService } from '../../src/modules/accounting/treasury/cash-flow.service';
import { CashRegisterService } from '../../src/modules/accounting/treasury/cash-register.service';
import { PaymentService } from '../../src/modules/invoicing/payment/payment.service';
import { ExpensesService } from '../../src/modules/expenses/expenses.service';
import { PosInvoiceService } from '../../src/modules/pos/billing/pos-invoice.service';
import { StockService } from '../../src/modules/inventory/stock.service';

const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname);

(isolated ? describe : describe.skip)('Cash flow certification: adversarial', () => {
  const raw = new PrismaClient();
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let tenant: TenantContextService;
  let cash: CashSessionService;
  let cashFlow: CashFlowService;
  let registers: CashRegisterService;
  let payments: PaymentService;
  let expenses: ExpensesService;
  let billing: PosInvoiceService;
  let stock: StockService;
  let idempotency: IdempotencyService;

  type Org = { id: string; ids: Record<string, string>; users: Record<string, string> };
  const A: Org = { id: randomUUID(), ids: {}, users: {} };
  const B: Org = { id: randomUUID(), ids: {}, users: {} };
  const CASHIER = ['pos:read', 'pos:checkout', 'cash_session:open', 'cash_session:read', 'cash_session:close'];
  const as = <T>(org: Org, who: 'cashier' | 'manager', fn: () => Promise<T>) =>
    tenant.run({ organizationId: org.id, userId: org.users[who], permissions: who === 'cashier' ? CASHIER : [...MANAGER_PERMISSIONS] } as any, fn);
  const bal = async (org: Org, accountId: string) => {
    const t = await raw.journalLine.aggregate({ where: { organizationId: org.id, accountId, entry: { status: { in: ['posted', 'reversed'] } } }, _sum: { baseDebit: true, baseCredit: true } });
    return Number(t._sum.baseDebit ?? 0) - Number(t._sum.baseCredit ?? 0);
  };
  const onHand = async (org: Org, productId: string) => Number((await raw.stockItem.findFirst({ where: { organizationId: org.id, productId, locationId: org.ids.warehouse } }))?.quantity ?? 0);

  async function provision(org: Org, tag: string) {
    await raw.organization.create({ data: { id: org.id, code: `ADV-${tag}-${Date.now()}`, name: `Adversarial ${tag}`, currencyCode: 'UGX' } });
    const pin = await bcrypt.hash('5555', 10);
    const managerRole = await raw.role.create({ data: { organizationId: org.id, name: 'Manager', permissions: [...MANAGER_PERMISSIONS] } });
    const cashierRole = await raw.role.create({ data: { organizationId: org.id, name: 'Cashier', permissions: CASHIER } });
    org.users.cashier = (await raw.user.create({ data: { organizationId: org.id, email: `cashier-${tag}@adv.test`, firstName: 'C', passwordHash: 'x', pinHash: pin, roles: { connect: { id: cashierRole.id } } } })).id;
    org.users.manager = (await raw.user.create({ data: { organizationId: org.id, email: `manager-${tag}@adv.test`, firstName: 'M', passwordHash: 'x', pinHash: pin, roles: { connect: { id: managerRole.id } } } })).id;
    org.ids.supplier = (await raw.partner.create({ data: { organizationId: org.id, code: 'SUP', name: 'Supplier', isSupplier: true, isCustomer: true } })).id;
    const mk = makeAccountFactory(raw, await ensureAccountCategories(raw));
    const plan: Record<string, string> = { drawer: 'cash', drawer2: 'cash', safe: 'cash', bank: 'bank', ar: 'receivable', ap: 'payable', revenue: 'revenue', equity: 'equity', expense: 'operating_expense', shortOver: 'operating_expense', cogs: 'cost_of_goods_sold', stockValuation: 'inventory', grni: 'current_liability', wht: 'current_liability' };
    for (const [key, category] of Object.entries(plan)) org.ids[key] = (await mk(org.id, key.toUpperCase(), key, category as any)).id;
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN', 'INV']) await raw.journal.create({ data: { organizationId: org.id, code, name: code, journalType: 'general' } });
    for (const [key, accountId] of Object.entries({ accounts_receivable: org.ids.ar, accounts_payable: org.ids.ap, sales_revenue: org.ids.revenue, default_cash: org.ids.safe, default_bank: org.ids.bank, cash_short_over: org.ids.shortOver, withholding_payable: org.ids.wht, stock_valuation: org.ids.stockValuation, cogs: org.ids.cogs, grni_accrued: org.ids.grni, default_expense: org.ids.expense })) {
      await raw.accountMapping.create({ data: { organizationId: org.id, key, accountId } });
    }
    org.ids.warehouse = (await raw.inventoryLocation.create({ data: { organizationId: org.id, code: 'WH', name: 'Store', type: 'warehouse', isActive: true } })).id;
    await raw.setting.create({ data: { organizationId: org.id, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: org.ids.warehouse as any } });
    org.ids.register = (await raw.cashRegister.create({ data: { organizationId: org.id, code: 'R1', name: 'Till', defaultAccountId: org.ids.drawer } })).id;
    org.ids.category = (await raw.expenseCategory.create({ data: { organizationId: org.id, name: 'Ops', ledgerAccountId: org.ids.expense } })).id;
    await as(org, 'manager', () => cashFlow.deposit({ accountId: org.ids.safe, counterpartAccountId: org.ids.equity, operationType: 'owner_contribution', amount: 5000, description: 'Capital' }));
  }

  beforeAll(async () => {
    await raw.$connect();
    await raw.currency.upsert({ where: { code: 'UGX' }, update: {}, create: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh' } });
    moduleRef = await Test.createTestingModule({ imports: [KernelModule, DocumentsModule, PosModule, ExpensesModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    tenant = moduleRef.get(TenantContextService);
    cash = moduleRef.get(CashSessionService);
    cashFlow = moduleRef.get(CashFlowService);
    registers = moduleRef.get(CashRegisterService);
    payments = moduleRef.get(PaymentService);
    expenses = moduleRef.get(ExpensesService);
    billing = moduleRef.get(PosInvoiceService);
    stock = moduleRef.get(StockService);
    idempotency = moduleRef.get(IdempotencyService);
    await provision(A, 'A');
    await provision(B, 'B');
  }, 180000);

  afterAll(async () => {
    await moduleRef?.close();
    await raw.$disconnect();
  });

  describe('tenant isolation (application layer)', () => {
    let sessionA: any;
    let paymentA: any;
    let expenseA: any;
    beforeAll(async () => {
      sessionA = await as(A, 'cashier', () => cash.open({ cashRegisterId: A.ids.register, openingFloat: 100, openingSourceAccountId: A.ids.safe, notes: 'Float' }));
      paymentA = await as(A, 'cashier', () => payments.createSupplierPayment({ partnerId: A.ids.supplier, paymentDate: new Date().toISOString(), paymentMethod: 'cash', amount: 10, cashSessionId: sessionA.id, allowOverpayment: true } as any));
      expenseA = await as(A, 'manager', () => expenses.create({ title: 'Paper', amount: 5, expenseDate: new Date().toISOString(), paymentType: 'CREDIT', categoryId: A.ids.category } as any));
    }, 60000);

    it('tenant B cannot read, update or delete tenant A financial rows', async () => {
      await as(B, 'manager', async () => {
        expect(await prisma.client.cashSession.findFirst({ where: { id: sessionA.id } })).toBeNull();
        expect(await prisma.client.payment.findFirst({ where: { id: paymentA.id } })).toBeNull();
        expect(await prisma.client.cashMovement.count({ where: { cashSessionId: sessionA.id } })).toBe(0);
        expect((await prisma.client.cashSession.updateMany({ where: { id: sessionA.id }, data: { notes: 'hijack' } })).count).toBe(0);
        expect((await prisma.client.expense.deleteMany({ where: { id: expenseA.id } })).count).toBe(0);
        // A client-supplied organizationId cannot escape the tenant: the filter is
        // replaced by the caller's own organization.
        const escaped = await prisma.client.journalEntry.findMany({ where: { organizationId: A.id } });
        expect(escaped.filter((e) => e.organizationId === A.id)).toHaveLength(0);
      });
    });

    it('tenant B cannot move tenant A money through any service', async () => {
      await as(B, 'manager', async () => {
        await expect(cash.close({ sessionId: sessionA.id, closingCounted: 90, notes: 'hostile' }, { force: true })).rejects.toThrow(/not found|No open cash session/i);
        await expect(cash.recordBankDeposit(sessionA.id, { amount: 1, bankName: 'X', destinationAccountId: B.ids.bank })).rejects.toThrow(/not found/i);
        await expect(cashFlow.deposit({ accountId: A.ids.bank, counterpartAccountId: B.ids.equity, operationType: 'owner_contribution', amount: 1, description: 'x' })).rejects.toThrow(/not found/i);
        await expect(cashFlow.withdraw({ accountId: B.ids.safe, counterpartAccountId: A.ids.equity, operationType: 'owner_drawing', amount: 1, description: 'x' })).rejects.toThrow(/not found/i);
        await expect(payments.void(paymentA.id, { reason: 'x' })).rejects.toThrow(/not found/i);
        await expect(expenses.pay(expenseA.id, { paymentMethod: 'CASH', accountId: B.ids.safe } as any)).rejects.toThrow(/not found/i);
        await expect(registers.update(A.ids.register, { name: 'hijack' })).rejects.toThrow(/not found/i);
        await expect(cashFlow.getTransactions(A.ids.safe, 1, 25)).rejects.toThrow(/not found/i);
      });
      expect((await raw.cashSession.findUniqueOrThrow({ where: { id: sessionA.id } })).status).toBe('open');
      expect((await raw.payment.findUniqueOrThrow({ where: { id: paymentA.id } })).status).toBe('posted');
    });

    it('the same idempotency key in two tenants names two independent operations', async () => {
      const key = `shared-${randomUUID()}`;
      const path = '/api/v1/accounts/cash-flow/deposit';
      const body = (org: Org) => ({ accountId: org.ids.bank, counterpartAccountId: org.ids.equity, operationType: 'owner_contribution', amount: 7, description: 'Key namespace' });
      await as(A, 'manager', () => idempotency.executeWithKey({ key, path, requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await cashFlow.deposit(body(A)) }) }));
      const outB = await as(B, 'manager', () => idempotency.executeWithKey({ key, path, requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await cashFlow.deposit(body(B)) }) }));
      expect(outB.replayed).toBe(false);
      expect(await bal(A, A.ids.bank)).toBe(7);
      expect(await bal(B, B.ids.bank)).toBe(7);
    });

    afterAll(async () => {
      await as(A, 'manager', () => payments.void(paymentA.id, { reason: 'Test cleanup' }));
      await as(A, 'cashier', () => cash.close({ sessionId: sessionA.id, closingCounted: 100 }));
    }, 60000);
  });

  describe('inventory line isolation and retry', () => {
    it('a bad line never erases good lines; the retry posts only what is missing', async () => {
      const org = A;
      const product = async (code: string) => {
        const id = (await raw.product.create({ data: { organizationId: org.id, code, name: code, productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 10, salesPrice: 50 } as any })).id;
        await as(org, 'manager', () => stock.receiveForDocument({ productId: id, locationId: org.ids.warehouse, quantity: 100, unitCost: 10 } as any, { sourceType: 'seed', sourceId: `seed-${code}`, date: new Date() }));
        return id;
      };
      const p1 = await product(`ADV-P1-${Date.now()}`);
      const p2 = await product(`ADV-P2-${Date.now()}`);
      const p3 = await product(`ADV-P3-${Date.now()}`);
      const shot = await product(`ADV-SHOT-${Date.now()}`);
      const beans = await product(`ADV-BEANS-${Date.now()}`);
      const group = await raw.modifierGroup.create({ data: { organizationId: org.id, name: 'Extras' } as any });
      const modifier = await raw.modifier.create({ data: { organizationId: org.id, groupId: group.id, name: 'Extra shot', inventoryItemId: shot, consumptionQty: 2 } as any });
      const latte = await raw.menuItem.create({ data: { organizationId: org.id, name: 'Latte (no recipe yet)', isInventoryTracked: true } as any });

      const order = await raw.order.create({ data: { organizationId: org.id, orderNumber: `ADV-ORD-${Date.now()}`, status: 'closed' } });
      const lines = [
        { productId: p1, quantity: 1, lineNumber: 1 },
        { productId: p2, quantity: 2, lineNumber: 2 },
        { menuItemId: latte.id, quantity: 1, lineNumber: 3 },
        { productId: p3, quantity: 3, lineNumber: 4 },
      ];
      const orderItems: any[] = [];
      for (const l of lines) orderItems.push(await raw.orderItem.create({ data: { organizationId: org.id, orderId: order.id, description: 'line', ...l } as any }));
      await raw.orderItemModifier.create({ data: { organizationId: org.id, orderItemId: orderItems[0].id, modifierId: modifier.id, name: 'Extra shot' } });
      const invoice = await raw.invoice.create({ data: { organizationId: org.id, invoiceNumber: `ADV-INV-${Date.now()}`, partnerId: org.ids.supplier, status: 'posted' } as any });
      const invoiceItems: any[] = [];
      for (const l of lines) invoiceItems.push(await raw.invoiceItem.create({ data: { organizationId: org.id, invoiceId: invoice.id, description: 'line', ...l } as any }));
      const job = await raw.stockPostingJob.create({ data: { organizationId: org.id, orderId: order.id, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, idempotencyKey: `at_invoice:${invoice.id}` } });

      await as(org, 'manager', () => billing.processStockPostingJob(job.id));
      expect([await onHand(org, p1), await onHand(org, p2), await onHand(org, p3), await onHand(org, shot)]).toEqual([99, 98, 97, 98]);
      let state = await raw.stockPostingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(state.status).toBe('pending');
      expect(state.postedLineKeys.length).toBe(4); // 3 good lines + the modifier component
      const snapshot = await raw.invoiceItemRecipeIngredient.findFirstOrThrow({ where: { organizationId: org.id, productId: shot } });
      expect(snapshot.invoiceItemId).toBe(invoiceItems[0].id);

      await as(org, 'manager', () => billing.processStockPostingJob(job.id)); // still broken: no double relief, no duplicate exception
      expect([await onHand(org, p1), await onHand(org, p2), await onHand(org, p3), await onHand(org, shot)]).toEqual([99, 98, 97, 98]);
      expect(await raw.inventoryException.count({ where: { organizationId: org.id, invoiceId: invoice.id, status: 'open' } })).toBe(1);

      await raw.menuProduct.create({ data: { organizationId: org.id, menuItemId: latte.id, productId: beans, quantity: 5 } as any });
      await as(org, 'manager', () => billing.processStockPostingJob(job.id));
      state = await raw.stockPostingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(state.status).toBe('done');
      expect([await onHand(org, p1), await onHand(org, p2), await onHand(org, p3), await onHand(org, shot), await onHand(org, beans)]).toEqual([99, 98, 97, 98, 95]);
      const cogsEntries = await raw.journalEntry.count({ where: { organizationId: org.id, sourceId: { in: [invoice.id, `${orderItems[0].id}:${modifier.id}`] } } });
      expect(cogsEntries).toBe(5); // one per relieved line/component, never repeated
    }, 180000);
  });

  describe('authoritative balances', () => {
    it('running balances continue exactly across pages and match the account balance', async () => {
      const org = B;
      for (let i = 1; i <= 30; i++) {
        await as(org, 'manager', () => cashFlow.deposit({ accountId: org.ids.bank, counterpartAccountId: org.ids.equity, operationType: 'owner_contribution', amount: i, description: `Page probe ${i}` }));
      }
      const p1: any = await as(org, 'manager', () => cashFlow.getTransactions(org.ids.bank, 1, 25));
      const p2: any = await as(org, 'manager', () => cashFlow.getTransactions(org.ids.bank, 2, 25));
      const total = await bal(org, org.ids.bank);
      expect(Number(p1.account.currentBalance)).toBe(total);
      expect(Number(p1.data[0].runningBalance)).toBe(total);
      const last1 = p1.data[p1.data.length - 1];
      expect(Number(p2.data[0].runningBalance)).toBeCloseTo(Number(last1.runningBalance) - (Number(last1.baseDebit) - Number(last1.baseCredit)), 6);
      const oldest = p2.data[p2.data.length - 1];
      expect(Number(oldest.runningBalance)).toBeCloseTo(Number(oldest.baseDebit) - Number(oldest.baseCredit), 6);
    }, 120000);
  });

  describe('races and lost responses', () => {
    it('register configuration racing a shift open never splits the drawer account', async () => {
      const org = B;
      const outcomes = await Promise.allSettled([
        as(org, 'manager', () => registers.update(org.ids.register, { defaultAccountId: org.ids.drawer2 })),
        as(org, 'cashier', () => cash.open({ cashRegisterId: org.ids.register, openingFloat: 0 })),
      ]);
      expect(outcomes[1].status).toBe('fulfilled');
      const session = await raw.cashSession.findFirstOrThrow({ where: { organizationId: org.id, cashRegisterId: org.ids.register, status: 'open' } });
      const register = await raw.cashRegister.findUniqueOrThrow({ where: { id: org.ids.register } });
      expect(session.drawerAccountId).toBe(register.defaultAccountId);
      if (outcomes[0].status === 'rejected') expect(String(outcomes[0].reason.message)).toMatch(/active shift/);
      const other = register.defaultAccountId === org.ids.drawer ? org.ids.drawer2 : org.ids.drawer;
      await expect(as(org, 'manager', () => registers.update(org.ids.register, { defaultAccountId: other }))).rejects.toThrow(/active shift/);
      await as(org, 'cashier', () => cash.close({ sessionId: session.id, closingCounted: 0 }));
    }, 60000);

    it('a payment void racing the shift close lands entirely before or entirely after it', async () => {
      const org = B;
      const session: any = await as(org, 'cashier', () => cash.open({ cashRegisterId: org.ids.register, openingFloat: 200, openingSourceAccountId: org.ids.safe, notes: 'Float' }));
      const payment: any = await as(org, 'cashier', () => payments.createSupplierPayment({ partnerId: org.ids.supplier, paymentDate: new Date().toISOString(), paymentMethod: 'cash', amount: 50, cashSessionId: session.id, allowOverpayment: true } as any));
      const [closeOutcome, voidOutcome] = await Promise.allSettled([
        as(org, 'cashier', () => cash.close({ sessionId: session.id, closingCounted: 150, varianceReason: 'race probe' })),
        as(org, 'manager', () => payments.void(payment.id, { reason: 'race probe' })),
      ]);
      const closed = await raw.cashSession.findUniqueOrThrow({ where: { id: session.id } });
      const movements = await raw.cashMovement.findMany({ where: { cashSessionId: session.id } });
      const recomputed = movements.reduce((s, m) => (['sale', 'pay_in', 'adjustment'].includes(m.movementType) ? s + Number(m.amount) : s - Number(m.amount)), 200);
      if (closeOutcome.status === 'fulfilled') {
        expect(Number(closed.closingExpected)).toBe(recomputed); // the Z saw exactly what the drawer holds
        const z: any = (await raw.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } })).reportData;
        expect(Number(z.totals.expectedCash)).toBe(recomputed);
        if (voidOutcome.status === 'rejected') expect(String(voidOutcome.reason.message)).toMatch(/closed shift/);
      } else {
        expect(voidOutcome.status).toBe('fulfilled'); // void won; close saw a different expected cash and must be redone
        await as(org, 'cashier', () => cash.close({ sessionId: session.id, closingCounted: recomputed }));
      }
    }, 60000);

    it('lost responses on drawer movement, shift close and expense payment never duplicate money', async () => {
      const org = A;
      const session: any = await as(org, 'cashier', () => cash.open({ cashRegisterId: org.ids.register, openingFloat: 100 }));
      const replay = async (who: 'cashier' | 'manager', key: string, path: string, handler: () => Promise<any>) => {
        const run = () => as(org, who, () => idempotency.executeWithKey({ key, path, requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await handler() }) }));
        const first = await run();
        const second = await run();
        expect(second.replayed).toBe(true);
        return first;
      };
      await replay('cashier', `mv-${randomUUID()}`, '/api/v1/cash-sessions/movement', () => cash.recordMovement(session.id, { movementType: 'pay_in', amount: 25, reason: 'Change', counterpartAccountId: org.ids.safe }));
      expect(await raw.cashMovement.count({ where: { cashSessionId: session.id, movementType: 'pay_in' } })).toBe(1);

      const expense: any = await as(org, 'manager', () => expenses.create({ title: 'Cleaning', amount: 30, expenseDate: new Date().toISOString(), paymentType: 'CREDIT', categoryId: org.ids.category } as any));
      await replay('manager', `exp-${randomUUID()}`, `/api/v1/expenses/${expense.id}/pay`, () => expenses.pay(expense.id, { paymentMethod: 'CASH', accountId: org.ids.safe } as any));
      expect(await raw.expensePayment.count({ where: { expenseId: expense.id } })).toBe(1);

      const key = `close-${randomUUID()}`;
      const closeRun = () => as(org, 'cashier', () => idempotency.executeWithKey({ key, path: '/api/v1/cash-sessions/close', requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await cash.close({ sessionId: session.id, closingCounted: 125 }) }) }));
      const both = await Promise.allSettled([closeRun(), closeRun()]);
      expect(both.some((o) => o.status === 'fulfilled')).toBe(true);
      expect((await closeRun()).replayed).toBe(true);
      expect(await raw.posReportSnapshot.count({ where: { cashSessionId: session.id } })).toBe(1);
      expect(await raw.journalEntry.count({ where: { organizationId: org.id, sourceType: 'cash_session_variance', sourceId: session.id } })).toBe(0);
    }, 120000);
  });
});
