/**
 * AUDIT — INV-024 / INV-025, concurrency.
 *
 * The pre-existing spec named "cannot oversell when allowNegativeStock=false"
 * (inventory-engine.spec.ts:237) never writes that setting, and the registry
 * default is `true` (setting-registry.ts:73). The strict-mode guard at
 * stock.service.ts:582 is therefore skipped and the test has been asserting
 * nothing about the branch it names. These specs configure the setting properly
 * and exercise both modes.
 *
 * Two questions:
 *   1. Strict mode — N terminals, N+M concurrent sales: exactly N succeed and
 *      on-hand lands on 0, never negative, never duplicated.
 *   2. Permissive mode (the shipped default, the owner's never-block-sales rule)
 *      — overselling is allowed, but the ledger chain must stay coherent:
 *      Σ quantityChange == StockItem.quantity, and each row's qtyBefore must be
 *      the previous row's balanceAfter.
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
import { createAuditOrg, dropAuditOrg, onHand, ledgerSum, AuditOrg } from './_harness';

describeDb('AUDIT: concurrency (INV-024 / INV-025)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let tenant: TenantContextService;
  let org: AuditOrg;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: 'audit-user', permissions: [] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'CONC');
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    tenant = moduleRef.get(TenantContextService);
  }, 240_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 120_000);

  const setNegativeStock = (allow: boolean) =>
    prisma.setting.upsert({
      where: {
        organizationId_scopeType_scopeId_key: {
          organizationId: org.organizationId, scopeType: 'organization', scopeId: '',
          key: 'inventory.allowNegativeStock',
        },
      },
      update: { value: allow as any },
      create: {
        organizationId: org.organizationId, scopeType: 'organization', scopeId: '',
        key: 'inventory.allowNegativeStock', value: allow as any, scope: 'organization',
      },
    });

  const makeProduct = (code: string, overrides: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId, code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: 0, salesPrice: 0,
        ...overrides,
      } as any,
    });

  const seed = (productId: string, qty: number, cost = 10) =>
    asOrg(() =>
      stock.receiveForDocument(
        { productId, locationId: org.mainLocationId, quantity: qty, unitCost: cost } as any,
        { sourceType: 'audit_seed', sourceId: `seed-${productId}`, date: new Date() },
      ),
    );

  it('INV-024 strict: 20 concurrent sales against 10 units → exactly 10 succeed, on-hand 0', async () => {
    await setNegativeStock(false);
    const product = await makeProduct('CONC-STRICT', { stockPolicy: 'block' });
    await seed(product.id, 10);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        asOrg(() =>
          stock.issue({
            productId: product.id, locationId: org.mainLocationId, quantity: 1,
            sourceType: 'audit_sale', sourceId: `conc-${i}`,
          } as any),
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.length - fulfilled;
    const after = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    const sum = await ledgerSum(prisma, org.organizationId, product.id, org.mainLocationId);
    const issueRows = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, productId: product.id, type: 'issue' },
    });

    // eslint-disable-next-line no-console
    console.log('[INV-024 EVIDENCE]', JSON.stringify({
      allowNegativeStock: false, stockPolicy: 'block',
      seeded: 10, attempted: 20,
      fulfilled, rejected, onHandAfter: after, ledgerSum: sum, issueLedgerRows: issueRows,
      sampleRejection: results.find((r) => r.status === 'rejected')
        ? (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason?.message
        : null,
    }));

    expect(fulfilled).toBe(10);
    expect(rejected).toBe(10);
    expect(after).toBe(0);
    expect(sum).toBe(0);
    expect(issueRows).toBe(10);
  }, 240_000);

  it('INV-024 permissive (shipped default): oversell allowed, but the ledger chain stays coherent', async () => {
    await setNegativeStock(true);
    const product = await makeProduct('CONC-PERMISSIVE', { stockPolicy: 'block' });
    await seed(product.id, 5);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        asOrg(() =>
          stock.issue({
            productId: product.id, locationId: org.mainLocationId, quantity: 1,
            sourceType: 'audit_sale', sourceId: `perm-${i}`,
          } as any),
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const after = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    const sum = await ledgerSum(prisma, org.organizationId, product.id, org.mainLocationId);

    // The ledger chain: each issue row's qtyBefore must equal the previous
    // row's balanceAfter. A broken chain means the running balance is fiction.
    const rows = await prisma.inventoryLedger.findMany({
      where: { organizationId: org.organizationId, productId: product.id },
      orderBy: { createdAt: 'asc' },
      select: { type: true, qtyBefore: true, quantityChange: true, balanceAfter: true, createdAt: true },
    });
    const breaks: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      if (Number(rows[i].qtyBefore) !== Number(rows[i - 1].balanceAfter)) {
        breaks.push(
          `row ${i}: qtyBefore=${rows[i].qtyBefore} but previous balanceAfter=${rows[i - 1].balanceAfter}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log('[INV-024-P EVIDENCE]', JSON.stringify({
      allowNegativeStock: true, seeded: 5, attempted: 12,
      fulfilled, onHandAfter: after, ledgerSum: sum,
      chainBreaks: breaks,
      rejections: results.filter((r) => r.status === 'rejected')
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason)),
    }));

    // Never-block-sales is the intended policy, so all 12 should go through.
    expect(fulfilled).toBe(12);
    expect(after).toBe(-7);
    // The quant and the ledger must still agree exactly.
    expect(sum).toBe(after);
    // And the running-balance chain must be unbroken.
    expect(breaks).toEqual([]);
  }, 240_000);

  it('INV-025: concurrent receipts blend the moving average without losing value', async () => {
    await setNegativeStock(true);
    const product = await makeProduct('CONC-RECEIPT');

    // Ten simultaneous receipts of 10 @ 10 = 100 units, value 1,000.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        asOrg(() =>
          stock.receiveForDocument(
            { productId: product.id, locationId: org.mainLocationId, quantity: 10, unitCost: 10 } as any,
            { sourceType: 'audit_receipt', sourceId: `cr-${i}`, date: new Date() },
          ),
        ),
      ),
    );

    const quant = await prisma.stockItem.findFirstOrThrow({
      where: { organizationId: org.organizationId, productId: product.id, locationId: org.mainLocationId },
    });
    const sum = await ledgerSum(prisma, org.organizationId, product.id, org.mainLocationId);

    // eslint-disable-next-line no-console
    console.log('[INV-025 EVIDENCE]', JSON.stringify({
      concurrentReceipts: 10, each: '10 @ 10',
      expectedQty: 100, actualQty: Number(quant.quantity),
      expectedAvgCost: 10, actualAvgCost: Number(quant.runningAverageCost),
      ledgerSum: sum,
    }));

    expect(Number(quant.quantity)).toBe(100);
    expect(Number(quant.runningAverageCost)).toBeCloseTo(10, 6);
    expect(sum).toBe(100);
  }, 240_000);
});
