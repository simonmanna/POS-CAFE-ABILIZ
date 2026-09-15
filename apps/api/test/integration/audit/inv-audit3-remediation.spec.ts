/**
 * Inventory production-readiness audit #3 remediation (2026-09-14, 76/100).
 *
 *   P1-02  skip_expired never drifts StockItem away from Σ lots.
 *   P1-03  serial enforcement runs on BASE quantity; fractional serial moves fail.
 *   P1-04  transit transfers: dispatch → partial receipt / damage / shortage →
 *          recall / reversal, with quant, ledger and GL conservation.
 *   P2-02  landed cost capitalises the on-hand share and expenses the consumed share.
 *   P2-03  blind / spot / cycle count sessions.
 *   P2-04  stock-health report (aging, turnover, slow / dead stock).
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
import { AccountingModule } from '../../../src/modules/accounting/accounting.module';
import { ProcurementModule } from '../../../src/modules/procurement/procurement.module';
import { InvoicingModule } from '../../../src/modules/invoicing/invoicing.module';
import { StockService } from '../../../src/modules/inventory/stock.service';
import { StockDocService } from '../../../src/modules/inventory/stock-doc.service';
import { StockReversalService } from '../../../src/modules/inventory/stock-reversal.service';
import { InventoryCountService } from '../../../src/modules/inventory/inventory-count.service';
import { InventoryReportsService } from '../../../src/modules/inventory/inventory-reports.service';
import { LandedCostService } from '../../../src/modules/procurement/landed-cost.service';
import { GoodsReceiptsService } from '../../../src/modules/procurement/goods-receipts.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, ledgerSum, accountBalance, AuditOrg } from './_harness';
import { purge } from '../_purge';

describeDb('INV audit #3 remediation (2026-09-14)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let docs: StockDocService;
  let reversals: StockReversalService;
  let counts: InventoryCountService;
  let reports: InventoryReportsService;
  let landed: LandedCostService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let staffId = '';
  let seq = 0;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: staffId, permissions: ['inventory_doc:approve', 'inventory_count:submit'] }, fn);
  const uid = () => `${Date.now()}-${++seq}`;

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'A3');
    staffId = (await prisma.user.create({
      data: { organizationId: org.organizationId, email: `a3-staff-${uid()}@test.local`, passwordHash: 'x', firstName: 'Staff' },
    })).id;
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, AccountingModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    docs = moduleRef.get(StockDocService);
    reversals = moduleRef.get(StockReversalService);
    counts = moduleRef.get(InventoryCountService);
    reports = moduleRef.get(InventoryReportsService);
    landed = moduleRef.get(LandedCostService);
    tenant = moduleRef.get(TenantContextService);
  }, 300_000);

  afterAll(async () => {
    const p = prisma as any;
    for (const t of ['landedCostAllocation', 'landedCostCharge', 'landedCost', 'stockTransferReceipt']) {
      await purge(p, (tx) => tx[t].deleteMany({ where: { organizationId: org?.organizationId } })).catch(() => undefined);
    }
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 180_000);

  const product = (tag: string, extra: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `A3-${tag}-${uid()}`, name: `A3 ${tag}`,
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: 100, salesPrice: 200, ...extra,
      } as any,
    });
  const setting = (productId: string, key: string, value: unknown) =>
    prisma.setting.create({ data: { organizationId: org.organizationId, scopeType: 'product', scopeId: productId, key, value: value as any } });
  const receive = (productId: string, qty: number, unitCost: number, extra: Record<string, unknown> = {}, locationId = org.mainLocationId) =>
    asOrg(() => stock.receiveForDocument(
      { productId, locationId, quantity: qty, unitCost, ...extra } as any,
      { sourceType: 'audit_seed', sourceId: `seed-${uid()}`, date: new Date() },
    ));
  const lotSum = async (productId: string, locationId = org.mainLocationId) =>
    Number((await prisma.inventoryBatch.aggregate({ where: { organizationId: org.organizationId, productId, locationId, isActive: true }, _sum: { quantity: true } }))._sum.quantity ?? 0);
  const uomPair = async (tag: string) => {
    const cat = await prisma.uomCategory.create({ data: { organizationId: org.organizationId, name: `A3-${tag}-${uid()}` } as any });
    const piece = await prisma.unitOfMeasure.create({ data: { organizationId: org.organizationId, categoryId: cat.id, code: `A3-${tag}-P-${uid()}`, name: 'Piece', factor: 1 } as any });
    const box = await prisma.unitOfMeasure.create({ data: { organizationId: org.organizationId, categoryId: cat.id, code: `A3-${tag}-C-${uid()}`, name: 'Case of 12', factor: 12 } as any });
    await prisma.uomCategory.update({ where: { id: cat.id }, data: { referenceUomId: piece.id } as any });
    return { piece, box };
  };
  const balance = (key: string) => accountBalance(prisma, org.organizationId, org.accounts[key]);

  // ---------------------------------------------------------------------------
  // P1-02
  // ---------------------------------------------------------------------------

  describe('P1-02 skip_expired keeps quant = Σ lots', () => {
    const expiredBatchProduct = async (tag: string, extra: Record<string, unknown> = {}) => {
      const p = await product(tag, { batchTracking: true, costingMethod: 'FIFO', ...extra });
      await setting(p.id, 'inventory.expiredStockPolicy', 'skip_expired');
      await receive(p.id, 5, 40, { batchNumber: `EXP-${uid()}`, expiryDate: new Date(Date.now() - 3 * 86_400_000).toISOString() });
      return p;
    };

    it('permissive (default): consumes the expired lot, conserves lots and raises an exception', async () => {
      const p = await expiredBatchProduct('EXP-PERM');
      await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 1, sourceType: 'audit', sourceId: uid() } as any));
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(4);
      expect(await lotSum(p.id)).toBe(4);
      expect(await ledgerSum(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(4);
      const ex = await prisma.inventoryException.findFirst({ where: { organizationId: org.organizationId, productId: p.id, kind: 'expired_lot_consumed' } });
      expect(ex).not.toBeNull();
      expect(Number(ex!.quantity)).toBe(1);
    });

    it('prefers a valid lot over an expired one', async () => {
      const p = await expiredBatchProduct('EXP-MIX');
      await receive(p.id, 3, 50, { batchNumber: `OK-${uid()}`, expiryDate: new Date(Date.now() + 30 * 86_400_000).toISOString() });
      await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 2, sourceType: 'audit', sourceId: uid() } as any));
      const valid = await prisma.inventoryBatch.findFirstOrThrow({ where: { organizationId: org.organizationId, productId: p.id, batchNumber: { startsWith: 'OK-' } } });
      expect(Number(valid.quantity)).toBe(1);
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(6);
      expect(await lotSum(p.id)).toBe(6);
      expect(await prisma.inventoryException.count({ where: { organizationId: org.organizationId, productId: p.id } })).toBe(0);
    });

    it('strict (allowNegativeStock=false + block) and requireAvailable refuse without touching stock', async () => {
      const p = await expiredBatchProduct('EXP-STRICT', { stockPolicy: 'block' });
      await setting(p.id, 'inventory.allowNegativeStock', false);
      await expect(asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 1 } as any))).rejects.toThrow(/Insufficient stock/);
      const q = await product('EXP-REQ', { batchTracking: true, costingMethod: 'FIFO' });
      await setting(q.id, 'inventory.expiredStockPolicy', 'skip_expired');
      await receive(q.id, 5, 40, { batchNumber: `EXP-${uid()}`, expiryDate: new Date(Date.now() - 86_400_000).toISOString() });
      await expect(asOrg(() => stock.issue({ productId: q.id, locationId: org.mainLocationId, quantity: 1, requireAvailable: true } as any))).rejects.toThrow(/Insufficient stock/);
      for (const id of [p.id, q.id]) {
        expect(await onHand(prisma, org.organizationId, id, org.mainLocationId)).toBe(5);
        expect(await lotSum(id)).toBe(5);
      }
    });

    it('beyond all lots, the unlayered overflow is the only negative (quant = Σ lots − overflow)', async () => {
      const p = await expiredBatchProduct('EXP-NEG');
      await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 7, sourceType: 'audit', sourceId: uid() } as any));
      expect(await lotSum(p.id)).toBe(0);
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(-2);
      expect(await ledgerSum(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(-2);
    });
  });

  // ---------------------------------------------------------------------------
  // P1-03
  // ---------------------------------------------------------------------------

  describe('P1-03 serial enforcement on base quantity', () => {
    it('case of 12 needs 12 serials to receive and to sell, and restocks by serial', async () => {
      const { piece, box } = await uomPair('SER');
      const p = await product('SER-CASE', { serialTracking: true, uomId: piece.id, purchaseUomId: box.id });
      await setting(p.id, 'inventory.serialPolicy', 'required');
      const serials = Array.from({ length: 12 }, (_, i) => `A3SN-${uid()}-${i}`);

      await expect(receive(p.id, 1, 1200, { uomId: box.id, serialNumbers: [serials[0]] })).rejects.toThrow(/needs exactly 12 serial/);
      await receive(p.id, 1, 1200, { uomId: box.id, serialNumbers: serials });
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(12);
      expect(await prisma.inventorySerial.count({ where: { productId: p.id, status: 'in_stock' } })).toBe(12);

      await expect(
        asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 1, uomId: box.id, serialNumbers: [serials[0]] } as any)),
      ).rejects.toThrow(/needs 12 serial/);
      await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 1, uomId: box.id, serialNumbers: serials, sourceType: 'audit', sourceId: uid() } as any));
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(0);
      const rows = await prisma.inventoryLedger.findMany({ where: { organizationId: org.organizationId, productId: p.id, quantityChange: { lt: 0 } } });
      expect(rows).toHaveLength(12);
      expect(rows.every((r) => r.serialId)).toBe(true);

      await asOrg(() => stock.receiveReturn({ productId: p.id, locationId: org.mainLocationId, quantity: 12, serialNumbers: serials, sourceType: 'audit_return', sourceId: uid() }));
      expect(await prisma.inventorySerial.count({ where: { productId: p.id, status: 'in_stock' } })).toBe(12);
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(12);
    });

    it('fractional serialised quantities fail at the engine boundary (any policy)', async () => {
      const p = await product('SER-FRAC', { serialTracking: true });
      await receive(p.id, 2, 10, { serialNumbers: [`F-${uid()}`, `F-${uid()}`] });
      await expect(asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 0.5 } as any))).rejects.toThrow(/whole number/);
      await expect(receive(p.id, 1.5, 10)).rejects.toThrow(/whole number/);
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(2);
    });

    it('required policy never writes an un-serialised overflow row', async () => {
      const p = await product('SER-SHORT', { serialTracking: true });
      await setting(p.id, 'inventory.serialPolicy', 'required');
      const sn = `S-${uid()}`;
      await receive(p.id, 1, 10, { serialNumbers: [sn] });
      await expect(
        asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 2, serialNumbers: [sn, sn] } as any)),
      ).rejects.toThrow(/Duplicate serial/);
      expect(await prisma.inventoryLedger.count({ where: { productId: p.id, serialId: null, quantityChange: { lt: 0 } } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // P1-04
  // ---------------------------------------------------------------------------

  describe('P1-04 transit transfers', () => {
    const createTransit = async (productId: string, qty: number) => {
      const doc = await asOrg(() => docs.createTransfer({
        fromLocationId: org.mainLocationId, toLocationId: org.altLocationId, mode: 'transit',
        responsibleById: staffId, approvedById: staffId, items: [{ productId, qtyRequested: qty }],
      } as any));
      return doc;
    };
    const transitLocId = async () =>
      (await prisma.inventoryLocation.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'transit' } })).id;

    it('dispatch 20, receive 18, damaged 1, short 1 — then reverse every stage', async () => {
      const p = await product('TR-FULL');
      await receive(p.id, 50, 100);
      const svStart = await balance('stock_valuation');
      const doc = await createTransit(p.id, 20);

      await asOrg(() => docs.approveTransfer(doc.id));
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(50);
      await expect(asOrg(() => docs.receiveTransfer(doc.id, { lines: [{ itemId: doc.items[0].id, received: 1 }] }))).rejects.toThrow(/only in-transit/);

      const dispatched = await asOrg(() => docs.dispatchTransfer(doc.id));
      expect(dispatched!.status).toBe('in_transit');
      const transit = await transitLocId();
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(30);
      expect(await onHand(prisma, org.organizationId, p.id, transit)).toBe(20);
      expect(await onHand(prisma, org.organizationId, p.id, org.altLocationId)).toBe(0);
      await expect(asOrg(() => docs.dispatchTransfer(doc.id))).rejects.toThrow(/approved, undispatched/);

      const itemId = doc.items[0].id;
      await expect(asOrg(() => docs.receiveTransfer(doc.id, { lines: [{ itemId, received: 19, damaged: 1, short: 1 }] }))).rejects.toThrow(/exceeds/);
      const partial = await asOrg(() => docs.receiveTransfer(doc.id, { lines: [{ itemId, received: 10 }] }));
      expect(partial.status).toBe('partially_received');
      const done = await asOrg(() => docs.receiveTransfer(doc.id, { lines: [{ itemId, received: 8, damaged: 1, short: 1 }], notes: 'two cartons crushed / missing' }));
      expect(done.status).toBe('completed');
      expect(done.receipts).toHaveLength(2);

      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(30);
      expect(await onHand(prisma, org.organizationId, p.id, transit)).toBe(0);
      expect(await onHand(prisma, org.organizationId, p.id, org.altLocationId)).toBe(18);
      const item = await prisma.stockTransferItem.findUniqueOrThrow({ where: { id: itemId } });
      expect([Number(item.qtyDispatched), Number(item.qtyReceived), Number(item.qtyDamaged), Number(item.qtyShort)]).toEqual([20, 18, 1, 1]);
      // Only the two write-offs leave inventory value: 2 × 100.
      expect(await balance('stock_valuation')).toBeCloseTo(svStart - 200, 2);
      for (const loc of [org.mainLocationId, transit, org.altLocationId]) {
        expect(await ledgerSum(prisma, org.organizationId, p.id, loc)).toBe(await onHand(prisma, org.organizationId, p.id, loc));
      }

      await asOrg(() => reversals.reverseDocument('stock_transfer', doc.id, 'wrong branch'));
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(50);
      expect(await onHand(prisma, org.organizationId, p.id, transit)).toBe(0);
      expect(await onHand(prisma, org.organizationId, p.id, org.altLocationId)).toBe(0);
      expect(await balance('stock_valuation')).toBeCloseTo(svStart, 2);
    }, 120_000);

    it('recall returns what is still in transit; cancel only before dispatch', async () => {
      const p = await product('TR-RECALL');
      await receive(p.id, 10, 100);
      const doc = await createTransit(p.id, 10);
      await asOrg(() => docs.approveTransfer(doc.id));
      await asOrg(() => docs.dispatchTransfer(doc.id));
      await expect(asOrg(() => docs.cancelTransfer(doc.id))).rejects.toThrow(/already moved stock/);
      await asOrg(() => docs.receiveTransfer(doc.id, { lines: [{ itemId: doc.items[0].id, received: 4 }] }));
      const recalled = await asOrg(() => docs.recallTransfer(doc.id, 'truck turned back'));
      expect(recalled.status).toBe('completed');
      expect(await onHand(prisma, org.organizationId, p.id, org.mainLocationId)).toBe(6);
      expect(await onHand(prisma, org.organizationId, p.id, org.altLocationId)).toBe(4);
      expect(await onHand(prisma, org.organizationId, p.id, await transitLocId())).toBe(0);

      const other = await createTransit(p.id, 1);
      await asOrg(() => docs.approveTransfer(other.id));
      expect((await asOrg(() => docs.cancelTransfer(other.id))).status).toBe('cancelled');
    }, 120_000);

    it('immediate transfers are unchanged and cannot be dispatched', async () => {
      const p = await product('TR-IMM');
      await receive(p.id, 5, 100);
      const doc = await asOrg(() => docs.createTransfer({
        fromLocationId: org.mainLocationId, toLocationId: org.altLocationId,
        responsibleById: staffId, approvedById: staffId, items: [{ productId: p.id, qtyRequested: 2 }],
      } as any));
      await expect(asOrg(() => docs.dispatchTransfer(doc.id))).rejects.toThrow(/immediate transfer/);
      await asOrg(() => docs.approveTransfer(doc.id));
      expect(await onHand(prisma, org.organizationId, p.id, org.altLocationId)).toBe(2);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // P2-02
  // ---------------------------------------------------------------------------

  describe('P2-02 landed cost', () => {
    const grnWith = async (productId: string, qty: number, unitCost: number, extra: Record<string, unknown> = {}) => {
      const grn = await prisma.goodsReceiptNote.create({
        data: {
          organizationId: org.organizationId, receiptNumber: `A3-GRN-${uid()}`, warehouseId: org.mainLocationId, status: 'posted', postedAt: new Date(),
          lines: { create: [{ organizationId: org.organizationId, productId, description: 'goods', quantity: qty, unitCost, batchNumber: (extra.batchNumber as string) ?? null }] },
        } as any,
      });
      await asOrg(() => stock.receiveForDocument(
        { productId, locationId: org.mainLocationId, quantity: qty, unitCost, ...extra } as any,
        { sourceType: 'goods_receipt', sourceId: grn.id, date: new Date() },
      ));
      return grn;
    };

    it('AVCO: 6 of 10 still on hand → 60% capitalised into the average, 40% to COGS', async () => {
      const p = await product('LC-AVCO');
      const grn = await grnWith(p.id, 10, 100);
      await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 4, sourceType: 'audit', sourceId: uid() } as any));
      const [sv0, cogs0, ap0] = [await balance('stock_valuation'), await balance('cogs'), await balance('accounts_payable')];

      const draft = await asOrg(() => landed.create({ goodsReceiptId: grn.id, creditAccountId: org.accounts.accounts_payable, charges: [{ kind: 'freight', amount: 150 }, { kind: 'duty', amount: 50 }] }));
      const posted = await asOrg(() => landed.post(draft.id));
      expect(Number(posted!.capitalizedAmount)).toBeCloseTo(120, 6);
      expect(Number(posted!.expensedAmount)).toBeCloseTo(80, 6);
      const si = await prisma.stockItem.findFirstOrThrow({ where: { organizationId: org.organizationId, productId: p.id, locationId: org.mainLocationId } });
      expect(Number(si.runningAverageCost)).toBeCloseTo(120, 6);
      expect(await balance('stock_valuation')).toBeCloseTo(sv0 + 120, 2);
      expect(await balance('cogs')).toBeCloseTo(cogs0 + 80, 2);
      expect(await balance('accounts_payable')).toBeCloseTo(ap0 - 200, 2);
      await expect(asOrg(() => landed.post(draft.id))).rejects.toThrow(/not a draft/);
    }, 60_000);

    it('FIFO lot: only the receipt lot is re-costed; a posted landed cost blocks GRN reversal', async () => {
      const p = await product('LC-FIFO', { batchTracking: true, costingMethod: 'FIFO' });
      const grn = await grnWith(p.id, 10, 50, { batchNumber: `LC-${uid()}` });
      await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 5, sourceType: 'audit', sourceId: uid() } as any));
      const draft = await asOrg(() => landed.create({ goodsReceiptId: grn.id, creditAccountId: org.accounts.grni_accrued, allocationMethod: 'quantity', charges: [{ kind: 'freight', amount: 100 }] }));
      const posted = await asOrg(() => landed.post(draft.id));
      expect(Number(posted!.capitalizedAmount)).toBeCloseTo(50, 6);
      const lot = await prisma.inventoryBatch.findFirstOrThrow({ where: { organizationId: org.organizationId, productId: p.id, locationId: org.mainLocationId } });
      expect(Number(lot.unitCost)).toBeCloseTo(60, 6);
      const issued = await asOrg(() => stock.issue({ productId: p.id, locationId: org.mainLocationId, quantity: 1, sourceType: 'audit', sourceId: uid() } as any));
      expect(Number(issued.totalValue)).toBeCloseTo(60, 6);
      await expect(asOrg(() => moduleRef.get(GoodsReceiptsService).reverse(grn.id, 'wrong supplier'))).rejects.toThrow(/posted landed cost/);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // P2-03
  // ---------------------------------------------------------------------------

  describe('P2-03 count modes', () => {
    it('blind spot count hides system figures until reviewed, and posts only its scope', async () => {
      const a = await product('CNT-A');
      const b = await product('CNT-B');
      await receive(a.id, 10, 100);
      await receive(b.id, 7, 100);
      await expect(asOrg(() => counts.start({ locationId: org.mainLocationId, countType: 'spot' } as any))).rejects.toThrow(/at least one product/);

      const session: any = await asOrg(() => counts.start({ locationId: org.mainLocationId, countType: 'spot', blind: true, scopeProductIds: [a.id] } as any));
      expect(session.lines).toHaveLength(1);
      expect(session.systemHidden).toBe(true);
      expect(session.lines[0].systemQty).toBeNull();
      const saved: any = await asOrg(() => counts.saveDraft(session.id, { lines: [{ lineId: session.lines[0].id, countedQty: 9, reason: 'breakage' }] }));
      expect(saved.lines[0].variance).toBeNull();
      const review: any = await asOrg(() => counts.get(session.id, true));
      expect(Number(review.lines[0].systemQty)).toBe(10);
      expect(Number(review.lines[0].variance)).toBe(-1);

      await asOrg(() => counts.submit(session.id, {}));
      expect(await onHand(prisma, org.organizationId, a.id, org.mainLocationId)).toBe(9);
      expect(await onHand(prisma, org.organizationId, b.id, org.mainLocationId)).toBe(7);
      const after: any = await asOrg(() => counts.get(session.id));
      expect(after.systemHidden).toBe(false);
    }, 60_000);

    it('cycle count by category scopes the sheet', async () => {
      const cat = await prisma.productCategory.create({ data: { organizationId: org.organizationId, name: `A3 Dairy ${uid()}` } as any });
      const inCat = await product('CYC-IN', { categoryId: cat.id });
      await product('CYC-OUT');
      await expect(asOrg(() => counts.start({ locationId: org.altLocationId, countType: 'cycle' } as any))).rejects.toThrow(/needs a scope/);
      const s: any = await asOrg(() => counts.start({ locationId: org.altLocationId, countType: 'cycle', scopeCategoryIds: [cat.id] } as any));
      expect(s.lines.map((l: any) => l.productId)).toEqual([inCat.id]);
      await asOrg(() => counts.cancel(s.id));
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // P2-04
  // ---------------------------------------------------------------------------

  describe('P2-04 stock health', () => {
    it('classifies active vs dead stock and ages the on-hand layers', async () => {
      const active = await product('HL-ACTIVE');
      const dead = await product('HL-DEAD');
      await receive(active.id, 10, 100);
      await receive(dead.id, 4, 100);
      await asOrg(() => stock.issue({ productId: active.id, locationId: org.mainLocationId, quantity: 5, sourceType: 'audit', sourceId: uid() } as any));

      const res = await asOrg(() => reports.stockHealth({ locationId: org.mainLocationId, slowDays: '30', deadDays: '60' }));
      const rowA = res.rows.find((r) => r.productId === active.id)!;
      const rowD = res.rows.find((r) => r.productId === dead.id)!;
      expect(rowA.status).toBe('active');
      expect(rowA.onHand).toBe(5);
      expect(rowA.aging.d0_30).toBe(5);
      expect(rowA.consumedQty).toBe(5);
      expect(rowA.turnover).toBeGreaterThan(0);
      expect(rowD.status).toBe('dead');
      expect(rowD.value).toBe(400);
      expect(res.summary.deadValue).toBeGreaterThanOrEqual(400);

      const onlyDead = await asOrg(() => reports.stockHealth({ locationId: org.mainLocationId, status: 'dead' }));
      expect(onlyDead.rows.every((r) => r.status === 'dead')).toBe(true);
    }, 60_000);
  });
});
