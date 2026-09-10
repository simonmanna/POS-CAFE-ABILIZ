/**
 * AUDIT — H9 (Tier A): does the books lock actually protect INVENTORY, or only
 * the general ledger?
 *
 * `FiscalPeriodService.assertOpen` is called from exactly one place —
 * `PostingService.post` (posting.service.ts:92). Every inventory movement whose
 * GL value is zero returns BEFORE that call:
 *
 *   stock-posting.service.ts:118  `if (resolution.totalValue.lte(ZERO)) return`
 *   stock.service.ts:434          receipts skip GL entirely when glCtx is absent
 *
 * The InventoryLedger row and the StockItem decrement are written regardless.
 * If that is what happens, a closed period's physical stock can still be moved,
 * and last year's stocktake stops being reproducible.
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
import { createAuditOrg, dropAuditOrg, onHand, AuditOrg } from './_harness';

describeDb('AUDIT: period lock vs inventory movements (H9)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let tenant: TenantContextService;
  let org: AuditOrg;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: 'audit-user', permissions: [] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'LOCK');
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

  const makeProduct = (code: string) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId, code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: 0, salesPrice: 0,
      } as any,
    });

  it('H9: a valued issue IS blocked once the books are locked (the control that works)', async () => {
    const product = await makeProduct('LOCK-VALUED');
    await asOrg(() =>
      stock.receiveForDocument(
        { productId: product.id, locationId: org.mainLocationId, quantity: 100, unitCost: 10 } as any,
        { sourceType: 'audit_seed', sourceId: 'seed-valued', date: new Date() },
      ),
    );

    // Lock the books through tomorrow — nothing may post.
    await prisma.organization.update({
      where: { id: org.organizationId },
      data: { booksLockDate: new Date(Date.now() + 24 * 3600 * 1000) } as any,
    });

    await expect(
      asOrg(() =>
        stock.issue({
          productId: product.id, locationId: org.mainLocationId, quantity: 5,
          sourceType: 'audit_sale', sourceId: 'locked-sale',
        } as any),
      ),
    ).rejects.toThrow(/locked/i);

    // Nothing moved.
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(100);
  }, 240_000);

  it('H9: a ZERO-VALUE issue is NOT blocked — stock moves inside a locked period', async () => {
    // A product carried at zero cost: promotional stock, a recipe ingredient
    // received before costing was configured, or anything whose running average
    // is still 0. Entirely ordinary in a café.
    const product = await makeProduct('LOCK-ZEROCOST');
    // Books are still locked from the previous test — unlock, seed, relock, so
    // the seed itself is legitimate.
    await prisma.organization.update({
      where: { id: org.organizationId }, data: { booksLockDate: null } as any,
    });
    await asOrg(() =>
      stock.receiveForDocument(
        { productId: product.id, locationId: org.mainLocationId, quantity: 100, unitCost: 0 } as any,
        { sourceType: 'audit_seed', sourceId: 'seed-zero', date: new Date() },
      ),
    );
    await prisma.organization.update({
      where: { id: org.organizationId },
      data: { booksLockDate: new Date(Date.now() + 24 * 3600 * 1000) } as any,
    });

    const ledgerBefore = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, productId: product.id },
    });
    const jeBefore = await prisma.journalEntry.count({ where: { organizationId: org.organizationId } });

    let threw: string | null = null;
    try {
      await asOrg(() =>
        stock.issue({
          productId: product.id, locationId: org.mainLocationId, quantity: 30,
          sourceType: 'audit_sale', sourceId: 'locked-zero-sale',
        } as any),
      );
    } catch (e: any) {
      threw = e?.message ?? String(e);
    }

    const after = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    const ledgerAfter = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, productId: product.id },
    });
    const jeAfter = await prisma.journalEntry.count({ where: { organizationId: org.organizationId } });

    // eslint-disable-next-line no-console
    console.log('[H9 EVIDENCE]', JSON.stringify({
      booksLockedThrough: 'tomorrow',
      issueRejected: threw !== null,
      rejectionMessage: threw,
      onHandBefore: 100, onHandAfter: after,
      ledgerRowsBefore: ledgerBefore, ledgerRowsAfter: ledgerAfter,
      journalEntriesBefore: jeBefore, journalEntriesAfter: jeAfter,
    }));

    // EXPECTED: a locked period protects physical stock as well as the GL.
    expect(threw).toMatch(/locked/i);
    expect(after).toBe(100);
    expect(ledgerAfter).toBe(ledgerBefore);
  }, 240_000);

  it('H9: an unvalued RECEIPT is not blocked either (no glCtx → no assertOpen)', async () => {
    const product = await makeProduct('LOCK-BARE-RECEIPT');
    // Books remain locked through tomorrow from the previous test.
    const orgRow = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
    expect((orgRow as any).booksLockDate).toBeTruthy();

    let threw: string | null = null;
    try {
      // `receive()` (as opposed to `receiveForDocument`) carries no GL context,
      // so stock.service.ts:434 skips posting altogether.
      await asOrg(() =>
        stock.receive({
          productId: product.id, locationId: org.mainLocationId, quantity: 40, unitCost: 3,
          sourceType: 'audit_bare', sourceId: 'bare-1',
        } as any),
      );
    } catch (e: any) {
      threw = e?.message ?? String(e);
    }

    const after = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    // eslint-disable-next-line no-console
    console.log('[H9-B EVIDENCE]', JSON.stringify({
      path: 'StockService.receive (no GL context)',
      rejected: threw !== null, rejectionMessage: threw,
      onHandAfter: after, valueAdded: after * 3,
    }));

    // EXPECTED: goods cannot be brought into a locked period unposted.
    expect(threw).toMatch(/locked/i);
    expect(after).toBe(0);
  }, 240_000);
});
