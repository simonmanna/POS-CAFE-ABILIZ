/**
 * Inventory P0 remediation (2026-09-14 audit): regression guards.
 *
 *   INV-001  Direct stock-in capitalises into the GL (Dr Stock Valuation / Cr Adj income).
 *   INV-002  Concurrent approval of one stock-out / transfer / adjustment posts once.
 *   INV-003  Concurrent GRN posts (distinct requests) receive the delivery once.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from '../_setup';
import { KernelModule } from '../../../src/kernel/kernel.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { CoreModule } from '../../../src/modules/core/core.module';
import { InventoryModule } from '../../../src/modules/inventory/inventory.module';
import { ProcurementModule } from '../../../src/modules/procurement/procurement.module';
import { InvoicingModule } from '../../../src/modules/invoicing/invoicing.module';
import { StockService } from '../../../src/modules/inventory/stock.service';
import { StockDocService } from '../../../src/modules/inventory/stock-doc.service';
import { DirectStockService } from '../../../src/modules/inventory/direct-stock.service';
import { GoodsReceiptsService } from '../../../src/modules/procurement/goods-receipts.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, AuditOrg } from './_harness';

// Kept below the Prisma pool size: losers wait on the claim's row lock holding a
// connection, and the winner still needs one for reads outside its tx.
const CONCURRENCY = 5;

describeDb('INV P0 remediation', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let docs: StockDocService;
  let direct: DirectStockService;
  let grns: GoodsReceiptsService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let staffId = '';

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: staffId, permissions: ['inventory_doc:approve'] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'P0');
    // Attribution ids are validated as active org users, so use a real one.
    staffId = (
      await prisma.user.create({
        data: { organizationId: org.organizationId, email: `p0-${Date.now()}@test.local`, passwordHash: 'x', firstName: 'P0' },
      })
    ).id;
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    docs = moduleRef.get(StockDocService);
    direct = moduleRef.get(DirectStockService);
    grns = moduleRef.get(GoodsReceiptsService);
    tenant = moduleRef.get(TenantContextService);
  }, 240_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 120_000);

  const makeProduct = (code: string) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId, code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: 10, salesPrice: 0,
      } as any,
    });

  const seed = (productId: string, qty: number, locationId = org.mainLocationId) =>
    asOrg(() =>
      stock.receiveForDocument(
        { productId, locationId, quantity: qty, unitCost: 10 } as any,
        { sourceType: 'p0_seed', sourceId: `seed-${productId}-${locationId}`, date: new Date() },
      ),
    );

  /** Net debit on an account from journal lines of one source. */
  const accountNet = async (accountId: string, sourceType: string) => {
    const lines = await prisma.journalLine.findMany({
      where: { accountId, entry: { organizationId: org.organizationId, sourceType } },
      select: { debit: true, credit: true },
    });
    return lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
  };

  it('INV-001: direct stock-in posts Dr Stock Valuation / Cr Adjustment income equal to ledger value', async () => {
    const product = await makeProduct('P0-DSI');
    const res = await asOrg(() =>
      direct.directIn({
        locationId: org.mainLocationId,
        responsibleById: staffId,
        approvedById: staffId,
        items: [{ productId: product.id, quantity: 7, unitCost: 13 }],
      } as any),
    );
    const ledgerValue = (
      await prisma.inventoryLedger.findMany({
        where: { organizationId: org.organizationId, referenceType: 'direct_stock_in', referenceId: res.code },
        select: { totalValue: true },
      })
    ).reduce((s, r) => s + Number(r.totalValue), 0);

    expect(ledgerValue).toBe(91);
    expect(await accountNet(org.accounts.stock_valuation, 'direct_stock_in')).toBe(91);
    expect(await accountNet(org.accounts.stock_adjustment_income, 'direct_stock_in')).toBe(-91);
    expect(await accountNet(org.accounts.grni_accrued, 'direct_stock_in')).toBe(0);
  }, 120_000);

  it('INV-002: concurrent approvals of one stock-out issue once', async () => {
    const product = await makeProduct('P0-SO');
    await seed(product.id, 50);
    const doc = await asOrg(() =>
      docs.createStockOut({
        locationId: org.mainLocationId, category: 'general_use',
        responsibleById: staffId, approvedById: staffId,
        items: [{ productId: product.id, qty: 4 }],
      } as any),
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => asOrg(() => docs.approveStockOut(doc.id))),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rows = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, referenceType: 'stock_out', referenceId: doc.outCode },
    });
    const jes = await prisma.journalEntry.count({
      where: { organizationId: org.organizationId, sourceType: 'stock_out', sourceId: doc.outCode },
    });

    expect(ok).toBe(1);
    expect(rows).toBe(1);
    expect(jes).toBe(1);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(46);
  }, 240_000);

  it('INV-002: concurrent approvals of one transfer move stock once', async () => {
    const product = await makeProduct('P0-TRF');
    await seed(product.id, 30);
    const doc = await asOrg(() =>
      docs.createTransfer({
        fromLocationId: org.mainLocationId, toLocationId: org.altLocationId,
        responsibleById: staffId, approvedById: staffId,
        items: [{ productId: product.id, qtyRequested: 5 }],
      } as any),
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => asOrg(() => docs.approveTransfer(doc.id))),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(25);
    expect(await onHand(prisma, org.organizationId, product.id, org.altLocationId)).toBe(5);
  }, 240_000);

  it('INV-002: concurrent approvals of one adjustment post once', async () => {
    const product = await makeProduct('P0-ADJ');
    await seed(product.id, 20);
    const doc = await asOrg(() =>
      docs.createAdjustment({
        locationId: org.mainLocationId, reason: 'cycle_count',
        responsibleById: staffId, approvedById: staffId,
        items: [{ productId: product.id, qtyActual: 17 }],
      } as any),
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => asOrg(() => docs.approveAdjustment(doc.id))),
    );
    const adjRows = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, productId: product.id, type: { in: ['adjustment_in', 'adjustment_out'] } },
    });
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(adjRows).toBe(1);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(17);
  }, 240_000);

  it('INV-003: concurrent posts of one draft GRN receive once', async () => {
    const product = await makeProduct('P0-GRN');
    const draft = await asOrg(() =>
      grns.createDraft({
        warehouseId: org.mainLocationId,
        lines: [{ productId: product.id, description: 'P0 GRN', quantity: 12, unitCost: 10 }],
      }),
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => asOrg(() => grns.post(draft.id))),
    );
    const receiptRows = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, referenceType: 'goods_receipt', referenceId: draft.id },
    });

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(receiptRows).toBe(1);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(12);
    expect(await accountNet(org.accounts.stock_valuation, 'goods_receipt')).toBe(120);
  }, 240_000);
});
