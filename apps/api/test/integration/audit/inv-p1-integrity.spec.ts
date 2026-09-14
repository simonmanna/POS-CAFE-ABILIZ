/**
 * Inventory Phase 1 remediation (2026-09-14 audit): batch/serial integrity and
 * receiving controls.
 *
 *   N1   Adjustments on batch-tracked items move the lots (Σ batches == on-hand).
 *   N2   Batch transfers carry lot cost/expiry/receipt date; value = lot value.
 *   N3   Posting a draft GRN honours the goods_receipt approval policy.
 *   N4   Approving an adjustment over stock that moved since creation is refused.
 *   N5   Starting a count resumes a draft that already has counts.
 *   INV-012  PO-linked receipt lines must bind to exactly one PO line.
 *   INV-008  Attribution ids must be active users of the org.
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
import { InventoryCountService } from '../../../src/modules/inventory/inventory-count.service';
import { GoodsReceiptsService } from '../../../src/modules/procurement/goods-receipts.service';
import { PurchaseOrdersService } from '../../../src/modules/procurement/purchase-orders.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, AuditOrg } from './_harness';

describeDb('INV P1 integrity', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let docs: StockDocService;
  let counts: InventoryCountService;
  let grns: GoodsReceiptsService;
  let pos: PurchaseOrdersService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let staffId = '';
  let supplierId = '';

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run(
      { organizationId: org.organizationId, userId: staffId, permissions: ['goods_receipt:create', 'goods_receipt:post'] },
      fn,
    );

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'P1');
    staffId = (
      await prisma.user.create({
        data: { organizationId: org.organizationId, email: `p1-${Date.now()}@test.local`, passwordHash: 'x', firstName: 'P1' },
      })
    ).id;
    supplierId = (
      await prisma.partner.create({
        data: { organizationId: org.organizationId, code: 'P1-SUP', name: 'P1 Supplier', isSupplier: true },
      })
    ).id;
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    docs = moduleRef.get(StockDocService);
    counts = moduleRef.get(InventoryCountService);
    grns = moduleRef.get(GoodsReceiptsService);
    pos = moduleRef.get(PurchaseOrdersService);
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

  const receive = (productId: string, qty: number, unitCost: number, extra: Record<string, unknown> = {}) =>
    asOrg(() =>
      stock.receiveForDocument(
        { productId, locationId: org.mainLocationId, quantity: qty, unitCost, ...extra } as any,
        { sourceType: 'p1_seed', sourceId: `seed-${productId}-${Math.random()}`, date: new Date() },
      ),
    );

  const batchSum = async (productId: string, locationId: string) => {
    const agg = await prisma.inventoryBatch.aggregate({
      where: { organizationId: org.organizationId, productId, locationId },
      _sum: { quantity: true },
    });
    return Number(agg._sum.quantity ?? 0);
  };

  it('N1: adjustment loss and gain on a batch item keep Σ batches == on-hand', async () => {
    const product = await makeProduct('P1-BATCH-ADJ', { batchTracking: true });
    await receive(product.id, 10, 5, { batchNumber: 'LOT-A' });
    await receive(product.id, 10, 7, { batchNumber: 'LOT-B' });

    await asOrg(() => stock.adjust({ productId: product.id, locationId: org.mainLocationId, countedQuantity: 14 }));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(14);
    expect(await batchSum(product.id, org.mainLocationId)).toBe(14);

    await asOrg(() => stock.adjust({ productId: product.id, locationId: org.mainLocationId, countedQuantity: 17 }));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(17);
    expect(await batchSum(product.id, org.mainLocationId)).toBe(17);
  }, 120_000);

  it('N2: batch transfer carries lot cost, expiry and receipt date', async () => {
    const product = await makeProduct('P1-BATCH-TRF', { batchTracking: true });
    const expiry = new Date(Date.now() + 30 * 86_400_000);
    await receive(product.id, 5, 4, { batchNumber: 'LOT-OLD', expiryDate: expiry.toISOString() });
    await receive(product.id, 5, 8, { batchNumber: 'LOT-NEW' });

    await asOrg(() =>
      stock.transfer({ productId: product.id, fromLocationId: org.mainLocationId, toLocationId: org.altLocationId, quantity: 6 }),
    );

    const out = await prisma.inventoryLedger.findFirst({
      where: { organizationId: org.organizationId, productId: product.id, type: 'transfer_out' },
    });
    // 5 × 4 (LOT-OLD) + 1 × 8 (LOT-NEW) = 28
    expect(Number(out!.totalValue)).toBe(28);
    expect(await batchSum(product.id, org.mainLocationId)).toBe(4);
    expect(await batchSum(product.id, org.altLocationId)).toBe(6);
    const destOld = await prisma.inventoryBatch.findFirst({
      where: { organizationId: org.organizationId, productId: product.id, locationId: org.altLocationId, batchNumber: 'LOT-OLD' },
    });
    const srcOld = await prisma.inventoryBatch.findFirst({
      where: { organizationId: org.organizationId, productId: product.id, locationId: org.mainLocationId, batchNumber: 'LOT-OLD' },
    });
    expect(destOld!.expiryDate?.toISOString()).toBe(expiry.toISOString());
    expect(destOld!.receivedAt.toISOString()).toBe(srcOld!.receivedAt.toISOString());
  }, 120_000);

  it('N4: approving an adjustment after stock moved is refused unless forced with a reason', async () => {
    const product = await makeProduct('P1-DRIFT');
    await receive(product.id, 20, 10);
    const adj = await asOrg(() =>
      docs.createAdjustment({
        locationId: org.mainLocationId, reason: 'cycle_count',
        responsibleById: staffId, approvedById: staffId,
        items: [{ productId: product.id, qtyActual: 18 }],
      } as any),
    );
    // A sale lands between creation and approval.
    await asOrg(() => stock.issue({ productId: product.id, locationId: org.mainLocationId, quantity: 3 }));

    await expect(asOrg(() => docs.approveAdjustment(adj.id))).rejects.toThrow(/Stock moved/);
    await expect(asOrg(() => docs.approveAdjustment(adj.id, undefined, { force: true }))).rejects.toThrow(/reason is required/);
    const done = await asOrg(() => docs.approveAdjustment(adj.id, undefined, { force: true, forceReason: 'recounted shelf' }));
    expect(done.status).toBe('completed');
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(18);
  }, 120_000);

  it('N3: a draft GRN cannot be posted past an active goods_receipt approval policy', async () => {
    const wf = await prisma.approvalWorkflow.create({
      data: {
        organizationId: org.organizationId, name: 'GRN approval', entityType: 'goods_receipt',
        steps: { create: [{ organizationId: org.organizationId, stepOrder: 1, name: 'Manager', approverPermissions: ['goods_receipt:approve'] }] },
      },
    });
    try {
      const product = await makeProduct('P1-GRN-GATE');
      const draft = await asOrg(() =>
        grns.createDraft({ warehouseId: org.mainLocationId, lines: [{ productId: product.id, description: 'x', quantity: 3, unitCost: 10 }] }),
      );
      await expect(asOrg(() => grns.post(draft.id))).rejects.toThrow(/requires approval/);
      expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(0);

      // Ad-hoc with a policy lands as a draft, not posted.
      const adhoc = await asOrg(() =>
        grns.createAdhoc({ warehouseId: org.mainLocationId, lines: [{ productId: product.id, description: 'x', quantity: 2, unitCost: 10 }] }),
      );
      expect(adhoc.status).toBe('draft');
    } finally {
      await prisma.approvalWorkflow.update({ where: { id: wf.id }, data: { isActive: false } });
    }
  }, 120_000);

  it('N3: ad-hoc GRN without goods_receipt:post only creates a draft', async () => {
    const product = await makeProduct('P1-GRN-CLERK');
    const draft = await tenant.run(
      { organizationId: org.organizationId, userId: staffId, permissions: ['goods_receipt:create'] },
      () => grns.createAdhoc({ warehouseId: org.mainLocationId, lines: [{ productId: product.id, description: 'x', quantity: 2, unitCost: 10 }] }),
    );
    expect(draft.status).toBe('draft');
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(0);
  }, 120_000);

  it('INV-012: a PO receipt line for a product not on the PO is refused', async () => {
    const onPo = await makeProduct('P1-PO-ON');
    const offPo = await makeProduct('P1-PO-OFF');
    const order = await asOrg(() =>
      pos.create({
        partnerId: supplierId, warehouseId: org.mainLocationId, paymentType: 'credit', currencyCode: 'UGX',
        lines: [{ productId: onPo.id, description: 'On PO', quantity: 10, unitPrice: 10, taxRate: 0 }],
      } as any),
    );
    await expect(
      asOrg(() =>
        pos.receive(order.id, {
          warehouseId: org.mainLocationId,
          lines: [
            { productId: onPo.id, description: 'On PO', quantity: 5, unitCost: 10 },
            { productId: offPo.id, description: 'Off PO', quantity: 5, unitCost: 10 },
          ],
        } as any),
      ),
    ).rejects.toThrow(/not on PO/);
    expect(await onHand(prisma, org.organizationId, offPo.id, org.mainLocationId)).toBe(0);
  }, 120_000);

  it('INV-008: attribution to an unknown user is refused', async () => {
    const product = await makeProduct('P1-ATTR');
    await expect(
      asOrg(() =>
        docs.createStockOut({
          locationId: org.mainLocationId, responsibleById: 'not-a-user', approvedById: staffId,
          items: [{ productId: product.id, qty: 1 }],
        } as any),
      ),
    ).rejects.toThrow(/active user/);
  }, 120_000);

  it('N5: starting a count resumes a draft that already has counts', async () => {
    const product = await makeProduct('P1-COUNT');
    await receive(product.id, 4, 10);
    const first: any = await asOrg(() => counts.start({ locationId: org.mainLocationId, countType: 'closing' } as any));
    const line = first.lines.find((l: any) => l.productId === product.id);
    await asOrg(() => counts.saveDraft(first.id, { lines: [{ lineId: line.id, countedQty: 4 }] } as any));

    const again: any = await asOrg(() => counts.start({ locationId: org.mainLocationId, countType: 'closing' } as any));
    expect(again.id).toBe(first.id);

    const fresh: any = await asOrg(() => counts.start({ locationId: org.mainLocationId, countType: 'closing', restart: true } as any));
    expect(fresh.id).not.toBe(first.id);
  }, 120_000);
});
