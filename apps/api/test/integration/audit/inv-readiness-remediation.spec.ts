/**
 * Inventory production-readiness remediation (2026-09-14 external audit, 61/100).
 *
 *   P0-1  Refund restock uses the persisted BASE quantity (sales UOM + recipe UOM).
 *   P0-2  Concurrent full-balance credit PO payments: exactly one succeeds.
 *   P0-3  Concurrent direct stock-outs of the last unit: exactly one succeeds.
 *   P1-1  FIFO valuation values remaining lots, not quant × running average.
 *   P1-2  Direct-stock approver attribution needs proof (permission / PIN).
 *   P1-3  PO receive honours the goods_receipt approval policy.
 *   P1-6  A serial already on record cannot be received again.
 */
jest.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET',
  generateURI: () => 'otpauth://stub',
  verifySync: () => true,
  authenticator: { generateSecret: () => 'TESTSECRET', keyuri: () => 'otpauth://stub', verify: () => true, check: () => true },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { describeDb } from '../_setup';
import { KernelModule } from '../../../src/kernel/kernel.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { CoreModule } from '../../../src/modules/core/core.module';
import { InventoryModule } from '../../../src/modules/inventory/inventory.module';
import { PosModule } from '../../../src/modules/pos/pos.module';
import { AccountingModule } from '../../../src/modules/accounting/accounting.module';
import { ProcurementModule } from '../../../src/modules/procurement/procurement.module';
import { InvoicingModule } from '../../../src/modules/invoicing/invoicing.module';
import { PosInvoiceService } from '../../../src/modules/pos/billing/pos-invoice.service';
import { PosOrdersService } from '../../../src/modules/pos/order/pos-orders.service';
import { StockService } from '../../../src/modules/inventory/stock.service';
import { DirectStockService } from '../../../src/modules/inventory/direct-stock.service';
import { PurchaseOrdersService } from '../../../src/modules/procurement/purchase-orders.service';
import { InventoryCountService } from '../../../src/modules/inventory/inventory-count.service';
import { InventoryValuationReportService } from '../../../src/modules/accounting/reporting/inventory-valuation.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, accountBalance, AuditOrg } from './_harness';

// Below the Prisma pool size (losers hold a connection while waiting on the lock).
const CONCURRENCY = 5;

