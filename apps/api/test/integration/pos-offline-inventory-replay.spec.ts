/**
 * Release certification (INV-P2-06): offline POS ops replayed through the real
 * sync push pipeline into inventory and the GL.
 *
 *   - a device batch (open shift → sale → partial refund) applied out of array order
 *   - the same batch re-pushed (duplicate delivery) and re-pushed after a crash
 *     between invoice commit and stock posting
 *   - the stock-posting job processed twice
 *
 * Invariants after every step: exactly one invoice per sale op, one stock job,
 * one issue + one restock movement, quant = Σ ledger, and
 * Stock Valuation GL = Σ ledger value, COGS GL = issue value − restock value.
 *
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
import { scopedPrisma } from '../scoped-prisma';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { SyncModule } from '../../src/modules/sync/sync.module';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { SyncPushService } from '../../src/modules/sync/sync-push.service';
import { PosInvoiceService } from '../../src/modules/pos/billing/pos-invoice.service';
import { StockService } from '../../src/modules/inventory/stock.service';
import { accountLedgerBalance } from '../../src/modules/accounting/treasury/session-reconciliation';

/* eslint-disable @typescript-eslint/no-explicit-any */

const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname);

(isolated ? describe : describe.skip)('Offline POS replay → inventory → GL certification', () => {
  const organizationId = randomUUID();
  const raw = new PrismaClient();
  const db = scopedPrisma(raw, () => organizationId);
  const ids: Record<string, string> = {};
  const users: Record<string, string> = {};
  let moduleRef: TestingModule;
  let tenant: TenantContextService;
  let push: SyncPushService;
  let billing: PosInvoiceService;
  let stock: StockService;
  let device: { id: string; organizationId: string; branchId: string | null };

  const asManager = <T>(fn: () => Promise<T>) =>
    tenant.run({ organizationId, userId: users.manager, permissions: [...MANAGER_PERMISSIONS] } as any, fn);
  const bal = async (accountId: string) =>
    Number((await db.$transaction((tx: any) => accountLedgerBalance(tx, organizationId, accountId))).toString());
  const onHand = async () =>
    Number((await db.stockItem.findFirst({ where: { organizationId, productId: ids.water, locationId: ids.warehouse } }))?.quantity ?? 0);
  const ledger = async () => {
    const rows = await db.inventoryLedger.findMany({ where: { organizationId, productId: ids.water } });
    const qty = rows.reduce((s: number, r: any) => s + Number(r.quantityChange), 0);
    const value = rows.reduce((s: number, r: any) => s + (Number(r.quantityChange) >= 0 ? 1 : -1) * Number(r.totalValue), 0);
    return { rows, qty, value };
  };
  const drain = async () => {
    const jobs = await db.stockPostingJob.findMany({ where: { organizationId, status: { not: 'done' } } });
    for (const job of jobs) await asManager(() => billing.processStockPostingJob(job.id));
  };
  const assertTieOut = async () => {
    const l = await ledger();
    expect(await onHand()).toBeCloseTo(l.qty, 6);
    expect(await bal(ids.stockValuation)).toBeCloseTo(l.value, 2);
    const issued = l.rows.filter((r: any) => r.type === 'issue').reduce((s: number, r: any) => s + Number(r.totalValue), 0);
    const restocked = l.rows.filter((r: any) => r.type === 'return_in').reduce((s: number, r: any) => s + Number(r.totalValue), 0);
    expect(await bal(ids.cogs)).toBeCloseTo(issued - restocked, 2);
  };

  const sessionClient = `sess-${randomUUID()}`;
  const saleClient = `sale-${randomUUID()}`;
  const op = (deviceSeq: number, type: string, payload: Record<string, any>, actor = users.cashier) => ({
    opId: `op-${organizationId}-${deviceSeq}`,
    deviceSeq,
    type,
    actorUserId: actor,
    occurredAt: new Date().toISOString(),
    payload,
  });

  beforeAll(async () => {
    await raw.$connect();
    await db.currency.upsert({ where: { code: 'UGX' }, update: {}, create: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh' } });
    await db.organization.create({ data: { id: organizationId, code: `OFFL-${Date.now()}`, name: 'Offline replay café', currencyCode: 'UGX' } });
    const pin = await bcrypt.hash('5555', 10);
    const cashierPerms = ['pos:read', 'pos:checkout', 'cash_session:open', 'cash_session:read', 'cash_session:close'];
    const cashierRole = await db.role.create({ data: { organizationId, name: 'Cashier', permissions: cashierPerms } });
    const managerRole = await db.role.create({ data: { organizationId, name: 'Manager', permissions: [...MANAGER_PERMISSIONS] } });
    users.cashier = (await db.user.create({ data: { organizationId, email: `cashier-${organizationId}@offline.test`, firstName: 'Cash', passwordHash: 'x', pinHash: pin, roles: { connect: { id: cashierRole.id } } } })).id;
    users.manager = (await db.user.create({ data: { organizationId, email: `manager-${organizationId}@offline.test`, firstName: 'Mgr', passwordHash: 'x', pinHash: pin, roles: { connect: { id: managerRole.id } } } })).id;
    ids.customer = (await db.partner.create({ data: { organizationId, code: 'WALKIN', name: 'Walk-in', isCustomer: true } })).id;

    const mk = makeAccountFactory(db, await ensureAccountCategories(db));
    const plan: Record<string, string> = {
      drawer: 'cash', safe: 'cash', bank: 'bank', card: 'current_asset', ar: 'receivable', ap: 'payable', revenue: 'revenue',
      cogs: 'cost_of_goods_sold', stockValuation: 'inventory', grni: 'current_liability', shortOver: 'operating_expense',
      expense: 'operating_expense', storeCredit: 'current_liability',
    };
    for (const [key, category] of Object.entries(plan)) ids[key] = (await mk(organizationId, key.toUpperCase(), key, category as any)).id;
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN', 'INV']) await db.journal.create({ data: { organizationId, code, name: code, journalType: 'general' } });
    const mappings: Record<string, string> = {
      accounts_receivable: ids.ar, accounts_payable: ids.ap, sales_revenue: ids.revenue, default_cash: ids.safe, default_bank: ids.bank,
      card_clearing: ids.card, cash_short_over: ids.shortOver, stock_valuation: ids.stockValuation, cogs: ids.cogs,
      grni_accrued: ids.grni, default_expense: ids.expense, store_credit: ids.storeCredit,
    };
    for (const [key, accountId] of Object.entries(mappings)) await db.accountMapping.create({ data: { organizationId, key, accountId } });
    ids.warehouse = (await db.inventoryLocation.create({ data: { organizationId, code: 'MAIN', name: 'Main store', type: 'warehouse', isActive: true } })).id;
    await db.setting.create({ data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: ids.warehouse as any } });
    ids.water = (await db.product.create({ data: { organizationId, code: 'WATER', name: 'Bottled water', productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 40, salesPrice: 100 } as any })).id;
    await db.posPaymentMethod.createMany({ data: [{ organizationId, code: 'cash', label: 'Cash', kind: 'cash', accountId: ids.drawer, trackInShift: false }] as any });
    ids.register = (await db.cashRegister.create({ data: { organizationId, code: 'TILL1', name: 'Front till', defaultAccountId: ids.drawer, locationId: ids.warehouse } })).id;
    device = await db.posDevice.create({ data: { organizationId, name: 'Tablet 1', tokenHash: randomUUID(), prefix: 'D1' }, select: { id: true, organizationId: true, branchId: true } });

    moduleRef = await Test.createTestingModule({ imports: [KernelModule, DocumentsModule, SyncModule] })
      .overrideProvider(PrismaService).useValue({ client: db, raw: db }).compile();
    await moduleRef.init();
    tenant = moduleRef.get(TenantContextService);
    push = moduleRef.get(SyncPushService);
    billing = moduleRef.get(PosInvoiceService);
    stock = moduleRef.get(StockService);
    // Manager PIN verification is certified by the override suites.
    (billing as any).overrides = { verifyOperationApproval: async () => undefined };

    await asManager(() => stock.receiveForDocument(
      { productId: ids.water, locationId: ids.warehouse, quantity: 50, unitCost: 40 } as any,
      { sourceType: 'goods_receipt', sourceId: 'GRN-OFFLINE', date: new Date() },
    ));
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await raw.$disconnect();
  });

  let batch: any[] = [];

  it('1. applies an offline batch pushed out of array order, in deviceSeq order', async () => {
    batch = [
      op(2, 'sale.checkout', {
        clientId: saleClient, provisionalNumber: 'D1-000001', cashSessionId: sessionClient, partnerId: ids.customer,
        lines: [{ productId: ids.water, description: 'Water', quantity: 4, unitPrice: 100 }], tenders: [{ method: 'cash', amount: 400 }],
      }),
      op(1, 'cash_session.open', { clientId: sessionClient, cashRegisterId: ids.register, openingFloat: 0 }),
    ];
    const res = await push.push(device, { ops: [...batch] } as any);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(res.lastPushSeq).toBe(2);
    await drain();
    expect(await onHand()).toBe(46);
    expect(await db.invoice.count({ where: { organizationId } })).toBe(1);
    await assertTieOut();
  }, 120_000);

  it('2. duplicate delivery of the same batch replays without a second sale, job or movement', async () => {
    const before = await ledger();
    const res = await push.push(device, { ops: [...batch].reverse() } as any);
    expect(res.results.every((r) => r.status === 'replayed')).toBe(true);
    await drain();
    expect(await db.invoice.count({ where: { organizationId } })).toBe(1);
    expect(await db.stockPostingJob.count({ where: { organizationId } })).toBe(1);
    expect((await ledger()).rows).toHaveLength(before.rows.length);
    expect(await onHand()).toBe(46);
    await assertTieOut();
  }, 120_000);

  it('3. crash between invoice commit and stock posting: replay + double processing yield one effect', async () => {
    const saleB = `sale-${randomUUID()}`;
    const crashOp = op(3, 'sale.checkout', {
      clientId: saleB, cashSessionId: (await db.cashSession.findFirstOrThrow({ where: { organizationId } })).id, partnerId: ids.customer,
      lines: [{ productId: ids.water, description: 'Water', quantity: 2, unitPrice: 100 }], tenders: [{ method: 'cash', amount: 200 }],
    });
    // First delivery commits the invoice; the "device" never sees the response
    // and the worker has not drained yet.
    await push.push(device, { ops: [crashOp] } as any);
    expect(await onHand()).toBe(46);
    // Device retries after reconnecting.
    const retry = await push.push(device, { ops: [crashOp] } as any);
    expect(retry.results[0].status).toBe('replayed');
    const job = await db.stockPostingJob.findFirstOrThrow({ where: { organizationId, status: { not: 'done' } } });
    await asManager(() => billing.processStockPostingJob(job.id));
    await asManager(() => billing.processStockPostingJob(job.id));
    expect(await onHand()).toBe(44);
    expect(await db.inventoryLedger.count({ where: { organizationId, productId: ids.water, type: 'issue' } })).toBe(2);
    await assertTieOut();
  }, 120_000);

  it('4. offline partial refund of a synced sale restocks once, even when re-pushed', async () => {
    const invoice = await db.invoice.findFirstOrThrow({ where: { organizationId, deviceId: device.id, provisionalNumber: 'D1-000001' } as any, include: { items: true } as any });
    const refundOp = op(4, 'sale.refund', {
      invoiceId: invoice.id, reason: 'one bottle leaking', overrideById: users.manager,
      cashSessionId: (await db.cashSession.findFirstOrThrow({ where: { organizationId } })).id,
      lines: [{ lineId: (invoice as any).items[0].id, quantity: 1 }],
    }, users.manager);
    const first = await push.push(device, { ops: [refundOp] } as any);
    expect(first.results[0]).toMatchObject({ status: 'applied', error: null });
    const again = await push.push(device, { ops: [refundOp] } as any);
    expect(again.results[0].status).toBe('replayed');
    await drain();
    expect(await onHand()).toBe(45);
    expect(await db.inventoryLedger.count({ where: { organizationId, productId: ids.water, type: 'return_in' } })).toBe(1);
    await assertTieOut();
  }, 120_000);

  it('5. a dependent op whose parent failed dead-letters instead of touching stock', async () => {
    const orphanSession = `sess-${randomUUID()}`;
    const res = await push.push(device, {
      ops: [
        op(5, 'cash_session.open', { clientId: orphanSession, cashRegisterId: randomUUID(), openingFloat: 0 }),
        op(6, 'sale.checkout', {
          clientId: `sale-${randomUUID()}`, cashSessionId: orphanSession, partnerId: ids.customer,
          lines: [{ productId: ids.water, description: 'Water', quantity: 1, unitPrice: 100 }], tenders: [{ method: 'cash', amount: 100 }],
        }),
      ],
    } as any);
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(res.results[1].httpStatus).toBe(424);
    await drain();
    expect(await onHand()).toBe(45);
    await assertTieOut();
  }, 120_000);
});
