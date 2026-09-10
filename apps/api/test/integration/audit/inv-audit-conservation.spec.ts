/**
 * AUDIT — INV-INVARIANT-26 (quantity conservation) and INV-INVARIANT-27
 * (valuation conservation).
 *
 * A plain `SUM(quantityChange) == StockItem.quantity` check (already covered by
 * inventory-engine.spec) cannot see a movement booked under the WRONG
 * StockMoveType: the signed sum still ties while the business classification is
 * wrong, which corrupts every downstream report (waste, shrinkage, consumption,
 * turnover). These specs assert the classified identity instead:
 *
 *   opening + receipts + transfers_in + adjustments_in + returns_in
 *           − issues − waste − transfers_out − adjustments_out
 *   = closing
 *
 * and then that the valuation the subledger implies equals the Stock Valuation
 * GL control account.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from '../_setup';
import { KernelModule } from '../../../src/kernel/kernel.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { CoreModule } from '../../../src/modules/core/core.module';
import { InventoryModule } from '../../../src/modules/inventory/inventory.module';
import { StockService } from '../../../src/modules/inventory/stock.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, accountBalance, movementsByType, round6, AuditOrg } from './_harness';

describeDb('AUDIT: inventory conservation invariants', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let tenant: TenantContextService;
  let org: AuditOrg;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> => tenant.run({ organizationId: org.organizationId }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'CONS');
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    tenant = moduleRef.get(TenantContextService);
  }, 180_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 120_000);

  const makeProduct = (code: string) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId,
        code,
        name: code,
        productType: 'stockable',
        trackInventory: true,
        costingMethod: 'AVCO',
        costPrice: 0,
        salesPrice: 0,
      } as any,
    });

  /**
   * The scripted mixed workload. Numbers are chosen so every AVCO average
   * terminates exactly in base-10, making the expected values assertable to the
   * cent rather than to a tolerance.
   *
   *   receive 100 @ 10      → qty 100  value 1000    avg 10
   *   issue    20           → qty  80  value  800    COGS 200
   *   receive  20 @ 14      → qty 100  value 1080    avg 10.8
   *   issue    30           → qty  70  value  756    COGS 324
   *   return    5 @ 10.8    → qty  75  value  810
   *   transfer 20 → ALT     → MAIN 55 (594) / ALT 20 (216)
   *   adjust MAIN to 53     → adjustment_out 2 (21.6)
   *
   *   closing quantity = 53 + 20 = 73
   *   closing value    = 572.4 + 216 = 788.4
   */
  it('INV-INVARIANT-26: classified movements reconcile to the closing quantity', async () => {
    const product = await makeProduct('CONS-QTY');

    await asOrg(async () => {
      await stock.receiveForDocument(
        { productId: product.id, locationId: org.mainLocationId, quantity: 100, unitCost: 10 } as any,
        { sourceType: 'audit_receipt', sourceId: 'r1', date: new Date() },
      );
      await stock.issue({
        productId: product.id, locationId: org.mainLocationId, quantity: 20,
        sourceType: 'audit_sale', sourceId: 's1',
      } as any);
      await stock.receiveForDocument(
        { productId: product.id, locationId: org.mainLocationId, quantity: 20, unitCost: 14 } as any,
        { sourceType: 'audit_receipt', sourceId: 'r2', date: new Date() },
      );
      await stock.issue({
        productId: product.id, locationId: org.mainLocationId, quantity: 30,
        sourceType: 'audit_sale', sourceId: 's2',
      } as any);
      await stock.receiveReturn({
        productId: product.id, locationId: org.mainLocationId, quantity: 5, unitCost: 10.8,
        sourceType: 'audit_refund', sourceId: 'ret1',
      } as any);
      await stock.transfer({
        productId: product.id, fromLocationId: org.mainLocationId, toLocationId: org.altLocationId, quantity: 20,
        sourceType: 'audit_transfer', sourceId: 't1',
      } as any);
      await stock.adjust({
        productId: product.id, locationId: org.mainLocationId, countedQuantity: 53, notes: 'audit shrinkage',
      } as any);
    });

    const main = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    const alt = await onHand(prisma, org.organizationId, product.id, org.altLocationId);
    expect(main).toBe(53);
    expect(alt).toBe(20);

    const m = await movementsByType(prisma, org.organizationId, product.id);
    const g = (k: string) => round6(m[k] ?? 0);

    // Classification must be exact — a receipt booked as an adjustment would
    // leave the signed sum intact but this assertion red.
    expect(g('receipt')).toBe(120);
    expect(g('return_in')).toBe(5);
    expect(g('transfer_in')).toBe(20);
    expect(g('issue')).toBe(-50);
    expect(g('transfer_out')).toBe(-20);
    expect(g('adjustment_out')).toBe(-2);
    // Nothing must have leaked into a category the workload never exercised.
    expect(g('waste')).toBe(0);
    expect(g('adjustment_in')).toBe(0);
    expect(g('opening_balance')).toBe(0);

    const classified =
      g('opening_balance') + g('receipt') + g('return_in') + g('transfer_in') + g('adjustment_in') +
      g('issue') + g('transfer_out') + g('adjustment_out') + g('waste');
    expect(round6(classified)).toBe(round6(main + alt));
  }, 180_000);

  it('INV-INVARIANT-27: subledger valuation equals the Stock Valuation GL balance', async () => {
    // Re-uses the state built above (same product, same org) — this asserts the
    // money leg of the identical workload.
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, code: 'CONS-QTY' },
    });

    const quants = await prisma.stockItem.findMany({
      where: { organizationId: org.organizationId, productId: product.id },
    });
    const subledgerValue = round6(
      quants.reduce((sum, q) => sum + Number(q.quantity) * Number(q.runningAverageCost), 0),
    );

    // Expected from the scripted workload: MAIN 53 × 10.8 + ALT 20 × 10.8.
    expect(subledgerValue).toBe(788.4);

    const glValue = round6(await accountBalance(prisma, org.organizationId, org.accounts.stock_valuation));
    expect(glValue).toBe(subledgerValue);

    // And the COGS leg: 200 (20 × 10) + 324 (30 × 10.8) = 524, less the 54
    // credited back by the return restock = 470.
    const cogsValue = round6(await accountBalance(prisma, org.organizationId, org.accounts.cogs));
    expect(cogsValue).toBe(470);

    // Value conservation across the whole workload:
    //   receipts 1280 + return 54 − COGS 524 − adjustment 21.6 = 788.4
    const adjExpense = round6(await accountBalance(prisma, org.organizationId, org.accounts.stock_adjustment_expense));
    expect(round6(1280 + 54 - 524 - adjExpense)).toBe(subledgerValue);
  }, 180_000);

  it('INV-INVARIANT-03: every ledger row carries a resolvable source reference', async () => {
    const rows = await prisma.inventoryLedger.findMany({
      where: { organizationId: org.organizationId },
      select: { id: true, type: true, referenceType: true, referenceId: true, performedBy: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    const orphans = rows.filter((r) => !r.referenceType || !r.referenceId);
    expect(
      orphans.map((o) => `${o.type} (ledger ${o.id}) has referenceType=${o.referenceType} referenceId=${o.referenceId}`),
    ).toEqual([]);
  }, 120_000);
});
