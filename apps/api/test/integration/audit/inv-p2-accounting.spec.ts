/**
 * Inventory Phase 2 + 3 remediation (2026-09-14 audit): accounting tie-out,
 * posted reversals and database-enforced ledger evidence.
 *
 *   INV-010  Posted reversals for waste / stock-out / adjustment / transfer / GRN.
 *   INV-011  Accounting valuation works (current + historical) and ties to the GL.
 *   INV-013  The stock ledger rejects UPDATE / DELETE / broken arithmetic.
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
import { StockReversalService } from '../../../src/modules/inventory/stock-reversal.service';
import { DirectStockService } from '../../../src/modules/inventory/direct-stock.service';
import { GoodsReceiptsService } from '../../../src/modules/procurement/goods-receipts.service';
import { PurchaseOrdersService } from '../../../src/modules/procurement/purchase-orders.service';
import { InventoryValuationReportService } from '../../../src/modules/accounting/reporting/inventory-valuation.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, AuditOrg } from './_harness';

describeDb('INV P2/P3 accounting + evidence', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let docs: StockDocService;
  let reversals: StockReversalService;
  let direct: DirectStockService;
  let grns: GoodsReceiptsService;
  let pos: PurchaseOrdersService;
  let valuation: InventoryValuationReportService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let staffId = '';
  let supplierId = '';

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run(
      { organizationId: org.organizationId, userId: staffId, permissions: ['goods_receipt:create', 'goods_receipt:post', 'inventory_doc:approve'] },
      fn,
    );

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'P2');
    staffId = (
      await prisma.user.create({
        data: { organizationId: org.organizationId, email: `p2-${Date.now()}@test.local`, passwordHash: 'x', firstName: 'P2' },
      })
    ).id;
    supplierId = (
      await prisma.partner.create({
        data: { organizationId: org.organizationId, code: 'P2-SUP', name: 'P2 Supplier', isSupplier: true },
      })
    ).id;
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    docs = moduleRef.get(StockDocService);
    reversals = moduleRef.get(StockReversalService);
    direct = moduleRef.get(DirectStockService);
    grns = moduleRef.get(GoodsReceiptsService);
    pos = moduleRef.get(PurchaseOrdersService);
    valuation = moduleRef.get(InventoryValuationReportService);
    tenant = moduleRef.get(TenantContextService);
  }, 240_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 120_000);

  const makeProduct = (code: string, overrides: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId, code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: 10, salesPrice: 0,
        ...overrides,
      } as any,
    });

  /** Stock Valuation GL balance for the whole test org. */
  const stockGl = async () => {
    const lines = await prisma.journalLine.findMany({
      where: { accountId: org.accounts.stock_valuation, entry: { organizationId: org.organizationId, status: { not: 'draft' } } },
      select: { debit: true, credit: true },
    });
    return Math.round(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0) * 100) / 100;
  };

  it('INV-010: waste reversal restores stock and nets the GL back to zero', async () => {
    const product = await makeProduct('P2-WASTE');
    await asOrg(() => direct.directIn({
      locationId: org.mainLocationId, responsibleById: staffId, approvedById: staffId,
      items: [{ productId: product.id, quantity: 10, unitCost: 10 }],
    } as any));
    const glBefore = await stockGl();

    const waste = await asOrg(() => docs.createWaste({
      locationId: org.mainLocationId, responsibleById: staffId, approvedById: staffId,
      items: [{ productId: product.id, qty: 3 }],
    } as any));
    await asOrg(() => docs.approveWaste(waste.id));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(7);
    expect(await stockGl()).toBe(glBefore - 30);

    const reversed: any = await asOrg(() => reversals.reverseDocument('waste', waste.id, 'counted wrong'));
    expect(reversed.status).toBe('reversed');
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(10);
    expect(await stockGl()).toBe(glBefore);

    await expect(asOrg(() => reversals.reverseDocument('waste', waste.id, 'again'))).rejects.toThrow(/already reversed/);
  }, 120_000);

  it('INV-010: batch adjustment gain reversal takes the units back out of the lot', async () => {
    const product = await makeProduct('P2-ADJ-BATCH', { batchTracking: true });
    await asOrg(() => stock.receiveForDocument(
      { productId: product.id, locationId: org.mainLocationId, quantity: 5, unitCost: 6, batchNumber: 'P2-LOT' } as any,
      { sourceType: 'p2_seed', sourceId: 'p2-lot', date: new Date() },
    ));
    const glBefore = await stockGl();
    const adj = await asOrg(() => docs.createAdjustment({
      locationId: org.mainLocationId, reason: 'found', responsibleById: staffId, approvedById: staffId,
      items: [{ productId: product.id, qtyActual: 8 }],
    } as any));
    await asOrg(() => docs.approveAdjustment(adj.id));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(8);

    await asOrg(() => reversals.reverseDocument('stock_adjustment', adj.id, 'double counted'));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(5);
    const lots = await prisma.inventoryBatch.aggregate({
      where: { organizationId: org.organizationId, productId: product.id, locationId: org.mainLocationId },
      _sum: { quantity: true },
    });
    expect(Number(lots._sum.quantity)).toBe(5);
    expect(await stockGl()).toBe(glBefore);
  }, 120_000);

  it('INV-010: transfer reversal moves stock back', async () => {
    const product = await makeProduct('P2-TRF');
    await asOrg(() => direct.directIn({
      locationId: org.mainLocationId, responsibleById: staffId, approvedById: staffId,
      items: [{ productId: product.id, quantity: 9, unitCost: 10 }],
    } as any));
    const trf = await asOrg(() => docs.createTransfer({
      fromLocationId: org.mainLocationId, toLocationId: org.altLocationId,
      responsibleById: staffId, approvedById: staffId,
      items: [{ productId: product.id, qtyRequested: 4 }],
    } as any));
    await asOrg(() => docs.approveTransfer(trf.id));
    await asOrg(() => reversals.reverseDocument('stock_transfer', trf.id, 'wrong branch'));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(9);
    expect(await onHand(prisma, org.organizationId, product.id, org.altLocationId)).toBe(0);
  }, 120_000);

  it('INV-010: GRN reversal returns stock, rolls the PO back and nets GL + AP to zero', async () => {
    const product = await makeProduct('P2-GRN');
    const glBefore = await stockGl();
    const order: any = await asOrg(() => pos.create({
      partnerId: supplierId, warehouseId: org.mainLocationId, paymentType: 'credit', currencyCode: 'UGX',
      lines: [{ productId: product.id, description: 'P2', quantity: 10, unitPrice: 12, taxRate: 0 }],
    } as any));
    const draft = await asOrg(() => grns.createDraft({
      purchaseOrderId: order.id, warehouseId: org.mainLocationId,
      lines: [{ purchaseOrderLineId: order.lines[0].id, productId: product.id, description: 'P2', quantity: 6, unitCost: 12 } as any],
    }));
    await asOrg(() => grns.post(draft.id));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(6);

    const reversed: any = await asOrg(() => grns.reverse(draft.id, 'supplier delivered to wrong site'));
    expect(reversed.status).toBe('reversed');
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(0);
    expect(await stockGl()).toBe(glBefore);
    const poAfter = await prisma.purchaseOrder.findFirst({ where: { id: order.id }, include: { lines: true } });
    expect(Number(poAfter!.lines[0].receivedQuantity)).toBe(0);
    expect(poAfter!.status).toBe('active');
    const ap = await prisma.journalLine.findMany({
      where: { accountId: org.accounts.accounts_payable, entry: { organizationId: org.organizationId, sourceId: draft.id } },
      select: { debit: true, credit: true },
    });
    expect(ap.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)).toBe(0);
  }, 120_000);

  it('INV-011: GL tie-out has zero variance and no unposted movements after document flows', async () => {
    const tie: any = await asOrg(() => valuation.glTieOut());
    expect(tie.unpostedMovements.filter((u: any) => u.source !== 'p2_seed')).toEqual([]);
    expect(Math.abs(tie.variance)).toBeLessThanOrEqual(0.01);
    expect(tie.withinTolerance).toBe(true);

    const current: any = await asOrg(() => valuation.valuation());
    const past: any = await asOrg(() => valuation.valuation(new Date(Date.now() - 365 * 86_400_000).toISOString()));
    expect(current.basis).toBe('current_cost_by_method');
    expect(Number(current.summary.totalValue)).toBeCloseTo(tie.subledgerValue, 2);
    expect(past.basis).toBe('ledger');
    expect(past.items).toEqual([]);
  }, 120_000);

  it('INV-013: the stock ledger refuses UPDATE, DELETE and broken arithmetic', async () => {
    const row = await prisma.inventoryLedger.findFirst({ where: { organizationId: org.organizationId } });
    await expect(prisma.inventoryLedger.update({ where: { id: row!.id }, data: { notes: 'tamper' } })).rejects.toThrow(/posted stock evidence/);
    await expect(prisma.inventoryLedger.delete({ where: { id: row!.id } })).rejects.toThrow(/posted stock evidence/);
    await expect(
      prisma.inventoryLedger.create({
        data: {
          organizationId: org.organizationId, ledgerCode: 'BAD', productId: row!.productId, locationId: row!.locationId,
          type: 'receipt', qtyBefore: 0, quantityChange: 5, balanceAfter: 7, unitCost: 1, totalValue: 5,
        },
      }),
    ).rejects.toThrow(/balance_arithmetic_check/);
  }, 120_000);
});
