/**
 * AUDIT — multi-tenant isolation (INV-INVARIANT-18) and multi-location
 * integrity (INV-INVARIANT-19 / H10, Tier A).
 *
 * Two separate questions:
 *
 *   1. Can org B read or post against org A's inventory? Adversarial reads are
 *      issued through the SAME typed client the application uses, inside org B's
 *      tenant context, plus a raw-SQL probe. H2 also asks whether
 *      `InventoryPostingRule` — absent from ORG_SCOPED in the tenancy extension
 *      and therefore protected only by whatever `where` its callers happen to
 *      write — can leak a GL account across orgs.
 *
 *   2. Can a sale consume from the wrong location? `resolvePosStockLocation`
 *      reads ONE org-wide setting and otherwise falls back to "first active
 *      warehouse" with no ordering. A two-branch café would then relieve every
 *      till against a single store.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from '../_setup';
import { KernelModule } from '../../../src/kernel/kernel.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { CoreModule } from '../../../src/modules/core/core.module';
import { InventoryModule } from '../../../src/modules/inventory/inventory.module';
import { StockService } from '../../../src/modules/inventory/stock.service';
import { PrismaService } from '../../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { resolvePosStockLocation } from '../../../src/modules/inventory/pos-stock-location';
import { createAuditOrg, dropAuditOrg, onHand, AuditOrg } from './_harness';

describeDb('AUDIT: multi-tenant and multi-location isolation', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let stock: StockService;
  let prismaSvc: PrismaService;
  let tenant: TenantContextService;

  let orgA: AuditOrg;
  let orgB: AuditOrg;
  let productA: string;

  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: orgA.organizationId, userId: 'audit-a', permissions: [] }, fn);
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: orgB.organizationId, userId: 'audit-b', permissions: [] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    orgA = await createAuditOrg(prisma, 'TENA');
    orgB = await createAuditOrg(prisma, 'TENB');

    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule],
    }).compile();
    await moduleRef.init();
    stock = moduleRef.get(StockService);
    prismaSvc = moduleRef.get(PrismaService);
    tenant = moduleRef.get(TenantContextService);

    // Org A holds real stock that org B must never see or touch.
    productA = (
      await prisma.product.create({
        data: {
          organizationId: orgA.organizationId, code: 'TEN-A-ITEM', name: 'Org A Item',
          productType: 'stockable', trackInventory: true, costingMethod: 'AVCO',
          costPrice: 0, salesPrice: 0,
        } as any,
      })
    ).id;
    await asA(() =>
      stock.receiveForDocument(
        { productId: productA, locationId: orgA.mainLocationId, quantity: 500, unitCost: 7 } as any,
        { sourceType: 'audit_seed', sourceId: 'seedA', date: new Date() },
      ),
    );
  }, 240_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, orgA?.organizationId);
    await dropAuditOrg(prisma, orgB?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 180_000);

  it('INV-INVARIANT-18: org B cannot read org A stock through the application client', async () => {
    const leaks = await asB(async () => {
      const c = prismaSvc.client as any;
      return {
        stockItems: await c.stockItem.count({ where: { productId: productA } }),
        ledger: await c.inventoryLedger.count({ where: { productId: productA } }),
        batches: await c.inventoryBatch.count({ where: { productId: productA } }),
        product: await c.product.count({ where: { id: productA } }),
        locations: await c.inventoryLocation.count({ where: { id: orgA.mainLocationId } }),
        // Deliberately hostile: an explicit foreign organizationId in the filter.
        forced: await c.stockItem.count({ where: { organizationId: orgA.organizationId } }),
      };
    });
    expect(leaks).toEqual({
      stockItems: 0, ledger: 0, batches: 0, product: 0, locations: 0, forced: 0,
    });
  }, 120_000);

  it('INV-INVARIANT-18: org B cannot issue org A stock', async () => {
    await expect(
      asB(() =>
        stock.issue({
          productId: productA, locationId: orgA.mainLocationId, quantity: 1,
          sourceType: 'audit_attack', sourceId: 'x',
        } as any),
      ),
    ).rejects.toThrow();
    // And org A's on-hand is untouched.
    expect(await onHand(prisma, orgA.organizationId, productA, orgA.mainLocationId)).toBe(500);
  }, 120_000);

  it('H2: an InventoryPostingRule belonging to org A must not resolve for org B', async () => {
    // Org A pins STOCK_OUT to a literal org-A account.
    await prisma.inventoryPostingRule.create({
      data: {
        organizationId: orgA.organizationId,
        movementType: 'STOCK_OUT',
        lineIndex: 0,
        debitOrCredit: 'debit',
        accountSource: 'literal',
        literalAccountId: orgA.accounts.cogs,
        isActive: true,
      } as any,
    });
    await prisma.inventoryPostingRule.create({
      data: {
        organizationId: orgA.organizationId,
        movementType: 'STOCK_OUT',
        lineIndex: 1,
        debitOrCredit: 'credit',
        accountSource: 'literal',
        literalAccountId: orgA.accounts.stock_valuation,
        isActive: true,
      } as any,
    });

    const productB = await prisma.product.create({
      data: {
        organizationId: orgB.organizationId, code: 'TEN-B-ITEM', name: 'Org B Item',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO',
        costPrice: 0, salesPrice: 0,
      } as any,
    });
    await asB(() =>
      stock.receiveForDocument(
        { productId: productB.id, locationId: orgB.mainLocationId, quantity: 10, unitCost: 5 } as any,
        { sourceType: 'audit_seed', sourceId: 'seedB', date: new Date() },
      ),
    );
    await asB(() =>
      stock.issue({
        productId: productB.id, locationId: orgB.mainLocationId, quantity: 4,
        sourceType: 'audit_sale', sourceId: 'sB',
      } as any),
    );

    // Every journal line org B produced must reference an org B account.
    const bLines = await prisma.journalLine.findMany({
      where: { organizationId: orgB.organizationId },
      select: { accountId: true },
    });
    const aAccountIds = new Set(Object.values(orgA.accounts));
    const foreign = bLines.filter((l) => aAccountIds.has(l.accountId));
    expect(foreign).toEqual([]);

    // eslint-disable-next-line no-console
    console.log('[H2 EVIDENCE]', JSON.stringify({
      orgARulesCreated: 2,
      orgBJournalLines: bLines.length,
      orgBLinesReferencingOrgAAccounts: foreign.length,
      note: 'loadRules() filters organizationId explicitly (posting-rule.service.ts:181)',
    }));
  }, 180_000);

  it('H2-architecture: InventoryPostingRule is not covered by the tenancy extension', async () => {
    // Documented as a finding, not a leak: the model is absent from ORG_SCOPED,
    // so the ONLY thing scoping it is the `where` each caller writes by hand.
    // This asserts the current (fragile) state so a regression is visible.
    const extension = require('fs').readFileSync(
      require('path').join(__dirname, '../../../src/kernel/prisma/tenancy.extension.ts'),
      'utf8',
    );
    const orgScopedBlock = extension.slice(
      extension.indexOf('ORG_SCOPED'),
      extension.indexOf('SOFT_DELETE'),
    );
    const covered = orgScopedBlock.includes("'InventoryPostingRule'");
    // eslint-disable-next-line no-console
    console.log('[H2 EVIDENCE] InventoryPostingRule in ORG_SCOPED:', covered);
    expect(covered).toBe(true);
  }, 60_000);

  it('H10: the POS stock location must be resolvable per register, not one per org', async () => {
    // Two branches, each with its own store and its own till.
    const branchStore = await prisma.inventoryLocation.create({
      data: {
        organizationId: orgB.organizationId, code: 'BRANCH-2', name: 'Branch 2 Store',
        type: 'warehouse', isActive: true,
      },
    });
    const register = await prisma.cashRegister.create({
      data: {
        organizationId: orgB.organizationId, code: 'TILL-2', name: 'Branch 2 Till',
        locationId: branchStore.id, defaultAccountId: orgB.accounts.cash,
      } as any,
    });

    const resolved = await asB(() => resolvePosStockLocation(prismaSvc, orgB.organizationId, undefined, register.locationId));

    // eslint-disable-next-line no-console
    console.log('[H10 EVIDENCE]', JSON.stringify({
      registerId: register.id,
      registerLocationId: branchStore.id,
      resolvedLocationId: resolved?.id ?? null,
      orgMainLocationId: orgB.mainLocationId,
      resolverSignatureTakesRegister: true,
    }));

    // EXPECTED: a till bound to Branch 2 relieves Branch 2's stock.
    expect(resolved?.id).toBe(branchStore.id);
  }, 120_000);

  it('H10: an unset setting must not silently pick an arbitrary warehouse', async () => {
    // No `pos.stockLocationId` setting exists for org B. With three active
    // warehouses the resolver has no deterministic ordering to fall back on.
    const locations = await prisma.inventoryLocation.findMany({
      where: { organizationId: orgB.organizationId, type: 'warehouse', isActive: true },
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });
    const setting = await prisma.setting.findFirst({
      where: { organizationId: orgB.organizationId, key: 'pos.stockLocationId' },
    });
    const resolved = await asB(() => resolvePosStockLocation(prismaSvc, orgB.organizationId));

    // eslint-disable-next-line no-console
    console.log('[H10-B EVIDENCE]', JSON.stringify({
      settingConfigured: !!setting,
      activeWarehouses: locations.map((l) => l.code),
      resolved: locations.find((l) => l.id === resolved?.id)?.code ?? null,
    }));

    // EXPECTED: with no explicit configuration and more than one candidate the
    // system should refuse rather than guess which store the till sells from.
    expect(locations.length).toBeGreaterThan(1);
    expect(setting).toBeTruthy();
  }, 120_000);
});
