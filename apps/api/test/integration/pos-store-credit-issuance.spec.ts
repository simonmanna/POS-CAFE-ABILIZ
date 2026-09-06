/**
 * A-001 / A-100 regression (POS-CAFE-PHASE14 Wave 0).
 *
 * Store-credit issuance must be:
 *   - forbidden to a cashier (pos:override gate)
 *   - disabled when pos.storeCreditIssueLimit = 0 (default)
 *   - capped at the configured limit
 *   - funded: a funding journal (Dr funding / Cr store-credit liability) is
 *     posted in the same transaction, and unfunded issuance is rejected
 *   - audited (AuditLog row in the same transaction)
 *   - notes must not 500 (A-100)
 *
 * Runs against the disposable stage-1 database (same pattern as the other
 * integration specs) â€” skipped when DATABASE_URL is not a pos_stage1_* DB.
 */
import { PosLoyaltyService } from '../../src/modules/pos/pos-loyalty.service';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { AuditService } from '../../src/kernel/audit/audit.service';
import { PostingService } from '../../src/modules/accounting/posting/posting.service';
import { AccountDeterminationService } from '../../src/modules/accounting/posting/account-determination.service';
import { SettingResolverService } from '../../src/kernel/settings/setting-resolver.service';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { KernelModule } from '../../src/kernel/kernel.module';
import { AccountingModule } from '../../src/modules/accounting/accounting.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { CoreModule } from '../../src/modules/core/core.module';
import { scopedPrisma } from '../scoped-prisma';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';

const describeDb = process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname) ? describe : describe.skip;