describeDb('INV readiness remediation (2026-09-14)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let billing: PosInvoiceService;
  let orders: PosOrdersService;
  let stock: StockService;
  let direct: DirectStockService;
  let purchaseOrders: PurchaseOrdersService;
  let valuation: InventoryValuationReportService;
  let counts: InventoryCountService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let staffId = '';
  let approverId = '';
  let supplierId = '';

  const asOrg = <T>(fn: () => Promise<T>, permissions: string[] = ['inventory_doc:approve']): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: staffId, permissions }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'RDY');
    staffId = (await prisma.user.create({
      data: { organizationId: org.organizationId, email: `rdy-staff-${Date.now()}@test.local`, passwordHash: 'x', firstName: 'Staff' },
    })).id;
    const approverRole = await prisma.role.create({
      data: { organizationId: org.organizationId, name: 'Stock approver', permissions: ['inventory_doc:approve'] },
    });
    approverId = (await prisma.user.create({
      data: {
        organizationId: org.organizationId, email: `rdy-approver-${Date.now()}@test.local`, passwordHash: 'x', firstName: 'Approver',
        pinHash: await bcrypt.hash('4321', 4), roles: { connect: { id: approverRole.id } },
      } as any,
    })).id;
    supplierId = (await prisma.partner.create({
      data: { organizationId: org.organizationId, code: `RDY-SUP-${Date.now()}`, name: 'Readiness Supplier', isSupplier: true } as any,
    })).id;
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, PosModule, AccountingModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    billing = moduleRef.get(PosInvoiceService);
    orders = moduleRef.get(PosOrdersService);
    stock = moduleRef.get(StockService);
    direct = moduleRef.get(DirectStockService);
    purchaseOrders = moduleRef.get(PurchaseOrdersService);
    valuation = moduleRef.get(InventoryValuationReportService);
    counts = moduleRef.get(InventoryCountService);
    tenant = moduleRef.get(TenantContextService);
    // The manager PIN/approval flow is covered by the POS override suites; here
    // the refund's stock + GL restoration is under test.
    (billing as any).overrides = { verifyOperationApproval: async () => undefined };
  }, 300_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 180_000);

  const uomPair = async (tag: string, base: { name: string; factor: number }, other: { name: string; factor: number }) => {
    const cat = await prisma.uomCategory.create({ data: { organizationId: org.organizationId, name: `RDY-${tag}-${Date.now()}` } as any });
    const baseUom = await prisma.unitOfMeasure.create({
      data: { organizationId: org.organizationId, categoryId: cat.id, code: `RDY-${tag}-B-${Date.now()}`, name: base.name, factor: base.factor } as any,
    });
    const otherUom = await prisma.unitOfMeasure.create({
      data: { organizationId: org.organizationId, categoryId: cat.id, code: `RDY-${tag}-O-${Date.now()}`, name: other.name, factor: other.factor } as any,
    });
    await prisma.uomCategory.update({ where: { id: cat.id }, data: { referenceUomId: baseUom.id } as any });
    return { baseUom, otherUom };
  };

  const seed = (productId: string, qty: number, unitCost: number) =>
    asOrg(() => stock.receiveForDocument(
      { productId, locationId: org.mainLocationId, quantity: qty, unitCost } as any,
      { sourceType: 'audit_seed', sourceId: `seed-${productId}-${Date.now()}`, date: new Date() },
    ));

  const drainJobs = async (invoiceId: string) => {
    const jobs = await prisma.stockPostingJob.findMany({ where: { organizationId: org.organizationId, invoiceId } });
    for (const j of jobs) await asOrg(() => billing.processStockPostingJob(j.id));
  };

  const stockValuation = () => accountBalance(prisma, org.organizationId, org.accounts.stock_valuation);

  it('P0-1: a case-of-12 sale restocks 12 pieces per case on full and partial refunds', async () => {
    const { baseUom, otherUom } = await uomPair('CASE', { name: 'Piece', factor: 1 }, { name: 'Case of 12', factor: 12 });
    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-SODA-${Date.now()}`, name: 'Soda',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 10, salesPrice: 150,
        uomId: baseUom.id, salesUomId: otherUom.id,
      } as any,
    });
    await seed(product.id, 60, 10);
    const svBefore = await stockValuation();

    const order = await asOrg(() => orders.createOrder({
      orderType: 'takeaway', guestCount: 1,
      lines: [{ productId: product.id, description: 'Soda case', quantity: 2, unitPrice: 150 }],
    } as any));
    const invoice = await asOrg(() => billing.generateInvoice(order.id, {} as any));
    await drainJobs(invoice.id);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(36);

    const snap = await prisma.invoiceItemRecipeIngredient.findFirstOrThrow({ where: { organizationId: org.organizationId, invoiceId: invoice.id } });
    expect(Number(snap.baseQuantity)).toBe(24);
    expect(Number(snap.quantity)).toBe(24);

    const line = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    // Partial: 1 of 2 cases.
    await asOrg(() => billing.refund(invoice.id, 'one case returned', { overrideById: staffId, stockDisposition: 'restock', lines: [{ lineId: line.id, quantity: 1 }] }));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(48);
    // Remainder.
    await asOrg(() => billing.refund(invoice.id, 'second case returned', { overrideById: staffId, stockDisposition: 'restock' }));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(60);
    expect(await stockValuation()).toBeCloseTo(svBefore, 2);
  }, 300_000);

  it('P0-1: an 18 g recipe ingredient stocked in kg restocks 0.018 kg per item, not 18 kg', async () => {
    const { baseUom, otherUom } = await uomPair('MASS', { name: 'Kilogram', factor: 1 }, { name: 'Gram', factor: 0.001 });
    const beans = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-BEANS-${Date.now()}`, name: 'Coffee beans',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 50000, salesPrice: 0,
        uomId: baseUom.id,
      } as any,
    });
    await seed(beans.id, 5, 50000);
    const svBefore = await stockValuation();
    const espresso = await prisma.menuItem.create({
      data: { organizationId: org.organizationId, name: `RDY Espresso ${Date.now()}`, isInventoryTracked: true, basePrice: 500000 } as any,
    });
    await prisma.menuProduct.create({
      data: { organizationId: org.organizationId, menuItemId: espresso.id, productId: beans.id, quantity: 18, uomId: otherUom.id } as any,
    });

    const order = await asOrg(() => orders.createOrder({
      orderType: 'takeaway', guestCount: 1,
      lines: [{ menuItemId: espresso.id, description: 'Espresso', quantity: 10, unitPrice: 5000 }],
    } as any));
    const invoice = await asOrg(() => billing.generateInvoice(order.id, {} as any));
    await drainJobs(invoice.id);
    expect(await onHand(prisma, org.organizationId, beans.id, org.mainLocationId)).toBeCloseTo(4.82, 6);

    const line = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    await asOrg(() => billing.refund(invoice.id, 'three returned', { overrideById: staffId, stockDisposition: 'restock', lines: [{ lineId: line.id, quantity: 3 }] }));
    expect(await onHand(prisma, org.organizationId, beans.id, org.mainLocationId)).toBeCloseTo(4.874, 6);
    await asOrg(() => billing.refund(invoice.id, 'rest returned', { overrideById: staffId, stockDisposition: 'restock' }));
    expect(await onHand(prisma, org.organizationId, beans.id, org.mainLocationId)).toBeCloseTo(5, 6);
    expect(await stockValuation()).toBeCloseTo(svBefore, 2);
  }, 300_000);

  it('P0-2: concurrent full-balance payments on one credit PO — exactly one succeeds', async () => {
    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: org.organizationId, orderNumber: `RDY-PO-${Date.now()}`, partnerId: supplierId,
        paymentType: 'credit', status: 'received', totalAmount: 100, totalPaid: 0,
      } as any,
    });
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => asOrg(() => purchaseOrders.pay(po.id, { method: 'bank' } as any))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const payments = await prisma.purchasePayment.findMany({ where: { purchaseOrderId: po.id } });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount)).toBe(100);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(Number(after.totalPaid)).toBe(100);
    expect(after.paymentStatus).toBe('paid');
    const journals = await prisma.journalEntry.count({ where: { organizationId: org.organizationId, sourceType: 'purchase_order', sourceId: po.id } });
    expect(journals).toBe(1);
  }, 300_000);

  it('P0-2: the database refuses a payment row that overpays a credit PO', async () => {
    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId: org.organizationId, orderNumber: `RDY-PO-DB-${Date.now()}`, partnerId: supplierId,
        paymentType: 'credit', status: 'received', totalAmount: 100, totalPaid: 0,
      } as any,
    });
    await prisma.purchasePayment.create({ data: { organizationId: org.organizationId, purchaseOrderId: po.id, amount: 60 } });
    await expect(
      prisma.purchasePayment.create({ data: { organizationId: org.organizationId, purchaseOrderId: po.id, amount: 60 } }),
    ).rejects.toThrow(/exceeds purchase order total/);
  }, 120_000);

  it('P0-3: concurrent direct stock-outs of the last unit — exactly one succeeds, never negative', async () => {
    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-LAST-${Date.now()}`, name: 'Last unit',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 10, salesPrice: 0,
      } as any,
    });
    await seed(product.id, 1, 10);
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => asOrg(() => direct.directOut({
        locationId: org.mainLocationId, responsibleById: staffId, approvedById: staffId,
        items: [{ productId: product.id, quantity: 1 }],
      } as any))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(0);
  }, 300_000);

  it('P1-2: a named approver must prove the approval; self-approval needs the permission', async () => {
    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-APPR-${Date.now()}`, name: 'Approval item',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 10, salesPrice: 0,
      } as any,
    });
    const dto = (extra: Record<string, unknown>) => ({
      locationId: org.mainLocationId, responsibleById: staffId,
      items: [{ productId: product.id, quantity: 1, unitCost: 10 }], ...extra,
    }) as any;

    await expect(asOrg(() => direct.directIn(dto({ approvedById: approverId })))).rejects.toThrow(/PIN is required/);
    await expect(asOrg(() => direct.directIn(dto({ approvedById: approverId, approverPin: '0000' })))).rejects.toThrow(/Invalid approver credentials/);
    await expect(asOrg(() => direct.directIn(dto({ approvedById: staffId })), [])).rejects.toThrow(/Self-approval/);
    await asOrg(() => direct.directIn(dto({ approvedById: approverId, approverPin: '4321' })));
    await asOrg(() => direct.directIn(dto({ approvedById: staffId })));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(2);
  }, 120_000);

  it('P1-6: receiving a serial that is already on record is refused', async () => {
    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-SER-${Date.now()}`, name: 'Serial item',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 100, salesPrice: 0, serialTracking: true,
      } as any,
    });
    const receipt = () => asOrg(() => stock.receiveForDocument(
      { productId: product.id, locationId: org.mainLocationId, quantity: 1, unitCost: 100, serialNumbers: ['RDY-SN-1'] } as any,
      { sourceType: 'audit_seed', sourceId: `ser-${Date.now()}-${Math.random()}`, date: new Date() },
    ));
    await receipt();
    await expect(receipt()).rejects.toThrow(/already exist/);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(1);
  }, 120_000);

  it('P1-1: FIFO valuation is the remaining lot cost, not quant × running average', async () => {
    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-FIFO-${Date.now()}`, name: 'FIFO item',
        productType: 'stockable', trackInventory: true, costingMethod: 'FIFO', batchTracking: true,
        pickingStrategy: 'FIFO', costPrice: 5, salesPrice: 0,
      } as any,
    });
    for (const [batchNumber, unitCost] of [['RDY-LOT-A', 5], ['RDY-LOT-B', 9]] as const) {
      await asOrg(() => stock.receiveForDocument(
        { productId: product.id, locationId: org.mainLocationId, quantity: 10, unitCost, batchNumber } as any,
        { sourceType: 'audit_seed', sourceId: `fifo-${batchNumber}`, date: new Date() },
      ));
    }
    await asOrg(() => stock.issue({ productId: product.id, locationId: org.mainLocationId, quantity: 12, distStrategy: 'FIFO', sourceType: 'audit_issue', sourceId: 'fifo-issue' } as any));
    const report = await asOrg(() => valuation.valuation());
    const item = report.items.find((i) => i.productId === product.id)!;
    expect(item.onHandQty).toBe(8);
    expect(Number(item.totalValue)).toBeCloseTo(72, 6); // 8 remaining of lot B @ 9
  }, 120_000);

  it('P1-3: PO receive under a goods_receipt approval policy only drafts the GRN', async () => {
    const wf = await prisma.approvalWorkflow.create({
      data: {
        organizationId: org.organizationId, name: 'GRN approval', entityType: 'goods_receipt',
        steps: { create: [{ organizationId: org.organizationId, stepOrder: 1, name: 'Manager', approverPermissions: ['goods_receipt:approve'] }] },
      } as any,
    });
    try {
      const product = await prisma.product.create({
        data: {
          organizationId: org.organizationId, code: `RDY-GRN-${Date.now()}`, name: 'Gated receipt',
          productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 10, salesPrice: 0,
        } as any,
      });
      const po = await prisma.purchaseOrder.create({
        data: {
          organizationId: org.organizationId, orderNumber: `RDY-PO-GRN-${Date.now()}`, partnerId: supplierId,
          paymentType: 'credit', status: 'active', totalAmount: 50,
          lines: { create: [{ organizationId: org.organizationId, productId: product.id, description: 'x', quantity: 5, unitPrice: 10, subtotal: 50, lineNumber: 1 }] },
        } as any,
        include: { lines: true },
      });
      const res: any = await asOrg(() => purchaseOrders.receive(po.id, {
        warehouseId: org.mainLocationId,
        lines: [{ purchaseOrderLineId: (po as any).lines[0].id, productId: product.id, description: 'x', quantity: 5 }],
      } as any));
      expect(res.approvalRequired).toBe(true);
      expect(res.grn.status).toBe('draft');
      expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(0);
      const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
      expect(after.status).toBe('active');
      expect(Number(after.lines[0].receivedQuantity)).toBe(0);
    } finally {
      await prisma.approvalRequest.deleteMany({ where: { organizationId: org.organizationId, workflowId: wf.id } }).catch(() => undefined);
      await prisma.approvalWorkflow.update({ where: { id: wf.id }, data: { isActive: false } as any }).catch(() => undefined);
    }
  }, 120_000);

  it('P2: concurrent submits of one count post a single adjustment', async () => {
    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `RDY-CNT-${Date.now()}`, name: 'Counted item',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 10, salesPrice: 0,
      } as any,
    });
    await seed(product.id, 10, 10);
    const session: any = await asOrg(() => counts.start({ locationId: org.mainLocationId, restart: true } as any));
    const line = session.lines.find((l: any) => l.productId === product.id);
    await asOrg(() => counts.saveDraft(session.id, { lines: [{ lineId: line.id, countedQty: 7, reason: 'breakage' }] } as any));
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => asOrg(() => counts.submit(session.id, { force: true, forceReason: 'test' } as any))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(7);
  }, 180_000);
});
