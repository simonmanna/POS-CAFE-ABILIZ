/**
 * AUDIT — the async stock-posting pipeline under failure.
 *
 *   invoice → job → claim → issue line 1 → issue line 2 → COGS GL → job done
 *
 * Governing invariant: wherever the process dies, retry/recovery must converge
 * on exactly ONE correct inventory and accounting outcome.
 *
 * Also covers:
 *   H3 (Tier A) — inventory/COGS journal entries carry no `postingKey`, so the
 *      GL-layer replay guard in PostingService.doPost (posting.service.ts:76-86)
 *      is inert for the whole INV journal.
 *   H8 (Tier A) — a job whose individual lines fail is still marked `done`
 *      (pos-invoice.service.ts:1073-1096), so revenue posts in full while COGS
 *      and stock relief are silently partial.
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
import { StockService } from '../../../src/modules/inventory/stock.service';
import { StockPostingService } from '../../../src/modules/inventory/posting/stock-posting.service';
import { PrismaService } from '../../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, accountBalance, AuditOrg } from './_harness';

describeDb('AUDIT: async stock posting under failure (H3, H8, crash boundaries)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let billing: PosInvoiceService;
  let stock: StockService;
  let stockPosting: StockPostingService;
  let prismaSvc: PrismaService;
  let tenant: TenantContextService;
  let org: AuditOrg;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId: org.organizationId, userId: 'audit-user', permissions: [] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'CRASH');
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, PosModule, AccountingModule],
    }).compile();
    await moduleRef.init();
    billing = moduleRef.get(PosInvoiceService);
    stock = moduleRef.get(StockService);
    stockPosting = moduleRef.get(StockPostingService);
    prismaSvc = moduleRef.get(PrismaService);
    tenant = moduleRef.get(TenantContextService);
  }, 300_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 180_000);

  const makeStockProduct = async (code: string, qty = 100, cost = 10) => {
    const p = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: 0, salesPrice: 0,
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

  /** Hand-build a billed order plus its already-claimed posting job. */
  const makeJob = async (lines: Array<{ productId?: string; menuItemId?: string; quantity: number }>) => {
    const order = await prisma.order.create({
      data: {
        organizationId: org.organizationId,
        orderNumber: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'closed',
      },
    });
    let n = 0;
    for (const line of lines) {
      await prisma.orderItem.create({
        data: {
          organizationId: org.organizationId, orderId: order.id,
          productId: line.productId ?? null, menuItemId: line.menuItemId ?? null,
          description: `line-${++n}`, quantity: line.quantity, lineNumber: n,
        },
      });
    }
    const job = await prisma.stockPostingJob.create({
      data: {
        organizationId: org.organizationId, orderId: order.id, invoiceId: order.id,
        invoiceNumber: `INV-${order.orderNumber}`, status: 'processing',
        idempotencyKey: `at_invoice:${order.id}`,
        claimToken: 'audit-stale', claimedAt: new Date(Date.now() - 120_000),
      },
    });
    return { order, job };
  };

  // ───────────────────────── H3 ─────────────────────────

  it('H3: a repeated COGS posting for the same source writes a SECOND journal entry', async () => {
    const product = await makeStockProduct('H3-COGS', 100, 10);

    // Post the same inventory issue twice with an identical source identity.
    // A postingKey would make the second call replay the first entry.
    await asOrg(() =>
      prismaSvc.client.$transaction(async (tx: any) => {
        await stockPosting.postIssue({
          productId: product.id, quantity: 5, movementType: 'STOCK_OUT',
          date: new Date(), sourceType: 'pos_invoice', sourceId: 'H3-FIXED-SOURCE',
          description: 'audit duplicate probe', tx,
        } as any);
      }),
    );
    await asOrg(() =>
      prismaSvc.client.$transaction(async (tx: any) => {
        await stockPosting.postIssue({
          productId: product.id, quantity: 5, movementType: 'STOCK_OUT',
          date: new Date(), sourceType: 'pos_invoice', sourceId: 'H3-FIXED-SOURCE',
          description: 'audit duplicate probe', tx,
        } as any);
      }),
    );

    const entries = await prisma.journalEntry.findMany({
      where: { organizationId: org.organizationId, sourceType: 'pos_invoice', sourceId: 'H3-FIXED-SOURCE' },
      select: { id: true, entryNumber: true, postingKey: true },
    });

    // eslint-disable-next-line no-console
    console.log('[H3 EVIDENCE]', JSON.stringify({
      postIssueCalls: 2,
      journalEntriesCreated: entries.length,
      postingKeys: entries.map((e) => e.postingKey),
      cogsBalance: await accountBalance(prisma, org.organizationId, org.accounts.cogs),
    }));

    // EXPECTED: the GL replay guard collapses the second call to one entry.
    expect(entries.length).toBe(1);
    expect(entries[0].postingKey).toBeTruthy();
  }, 300_000);

  // ───────────────────────── H8 ─────────────────────────

  it('H8: a job with one failing line must not report success', async () => {
    const good = await makeStockProduct('H8-GOOD', 100, 10);
    // A tracked menu item with NO recipe: `issueMenuItemRecipe` records an
    // InventoryException and returns a failure, but the job still completes.
    const brokenMenuItem = await prisma.menuItem.create({
      data: { organizationId: org.organizationId, name: 'H8 Recipe-less Item', isInventoryTracked: true } as any,
    });

    const { job } = await makeJob([
      { productId: good.id, quantity: 5 },
      { menuItemId: brokenMenuItem.id, quantity: 3 },
    ]);

    await asOrg(() => billing.processStockPostingJob(job.id));

    const done = await prisma.stockPostingJob.findUniqueOrThrow({ where: { id: job.id } });
    const exceptions = await prisma.inventoryException.count({
      where: { organizationId: org.organizationId, menuItemId: brokenMenuItem.id },
    });

    // eslint-disable-next-line no-console
    console.log('[H8 EVIDENCE]', JSON.stringify({
      jobStatus: done.status,
      jobAttempts: done.attempts,
      lastError: done.lastError,
      inventoryExceptionsRaised: exceptions,
      goodLineOnHand: await onHand(prisma, org.organizationId, good.id, org.mainLocationId),
      note: 'revenue for the failed line was already posted synchronously at invoice time',
    }));

    // The exception IS raised — that part works.
    expect(exceptions).toBeGreaterThan(0);
    // EXPECTED: a job that could not relieve every line is not `done`; it stays
    // retryable or is explicitly `failed`, so the backlog monitor can see it.
    expect(done.status).not.toBe('done');
  }, 300_000);

  it('H8: a failed line is never retried — a second worker pass changes nothing', async () => {
    const brokenMenuItem = await prisma.menuItem.create({
      data: { organizationId: org.organizationId, name: 'H8 Retry Probe', isInventoryTracked: true } as any,
    });
    const { job } = await makeJob([{ menuItemId: brokenMenuItem.id, quantity: 2 }]);

    await asOrg(() => billing.processStockPostingJob(job.id));
    const first = await prisma.stockPostingJob.findUniqueOrThrow({ where: { id: job.id } });

    // Give the item a recipe — the underlying cause is now fixed.
    const ingredient = await makeStockProduct(`H8-ING-${Date.now()}`, 50, 4);
    await prisma.menuProduct.create({
      data: {
        organizationId: org.organizationId, menuItemId: brokenMenuItem.id,
        productId: ingredient.id, quantity: 3,
      } as any,
    });

    // Re-run the worker: a recoverable job would now succeed.
    await asOrg(() => billing.processStockPostingJob(job.id));
    const second = await prisma.stockPostingJob.findUniqueOrThrow({ where: { id: job.id } });

    // eslint-disable-next-line no-console
    console.log('[H8-B EVIDENCE]', JSON.stringify({
      statusAfterFirstPass: first.status,
      statusAfterCauseFixedAndRerun: second.status,
      ingredientOnHand: await onHand(prisma, org.organizationId, ingredient.id, org.mainLocationId),
      expectedIngredientOnHandIfRecovered: 44,
    }));

    // EXPECTED: once the cause is fixed, recovery relieves the stock (50 − 2×3).
    expect(await onHand(prisma, org.organizationId, ingredient.id, org.mainLocationId)).toBe(44);
  }, 300_000);

  // ─────────────────── crash boundaries ───────────────────

  it('Crash C/F: concurrent and repeated processing converge on one outcome', async () => {
    const product = await makeStockProduct('CRASH-CF', 100, 10);
    const { job } = await makeJob([{ productId: product.id, quantity: 7 }]);

    await asOrg(() => Promise.all([
      billing.processStockPostingJob(job.id),
      billing.processStockPostingJob(job.id),
    ]));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(93);

    await asOrg(() => billing.processStockPostingJob(job.id));
    await asOrg(() => billing.processStockPostingJob(job.id));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(93);

    const ledgerRows = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, productId: product.id, type: 'issue' },
    });
    expect(ledgerRows).toBe(1);
  }, 300_000);

  it('Crash D/E: the whole job is one transaction, so a late failure cannot orphan a ledger row', async () => {
    const product = await makeStockProduct('CRASH-DE', 100, 10);
    const { job } = await makeJob([{ productId: product.id, quantity: 9 }]);

    // Force a failure AFTER the stock issue and COGS post, while the job row is
    // being completed. If the boundary is one transaction, everything unwinds.
    const original = (prismaSvc.client as any).stockPostingJob.update;
    let injected = false;
    (prismaSvc.client as any).stockPostingJob.update = async (args: any) => {
      if (!injected && args?.data?.status === 'done') {
        injected = true;
        throw new Error('AUDIT: injected crash at job completion');
      }
      return original.call((prismaSvc.client as any).stockPostingJob, args);
    };

    let threw: string | null = null;
    try {
      await asOrg(() => billing.processStockPostingJob(job.id));
    } catch (e: any) {
      threw = e?.message ?? String(e);
    } finally {
      (prismaSvc.client as any).stockPostingJob.update = original;
    }

    const after = await onHand(prisma, org.organizationId, product.id, org.mainLocationId);
    const rows = await prisma.inventoryLedger.count({
      where: { organizationId: org.organizationId, productId: product.id, type: 'issue' },
    });

    // eslint-disable-next-line no-console
    console.log('[CRASH-DE EVIDENCE]', JSON.stringify({
      injectedFailure: injected, propagated: threw,
      onHandAfterCrash: after, issueLedgerRowsAfterCrash: rows,
    }));

    // Rolled back: stock untouched, no orphan ledger row.
    expect(after).toBe(100);
    expect(rows).toBe(0);

    // And recovery converges on exactly one issue.
    await asOrg(() => billing.processStockPostingJob(job.id));
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(91);
    expect(
      await prisma.inventoryLedger.count({
        where: { organizationId: org.organizationId, productId: product.id, type: 'issue' },
      }),
    ).toBe(1);
  }, 300_000);
});