describeDb('A-001: store-credit issuance is gated, capped, funded and audited', () => {
  let prismaClient: PrismaClient;
  let scoped: any;
  let svc: PosLoyaltyService;
  let moduleRef: TestingModule;
  let organizationId: string;
  let customerId: string;
  let bankAccount: any;
  let expenseAccount: any;
  let storeCreditLiabilityId: string;
  let runAsManager: (fn: () => Promise<any>) => Promise<any>;

  beforeAll(async () => {
    prismaClient = new PrismaClient();
    await prismaClient.$connect();
    organizationId = randomUUID();
    // RLS-scoped client (same tenant GUC discipline the app uses). The GUC is
    // set from organizationId() on every operation â€” including the fixture
    // creates below â€” so RLS sees the new org id from the first insert.
    scoped = scopedPrisma(prismaClient, () => organizationId);

    await scoped.organization.create({
      data: { id: organizationId, code: `A001-${Date.now()}`, name: 'A-001 Org', currencyCode: 'UGX' },
    });

    const mk = makeAccountFactory(scoped as any, await ensureAccountCategories(scoped as any));
    const ar = await mk(organizationId, 'A001-1300', 'AR', 'receivable');
    const rev = await mk(organizationId, 'A001-4100', 'Revenue', 'revenue');
    bankAccount = await mk(organizationId, 'A001-1200', 'Bank', 'bank');
    expenseAccount = await mk(organizationId, 'A001-5200', 'Promo Expense', 'operating_expense');
    const liability = await mk(organizationId, 'A001-2350', 'Store Credit Liability', 'current_liability');
    storeCreditLiabilityId = liability.id;
    for (const [key, accountId] of [
      ['accounts_receivable', ar.id], ['sales_revenue', rev.id], ['default_bank', bankAccount.id], ['store_credit', liability.id],
    ] as const) {
      await scoped.accountMapping.create({ data: { organizationId, key, accountId } });
    }
    for (const [code, name, type] of [['GEN', 'General', 'general'], ['BANK', 'Bank', 'bank'], ['SALES', 'Sales', 'sales'], ['CASH', 'Cash', 'cash']] as const) {
      await scoped.journal.create({ data: { organizationId, code, name, journalType: type } });
    }
    customerId = (await scoped.partner.create({ data: { organizationId, code: 'A001-CUST', name: 'A-001 Cust', isCustomer: true } })).id;

    moduleRef = await Test.createTestingModule({ imports: [KernelModule, CoreModule, DocumentsModule, AccountingModule] })
      .overrideProvider(PrismaService)
      .useValue({ client: scoped, raw: scoped })
      .compile();
    await moduleRef.init();
    const tenantCtx = moduleRef.get(TenantContextService);
    // Issue inside a real tenant.run so the settings resolver, posting service
    // and audit service all see organizationId/userId exactly like production.
    svc = new PosLoyaltyService(
      moduleRef.get(PrismaService),
      tenantCtx,
      moduleRef.get(AuditService),
      moduleRef.get(PostingService),
      moduleRef.get(AccountDeterminationService),
      moduleRef.get(SettingResolverService),
    );
    runAsManager = (fn: () => Promise<any>) =>
      tenantCtx.run({ organizationId, userId: 'manager-1', permissions: ['pos:override'] }, fn);
  }, 120_000);

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
    await prismaClient.$disconnect();
  });

  beforeEach(async () => {
    // Clean slate per test: remove credit rows and GL for this org, and drop
    // the settings-resolver cache so each case sees its own cap row.
    await scoped.storeCreditLedger.deleteMany({ where: { organizationId } });
    await scoped.storeCredit.deleteMany({ where: { organizationId } });
    await scoped.journalLine.deleteMany({ where: { organizationId } });
    await scoped.journalEntry.deleteMany({ where: { organizationId } });
    await scoped.auditLog.deleteMany({ where: { organizationId } });
    await scoped.setting.deleteMany({ where: { organizationId, key: 'pos.storeCreditIssueLimit' } });
    moduleRef.get(SettingResolverService).invalidate(organizationId);
  });

  it('rejects issuance when the org cap is unset (default 0 = disabled)', async () => {
    await expect(
      runAsManager(() => svc.issueCredit({ partnerId: customerId, amount: 10_000, source: 'gift_card', fundingAccountId: bankAccount.id })),
    ).rejects.toThrow(/disabled/i);
  });

  it('rejects issuance above the configured cap', async () => {
    await scoped.setting.create({
      data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.storeCreditIssueLimit', value: 50_000 as any },
    });
    await expect(
      runAsManager(() => svc.issueCredit({ partnerId: customerId, amount: 60_000, source: 'gift_card', fundingAccountId: bankAccount.id })),
    ).rejects.toThrow(/exceeds the configured limit/i);
  });

  it('rejects issuance without a funding account', async () => {
    await scoped.setting.create({
      data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.storeCreditIssueLimit', value: 50_000 as any },
    });
    await expect(
      runAsManager(() => svc.issueCredit({ partnerId: customerId, amount: 10_000, source: 'gift_card', fundingAccountId: undefined as any })),
    ).rejects.toThrow(/funding/i);
  });

  it('issues WITH funding GL + ledger + audit when within the cap (and notes do not 500 â€” A-100)', async () => {
    await scoped.setting.create({
      data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.storeCreditIssueLimit', value: 50_000 as any },
    });
    const res = await runAsManager(() => svc.issueCredit({
      partnerId: customerId, amount: 10_000, source: 'gift_card',
      fundingAccountId: expenseAccount.id, notes: 'A-100 notes must not crash',
    }));
    expect(Number(res.balance)).toBe(10_000);

    // Funding journal: Dr expense / Cr store-credit liability, balanced, linked.
    const entry = await scoped.journalEntry.findFirst({
      where: { organizationId, sourceType: 'store_credit_issue' },
      include: { lines: true },
    });
    expect(entry).toBeTruthy();
    expect(entry!.status).toBe('posted');
    const dr = entry!.lines.find((l: any) => l.debit > 0);
    const cr = entry!.lines.find((l: any) => l.credit > 0);
    expect(dr!.accountId).toBe(expenseAccount.id);
    expect(cr!.accountId).toBe(storeCreditLiabilityId);
    expect(Number(dr!.debit)).toBe(10_000);
    expect(Number(cr!.credit)).toBe(10_000);

    // Ledger row + balance.
    const credit = await scoped.storeCredit.findFirst({ where: { organizationId, partnerId: customerId } });
    expect(Number(credit!.balance)).toBe(10_000);
    const ledger = await scoped.storeCreditLedger.findFirst({ where: { organizationId } });
    expect(Number(ledger!.delta)).toBe(10_000);

    // Audit row, same org.
    const audit = await scoped.auditLog.findFirst({ where: { organizationId, entity: 'StoreCredit', action: 'issue' } });
    expect(audit).toBeTruthy();
  });

  it('refuses to fund credit from a cash drawer account', async () => {
    await scoped.setting.create({
      data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.storeCreditIssueLimit', value: 50_000 as any },
    });
    const cat = await ensureAccountCategories(scoped as any);
    const mk = makeAccountFactory(scoped as any, cat);
    const drawer = await mk(organizationId, 'A001-1101', 'Drawer', 'cash');
    await scoped.cashRegister.create({
      data: { organizationId, code: 'A001-REG', name: 'A-001 Till', defaultAccountId: drawer.id },
    });
    await expect(
      runAsManager(() => svc.issueCredit({ partnerId: customerId, amount: 10_000, source: 'gift_card', fundingAccountId: drawer.id })),
    ).rejects.toThrow(/drawer/i);
  });
});
