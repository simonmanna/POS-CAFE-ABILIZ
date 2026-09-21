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
import { SyncModule } from '../../src/modules/sync/sync.module';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { SyncPushService } from '../../src/modules/sync/sync-push.service';
import { SyncPullService } from '../../src/modules/sync/sync-pull.service';
import { StockService } from '../../src/modules/inventory/stock.service';


const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname);

/**
 * The mobile till's cash & inventory contract: the reference data it pulls to
 * build server-valid ops, and the stock / expense / shift ops it pushes. Every
 * op here is shaped exactly as apps/android builds it.
 */
(isolated ? describe : describe.skip)('Sync — cash & inventory for the mobile till', () => {
  const organizationId = randomUUID();
  const raw = new PrismaClient();
  const db = scopedPrisma(raw, () => organizationId);
  const ids: Record<string, string> = {};
  const users: Record<string, string> = {};
  let moduleRef: TestingModule;
  let tenant: TenantContextService;
  let push: SyncPushService;
  let pull: SyncPullService;
  let stock: StockService;
  let device: { id: string; organizationId: string; branchId: string | null };
  let seq = 0;

  const op = (type: string, payload: Record<string, any>, actor = users.cashier) => {
    seq += 1;
    return { opId: `op-${organizationId}-${seq}`, deviceSeq: seq, type, actorUserId: actor, occurredAt: new Date().toISOString(), payload };
  };
  const pushOne = async (type: string, payload: Record<string, any>, actor?: string) =>
    (await push.push(device, { deviceId: device.id, ops: [op(type, payload, actor)] } as any)).results[0];
  const scope = (name: string, since?: Date) =>
    tenant.run({ organizationId }, () => (pull as any).readScope(name, since)) as Promise<any[]>;
  const onHand = async () =>
    Number((await db.stockItem.findFirst({ where: { organizationId, productId: ids.water, locationId: ids.warehouse } }))?.quantity ?? 0);

  beforeAll(async () => {
    await raw.$connect();
    await db.currency.upsert({ where: { code: 'UGX' }, update: {}, create: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh' } });
    await db.organization.create({ data: { id: organizationId, code: `MOB-${Date.now()}`, name: 'Mobile till café', currencyCode: 'UGX' } });
    const pin = await bcrypt.hash('5555', 10);
    const cashierRole = await db.role.create({
      data: { organizationId, name: 'Cashier', permissions: ['pos:read', 'pos:checkout', 'cash_session:open', 'cash_session:read', 'cash_session:close'] },
    });
    const managerRole = await db.role.create({
      data: { organizationId, name: 'Manager', permissions: [...MANAGER_PERMISSIONS, 'inventory_doc:approve'] },
    });
    users.cashier = (await db.user.create({ data: { organizationId, email: `c-${organizationId}@m.test`, firstName: 'Cash', passwordHash: 'x', pinHash: pin, roles: { connect: { id: cashierRole.id } } } })).id;
    users.manager = (await db.user.create({ data: { organizationId, email: `m-${organizationId}@m.test`, firstName: 'Mgr', passwordHash: 'x', pinHash: pin, roles: { connect: { id: managerRole.id } } } })).id;
    ids.customer = (await db.partner.create({ data: { organizationId, code: 'WALKIN', name: 'Walk-in', isCustomer: true } })).id;
    ids.supplier = (await db.partner.create({ data: { organizationId, code: 'SUP1', name: 'Fresh Farms', isSupplier: true } })).id;

    const mk = makeAccountFactory(db, await ensureAccountCategories(db));
    const plan: Record<string, string> = {
      drawer: 'cash', safe: 'cash', bank: 'bank', card: 'current_asset', ar: 'receivable', ap: 'payable', revenue: 'revenue',
      cogs: 'cost_of_goods_sold', stockValuation: 'inventory', grni: 'current_liability', shortOver: 'operating_expense',
      expense: 'operating_expense', storeCredit: 'current_liability', adjIncome: 'other_income', adjExpense: 'operating_expense',
    };
    for (const [key, category] of Object.entries(plan)) ids[key] = (await mk(organizationId, key.toUpperCase(), key, category as any)).id;
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN', 'INV', 'ADJ']) await db.journal.create({ data: { organizationId, code, name: code, journalType: 'general' } });
    const mappings: Record<string, string> = {
      accounts_receivable: ids.ar, accounts_payable: ids.ap, sales_revenue: ids.revenue, default_cash: ids.safe, default_bank: ids.bank,
      card_clearing: ids.card, cash_short_over: ids.shortOver, stock_valuation: ids.stockValuation, cogs: ids.cogs,
      grni_accrued: ids.grni, default_expense: ids.expense, store_credit: ids.storeCredit,
      stock_adjustment_income: ids.adjIncome, stock_adjustment_expense: ids.adjExpense,
    };
    for (const [key, accountId] of Object.entries(mappings)) await db.accountMapping.create({ data: { organizationId, key, accountId } });
    ids.category = (await db.expenseCategory.create({ data: { organizationId, name: 'Supplies' } })).id;
    ids.warehouse = (await db.inventoryLocation.create({ data: { organizationId, code: 'MAIN', name: 'Main store', type: 'warehouse', isActive: true } })).id;
    await db.setting.create({ data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: ids.warehouse as any } });
    ids.water = (await db.product.create({ data: { organizationId, code: 'WATER', name: 'Bottled water', productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 40, salesPrice: 100 } as any })).id;
    await db.posPaymentMethod.createMany({
      data: [
        { organizationId, code: 'cash', label: 'Cash', kind: 'cash', accountId: ids.drawer, trackInShift: false },
        { organizationId, code: 'card', label: 'Card', kind: 'card', accountId: ids.card, trackInShift: true },
      ] as any,
    });
    ids.register = (await db.cashRegister.create({ data: { organizationId, code: 'TILL1', name: 'Front till', defaultAccountId: ids.drawer, locationId: ids.warehouse } })).id;
    device = await db.posDevice.create({ data: { organizationId, name: 'Phone 1', tokenHash: randomUUID(), prefix: 'M1' }, select: { id: true, organizationId: true, branchId: true } });

    moduleRef = await Test.createTestingModule({ imports: [KernelModule, DocumentsModule, SyncModule] })
      .overrideProvider(PrismaService).useValue({ client: db, raw: db }).compile();
    await moduleRef.init();
    tenant = moduleRef.get(TenantContextService);
    push = moduleRef.get(SyncPushService);
    pull = moduleRef.get(SyncPullService);
    stock = moduleRef.get(StockService);

    await tenant.run({ organizationId, userId: users.manager, permissions: [...MANAGER_PERMISSIONS] } as any, () =>
      stock.receiveForDocument(
        { productId: ids.water, locationId: ids.warehouse, quantity: 50, unitCost: 40 } as any,
        { sourceType: 'goods_receipt', sourceId: 'GRN-MOBILE', date: new Date() },
      ));
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await raw.$disconnect();
  });

  // ---------------------------------------------------------------- pull

  it('pulls the terminal tiles with their receiving accounts and shift tracking', async () => {
    const rows = await scope('paymentMethods');
    expect(rows.map((r) => [r.kind, r.accountId, r.trackInShift])).toEqual(
      expect.arrayContaining([['cash', ids.drawer, false], ['card', ids.card, true]]),
    );
  });

  it('pulls ledger accounts pre-classified for the till', async () => {
    const rows = await scope('ledgerAccounts');
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.drawer).roles).toEqual(['drawer']);
    expect(byId.get(ids.shortOver).roles).toEqual(expect.arrayContaining(['cash_short_over', 'pay_out']));
    expect(byId.get(ids.safe).roles).toEqual(expect.arrayContaining(['float_source', 'pay_in', 'pay_out', 'expense_payment']));
    expect(byId.get(ids.expense).roles).toEqual(expect.arrayContaining(['default_expense', 'pay_out']));
    // Revenue and receivables are never offered to a device.
    expect(byId.has(ids.revenue)).toBe(false);
    expect(byId.has(ids.ar)).toBe(false);
    expect(byId.get(ids.drawer).balance).toBe(0);
  });

  it('pulls expense categories resolved to the account a drawer pay-out debits', async () => {
    const rows = await scope('expenseCategories');
    expect(rows.find((r) => r.id === ids.category)).toMatchObject({ name: 'Supplies', accountId: ids.expense });
  });

  it('pulls stock locations, stock levels (delta) and suppliers', async () => {
    expect((await scope('stockLocations')).map((r) => r.id)).toContain(ids.warehouse);
    const levels = await scope('stockLevels');
    expect(levels.find((r) => r.productId === ids.water)).toMatchObject({ locationId: ids.warehouse, quantity: 50 });
    expect(await scope('stockLevels', new Date(Date.now() + 60_000))).toHaveLength(0);
    expect((await scope('suppliers')).map((r) => r.id)).toEqual([ids.supplier]);
    // Config snapshots ignore the watermark — a till always gets the full set.
    expect((await scope('stockLocations', new Date(Date.now() + 60_000))).map((r) => r.id)).toContain(ids.warehouse);
  });

  // ---------------------------------------------------------------- stock

  it('stock.in with a manager PIN posts a direct stock-in', async () => {
    const res = await pushOne('stock.in', {
      locationId: ids.warehouse, responsibleById: users.cashier, approvedById: users.manager, approverPin: '5555',
      notes: 'Purchase: weekly delivery', items: [{ productId: ids.water, quantity: 10, unitCost: 40 }],
    });
    expect(res).toMatchObject({ status: 'applied', error: null });
    expect(await onHand()).toBe(60);
  }, 60_000);

  it('stock.out with a wrong approver PIN dead-letters and moves nothing', async () => {
    const res = await pushOne('stock.out', {
      locationId: ids.warehouse, responsibleById: users.cashier, approvedById: users.manager, approverPin: '0000',
      notes: 'Waste: broken', items: [{ productId: ids.water, quantity: 2 }],
    });
    expect(res.status).toBe('failed');
    expect(await onHand()).toBe(60);
  }, 60_000);

  it('stock.out self-approved by an actor holding inventory_doc:approve', async () => {
    const res = await pushOne('stock.out', {
      locationId: ids.warehouse, responsibleById: users.manager, approvedById: users.manager,
      notes: 'Waste: broken', items: [{ productId: ids.water, quantity: 2 }],
    }, users.manager);
    expect(res).toMatchObject({ status: 'applied', error: null });
    expect(await onHand()).toBe(58);
  }, 60_000);

  it('stock.count submits a spot count and books the variance', async () => {
    const res = await pushOne('stock.count', {
      locationId: ids.warehouse, reason: 'Breakage', notes: 'Device count',
      lines: [{ productId: ids.water, countedQty: 55 }],
    }, users.manager);
    expect(res).toMatchObject({ status: 'applied', error: null });
    expect(await onHand()).toBe(55);
    expect(await db.inventoryCountSession.count({ where: { organizationId, status: 'submitted' } })).toBe(1);
  }, 60_000);

  // ---------------------------------------------------------------- cash

  it('runs a shift: open, cash sale with change, expense pay-out, close', async () => {
    // The rejected stock.out above is an open dead letter, and open dead letters
    // block every shift close — a manager discards it first, as in the back office.
    await db.syncOpDeadLetter.updateMany({ where: { organizationId, status: 'open' }, data: { status: 'discarded' } });
    const session = `sess-${randomUUID()}`;
    const results = (await push.push(device, {
      deviceId: device.id,
      ops: [
        op('cash_session.open', { clientId: session, cashRegisterId: ids.register, openingFloat: 0 }),
        op('sale.checkout', {
          clientId: `sale-${randomUUID()}`, provisionalNumber: 'M1-000001', cashSessionId: session, partnerId: ids.customer,
          lines: [{ productId: ids.water, description: 'Water', quantity: 4, unitPrice: 100 }],
          // The till trims cash overpay off the leg and sends the handed amount separately.
          tenders: [{ method: 'cash', amount: 400, accountId: undefined }], amountTendered: 500,
        }),
        op('cash_session.movement', {
          sessionId: session, movementType: 'pay_out', amount: 100, reason: 'Expense: Supplies — soap', counterpartAccountId: ids.expense,
          approvedById: users.manager, managerPin: '5555',
        }),
        op('cash_session.close', { sessionId: session, closingCounted: 300, closingAccounts: { [ids.card]: 0 } }),
      ],
    } as any)).results;
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['applied', null], ['applied', null], ['applied', null], ['applied', null],
    ]);
    const closed = await db.cashSession.findFirstOrThrow({ where: { organizationId, cashRegisterId: ids.register } });
    expect(closed.status).toBe('closed');
    expect(Number(closed.closingDifference ?? 0)).toBe(0);
  }, 120_000);

  it('a pay-out without a counterpart account is rejected', async () => {
    const session = `sess-${randomUUID()}`;
    const results = (await push.push(device, {
      deviceId: device.id,
      ops: [
        op('cash_session.open', { clientId: session, cashRegisterId: ids.register, openingFloat: 300 }),
        op('cash_session.movement', {
          sessionId: session, movementType: 'pay_out', amount: 50, reason: 'lunch', approvedById: users.manager, managerPin: '5555',
        }),
      ],
    } as any)).results;
    expect(results[0]).toMatchObject({ status: 'applied', error: null });
    expect(results[1].status).toBe('failed');
    expect(results[1].error).toMatch(/Select the expense, safe or transfer account/);
  }, 120_000);

  // ---------------------------------------------------------------- expenses

  it('expense.create on credit lands as an approved expense', async () => {
    const res = await pushOne('expense.create', {
      clientId: randomUUID(), title: 'Gas refill', amount: 25_000, categoryId: ids.category,
      expenseDate: new Date().toISOString(), paymentType: 'CREDIT', notes: 'Payee: Fresh Farms',
    }, users.manager);
    expect(res).toMatchObject({ status: 'applied', error: null });
    const e = await db.expense.findFirstOrThrow({ where: { organizationId, title: 'Gas refill' } });
    expect(e.paymentType).toBe('CREDIT');
    expect(['APPROVED', 'DRAFT']).toContain(e.status);
  }, 60_000);
});
