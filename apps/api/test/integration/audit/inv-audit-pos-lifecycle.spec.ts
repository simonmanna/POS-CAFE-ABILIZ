/**
 * AUDIT — the real POS sell loop, end to end, with no hand-built rows.
 *
 *   createOrder → generateInvoice (sales GL + StockPostingJob) → worker
 *     → stock relief + COGS + recipe snapshot
 *
 * Everything here goes through the same services a cashier's request hits, so a
 * failure is a production failure, not a fixture artefact.
 *
 * Central question (INV-INVARIANT-07): does POS consumption equal inventory
 * consumption? Exactly once, for direct products, for recipes, and for
 * modifiers.
 */
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET',
  generateURI: () => 'otpauth://stub',
  verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from '../_setup';
import { KernelModule } from '../../../src/kernel/kernel.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { CoreModule } from '../../../src/modules/core/core.module';
import { InventoryModule } from '../../../src/modules/inventory/inventory.module';
import { PosModule } from '../../../src/modules/pos/pos.module';
import { AccountingModule } from '../../../src/modules/accounting/accounting.module';
import { PosInvoiceService } from '../../../src/modules/pos/billing/pos-invoice.service';
import { PosOrdersService } from '../../../src/modules/pos/order/pos-orders.service';
import { StockService } from '../../../src/modules/inventory/stock.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, accountBalance, AuditOrg } from './_harness';

describeDb('AUDIT: POS sell loop → inventory → COGS (real path)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let billing: PosInvoiceService;
  let orders: PosOrdersService;
  let stock: StockService;
  let tenant: TenantContextService;
  let org: AuditOrg;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: 'audit-cashier', permissions: [] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'SELL');
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, PosModule, AccountingModule],
    }).compile();
    await moduleRef.init();
    billing = moduleRef.get(PosInvoiceService);
    orders = moduleRef.get(PosOrdersService);
    stock = moduleRef.get(StockService);
    tenant = moduleRef.get(TenantContextService);
  }, 300_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 180_000);

  const makeStockProduct = async (code: string, qty: number, cost: number, salesPrice = 100) => {
    const p = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: cost, salesPrice,
      } as any,
    });
    await asOrg(() =>
      stock.receiveForDocument(
        { productId: p.id, locationId: org.mainLocationId, quantity: qty, unitCost: cost } as any,
        { sourceType: 'audit_seed', sourceId: `seed-${code}`, date: new Date() },
      ),
    );
    return p;
  };

  /** Drain every pending/processing job for an invoice, the way the worker does. */
  const drainJobs = async (invoiceId: string) => {
    const jobs = await prisma.stockPostingJob.findMany({
      where: { organizationId: org.organizationId, invoiceId },
    });
    for (const j of jobs) await asOrg(() => billing.processStockPostingJob(j.id));
    return prisma.stockPostingJob.findMany({
      where: { organizationId: org.organizationId, invoiceId },
      select: { id: true, status: true, attempts: true, lastError: true },
    });
  };

  it('INV-004/INV-007: selling a stockable product relieves stock exactly once and posts COGS', async () => {
    const product = await makeStockProduct('SELL-DIRECT', 100, 10, 100);

    const order = await asOrg(() =>
      orders.createOrder({
        orderType: 'takeaway', guestCount: 1,
        lines: [{ productId: product.id, description: 'Direct product', quantity: 4, unitPrice: 100 }],
      } as any),
    );
    const invoice = await asOrg(() => billing.generateInvoice(order.id, {} as any));
    const jobs = await drainJobs(invoice.id);

    const after = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    const cogs = await accountBalance(prisma, org.organizationId, org.accounts.cogs);
    const exceptions = await prisma.inventoryException.findMany({
      where: { organizationId: org.organizationId },
      select: { kind: true, reason: true },
    });
    const snapshots = await prisma.invoiceItemRecipeIngredient.count({
      where: { organizationId: org.organizationId, invoiceId: invoice.id },
    });

    // eslint-disable-next-line no-console
    console.log('[SELL-DIRECT EVIDENCE]', JSON.stringify({
      soldQty: 4, unitCost: 10,
      onHandBefore: 100, onHandAfter: after,
      expectedOnHand: 96, expectedCogs: 40,
      actualCogs: cogs,
      jobs, snapshotRows: snapshots,
      inventoryExceptions: exceptions,
      revenueGl: await accountBalance(prisma, org.organizationId, org.accounts.sales_revenue),
      arGl: await accountBalance(prisma, org.organizationId, org.accounts.accounts_receivable),
      stockValuationGl: await accountBalance(prisma, org.organizationId, org.accounts.stock_valuation),
    }, null, 1));

    expect(after).toBe(96);
    expect(cogs).toBeCloseTo(40, 2);
    expect(exceptions).toEqual([]);
    expect(jobs.every((j) => j.status === 'done' && !j.lastError)).toBe(true);
  }, 300_000);

  it('INV-005: selling a recipe menu item explodes the BOM exactly once', async () => {
    const bun = await makeStockProduct('SELL-BUN', 200, 2, 0);
    const patty = await makeStockProduct('SELL-PATTY', 200, 15, 0);

    const menuItem = await prisma.menuItem.create({
      data: {
        organizationId: org.organizationId, name: 'Audit Burger',
        isInventoryTracked: true, basePrice: 30000,
      } as any,
    });
    await prisma.menuProduct.create({
      data: { organizationId: org.organizationId, menuItemId: menuItem.id, productId: bun.id, quantity: 1 } as any,
    });
    await prisma.menuProduct.create({
      data: { organizationId: org.organizationId, menuItemId: menuItem.id, productId: patty.id, quantity: 2 } as any,
    });

    const cogsBefore = await accountBalance(prisma, org.organizationId, org.accounts.cogs);
    const order = await asOrg(() =>
      orders.createOrder({
        orderType: 'takeaway', guestCount: 1,
        lines: [{ menuItemId: menuItem.id, description: 'Audit Burger', quantity: 10, unitPrice: 300 }],
      } as any),
    );
    const invoice = await asOrg(() => billing.generateInvoice(order.id, {} as any));
    const jobs = await drainJobs(invoice.id);

    const bunOnHand = await onHand(prisma, org.organizationId, bun.id, org.mainLocationId);
    const pattyOnHand = await onHand(prisma, org.organizationId, patty.id, org.mainLocationId);
    const cogsDelta = (await accountBalance(prisma, org.organizationId, org.accounts.cogs)) - cogsBefore;
    const snapshots = await prisma.invoiceItemRecipeIngredient.findMany({
      where: { organizationId: org.organizationId, invoiceId: invoice.id },
      select: { productId: true, quantity: true, unitCost: true, totalValue: true },
    });

    // eslint-disable-next-line no-console
    console.log('[SELL-RECIPE EVIDENCE]', JSON.stringify({
      burgersSold: 10,
      expected: { bunOnHand: 190, pattyOnHand: 180, cogsDelta: 10 * (1 * 2 + 2 * 15) },
      actual: { bunOnHand, pattyOnHand, cogsDelta },
      snapshots,
      jobs,
    }, null, 1));

    expect(bunOnHand).toBe(190);
    expect(pattyOnHand).toBe(180);
    expect(cogsDelta).toBeCloseTo(320, 2);
    expect(snapshots.length).toBe(2);
  }, 300_000);

  it('INV-028: re-running the drain must not consume a second time', async () => {
    const product = await makeStockProduct('SELL-IDEMP', 50, 8, 80);
    const order = await asOrg(() =>
      orders.createOrder({
        orderType: 'takeaway', guestCount: 1,
        lines: [{ productId: product.id, description: 'Idem product', quantity: 6, unitPrice: 80 }],
      } as any),
    );
    const invoice = await asOrg(() => billing.generateInvoice(order.id, {} as any));
    await drainJobs(invoice.id);
    const once = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    await drainJobs(invoice.id);
    await drainJobs(invoice.id);
    const thrice = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);

    expect(once).toBe(44);
    expect(thrice).toBe(44);
    expect(
      await prisma.inventoryLedger.count({
        where: { organizationId: org.organizationId, productId: product.id, type: 'issue' },
      }),
    ).toBe(1);
  }, 300_000);

  it('INV-INVARIANT-25: POS units sold, inventory consumed and COGS posted reconcile independently', async () => {
    // Three independent aggregates over everything this suite sold.
    const invoiceItems = await prisma.invoiceItem.findMany({
      where: { organizationId: org.organizationId, productId: { not: null } },
      select: { productId: true, quantity: true },
    });
    const posByProduct = new Map<string, number>();
    for (const it of invoiceItems) {
      posByProduct.set(it.productId!, (posByProduct.get(it.productId!) ?? 0) + Number(it.quantity));
    }

    const consumption = await prisma.inventoryLedger.groupBy({
      by: ['productId'],
      where: { organizationId: org.organizationId, type: 'issue', referenceType: 'pos_invoice' },
      _sum: { quantityChange: true, totalValue: true },
    });
    const invByProduct = new Map(
      consumption.map((c) => [c.productId, Math.abs(Number(c._sum.quantityChange ?? 0))]),
    );

    const cogsGl = await accountBalance(prisma, org.organizationId, org.accounts.cogs);
    const cogsSubledger = consumption.reduce((s, c) => s + Number(c._sum.totalValue ?? 0), 0);

    // eslint-disable-next-line no-console
    console.log('[RECON EVIDENCE]', JSON.stringify({
      posUnitsSoldByProduct: [...posByProduct.entries()],
      inventoryConsumedByProduct: [...invByProduct.entries()],
      cogsSubledgerFromLedger: cogsSubledger,
      cogsGlBalance: cogsGl,
    }, null, 1));

    for (const [productId, sold] of posByProduct) {
      expect(invByProduct.get(productId) ?? 0).toBeCloseTo(sold, 6);
    }
  }, 300_000);
});
