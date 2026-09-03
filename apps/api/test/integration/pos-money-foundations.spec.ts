import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { scopedPrisma } from '../scoped-prisma';
import { PaymentService } from '../../src/modules/invoicing/payment/payment.service';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { PostingService } from '../../src/modules/accounting/posting/posting.service';
import { FiscalPeriodService } from '../../src/modules/accounting/posting/fiscal-period.service';
import { AccountResolverService } from '../../src/modules/accounting/posting/account-resolver.service';
import { refundInvoice } from '../../src/modules/pos/billing/refund-operation';
import { accountLedgerBalance, reconcileSession, settleTender } from '../../src/modules/accounting/treasury/session-reconciliation';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';

// Never exercise monetary writes in the developer's business database.
const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL!).pathname);
(isolated ? describe : describe.skip)('Stage 1: real PostgreSQL money paths', () => {
  const org = randomUUID();
  const db = scopedPrisma(new PrismaClient(), () => org);
  let partner: string, cashier: string, session: any;
  const ids: Record<string, string> = {};
  let sequence = 0, ctx: any, payments: PaymentService, cash: CashSessionService, posting: PostingService;
  let client: any;
  const txRun = (fn: (tx: any) => Promise<any>) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`;
    return fn(tx);
  }, { timeout: 20000 });
  const bal = (id: string) => txRun((tx) => accountLedgerBalance(tx, org, id));

  beforeAll(async () => {
    await db.$connect();
    await db.currency.upsert({ where: { code: 'USD' }, update: {}, create: { code: 'USD', name: 'US Dollar', symbol: '$' } });
    await db.organization.create({ data: { id: org, code: `MONEY-${Date.now()}`, name: 'Isolated money regression', currencyCode: 'USD' } });
    cashier = (await db.user.create({ data: { organizationId: org, email: 'cashier@fixture.test', firstName: 'Test Cashier', passwordHash: 'not-a-login' } })).id;
    partner = (await db.partner.create({ data: { organizationId: org, code: 'CUSTOMER', name: 'Money test customer', isCustomer: true } })).id;
    const categories = await ensureAccountCategories(db);
    const mk = makeAccountFactory(db, categories);
    for (const [key, category] of Object.entries({ cash: 'cash', safe: 'cash', bank: 'bank', airtel: 'mobile_money', card: 'current_asset', ar: 'receivable', wrongAR: 'receivable', revenue: 'revenue', credit: 'current_liability', equity: 'equity', fee: 'operating_expense' })) {
      ids[key] = (await mk(org, key.toUpperCase(), key, category as any)).id;
    }
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN']) await db.journal.create({ data: { organizationId: org, code, name: code, journalType: 'general' } });
    const register = await db.cashRegister.create({ data: { organizationId: org, code: 'REGISTER', name: 'Front counter', defaultAccountId: ids.cash } });
    const tenant: any = { organizationId: org, userId: cashier, optionalOrganizationId: org, permissions: ['pos:discount'] };
    client = new Proxy(db, { get(target, prop) { return prop === '$transaction' ? txRun : Reflect.get(target, prop); } });
    const prisma: any = { client, raw: db };
    const events: any = { publish: jest.fn() };
    const audit: any = { recordInTx: jest.fn() };
    const seq: any = { next: jest.fn(async (_key, opts) => `${opts.prefix}${++sequence}`) };
    const determination: any = { mapped: async (key: string) => ({ default_cash: ids.cash, default_bank: ids.bank, card_clearing: ids.card, mobile_money: ids.airtel, store_credit: ids.credit, cash_over_short: ids.fee } as any)[key], receivableAccount: async () => ids.wrongAR, payableAccount: async () => ids.wrongAR };
    posting = new PostingService(prisma, tenant, events, seq, new FiscalPeriodService(prisma, tenant), {} as any, new AccountResolverService(prisma, tenant));
    cash = new CashSessionService(prisma, tenant, events, audit, {} as any, posting, determination);
    payments = new PaymentService(prisma, tenant, events, seq, posting, determination, cash, {} as any, audit, {} as any);
    ctx = { prisma, tenant, posting, payments, audit, overrides: { verifyOperationApproval: jest.fn() }, closeOrderForInvoice: jest.fn().mockResolvedValue(null), stock: { receiveReturn: jest.fn() } };
    await txRun((tx) => posting.post({ journalCode: 'GEN', date: new Date(), lines: [{ accountId: ids.safe, debit: '1000' }, { accountId: ids.equity, credit: '1000' }] }, tx));
    session = await cash.open({ cashRegisterId: register.id, openingFloat: 100, openingSourceAccountId: ids.safe, notes: 'Counted float from safe' });
  }, 30000);

  afterAll(async () => { await db.$disconnect(); }); // Evidence retained only in the disposable isolated database.

  async function invoice(total: number, quantity = 1, withSession = true) {
    return txRun(async (tx) => {
      const inv = await tx.invoice.create({ data: { organizationId: org, invoiceNumber: `SALE-${++sequence}`, partnerId: partner, cashSessionId: withSession ? session.id : null, subtotal: total, totalAmount: total, amountResidual: total, status: 'posted', receivableAccountId: ids.ar, items: { create: { organizationId: org, description: 'Widget', quantity, unitPrice: total / quantity, subtotal: total, total, accountId: ids.revenue } } }, include: { items: true } });
      const je = await posting.post({ journalCode: 'SALES', date: new Date(), sourceType: 'pos_invoice', sourceId: inv.id, lines: [{ accountId: ids.ar, debit: String(total), partnerId: partner }, { accountId: ids.revenue, credit: String(total) }] }, tx);
      await tx.invoice.update({ where: { id: inv.id }, data: { journalEntryId: je.id } });
      return inv;
    });
  }
  const pay = (inv: any, method: string, amount: number, withSession = true) => payments.createReceipt({ partnerId: partner, paymentDate: new Date().toISOString(), paymentMethod: method as any, amount, cashSessionId: withSession ? session.id : undefined, allocations: [{ invoiceId: inv.id, amount }] });
  const refund = (inv: any, lines?: any[]) => refundInvoice(ctx, inv.id, 'Customer return', { overrideById: 'fixture-manager', stockDisposition: 'no_return', cashSessionId: session.id, lines });

  it('funds the counted float with an actual safe-to-drawer entry', async () => {
    expect((await bal(ids.cash)).toString()).toBe('100');
    expect((await bal(ids.safe)).toString()).toBe('900');
  });

  it('routes cash, card and Airtel to separate accounts and clears the ORIGINAL AR', async () => {
    for (const [method, account] of [['cash', 'cash'], ['card', 'card'], ['mobile_money', 'airtel']]) {
      const inv = await invoice(30);
      const receipt: any = await pay(inv, method, 30);
      expect(receipt.accountId).toBe(ids[account]);
      expect((await db.cashMovement.count({ where: { paymentId: receipt.id } }))).toBe(method === 'cash' ? 1 : 0);
    }
    expect((await bal(ids.cash)).toString()).toBe('130');
    expect((await bal(ids.ar)).toString()).toBe('0');
    expect((await bal(ids.wrongAR)).toString()).toBe('0');
    const check = await txRun((tx) => reconcileSession(tx, org, session));
    expect(check.issues).toEqual([]);
    expect(check.report.totals.expectedCash).toBe('130');
  });

  it('permits only one of two concurrent redemptions when balance covers one', async () => {
    await db.storeCredit.create({ data: { organizationId: org, partnerId: partner, balance: 15 } });
    await txRun((tx) => posting.post({ journalCode: 'GEN', date: new Date(), lines: [{ accountId: ids.bank, debit: '15' }, { accountId: ids.credit, credit: '15' }] }, tx));
    const a = await invoice(10, 1, false), b = await invoice(10, 1, false);
    const outcomes = await Promise.allSettled([pay(a, 'store_credit', 10, false), pay(b, 'store_credit', 10, false)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    const credit = await db.storeCredit.findFirstOrThrow({ where: { organizationId: org, partnerId: partner } });
    expect(credit.balance.toString()).toBe('5');
    const winner = outcomes[0].status === 'fulfilled' ? a : b;
    await refund(winner);
    expect((await db.storeCredit.findUniqueOrThrow({ where: { id: credit.id } })).balance.toString()).toBe('15');
    expect(await db.storeCreditLedger.count({ where: { organizationId: org } })).toBe(2);
  });

  it('rejects duplicate/negative refund lines without writes, then supports partial → remaining full refund', async () => {
    const inv = await invoice(100, 2);
    const cashReceipt: any = await pay(inv, 'cash', 60);
    const cardReceipt: any = await pay(inv, 'card', 40);
    const lineId = inv.items[0].id;
    const before = await txRun((tx) => tx.posRefund.count({ where: { invoiceId: inv.id } }));
    await expect(refund(inv, [{ lineId, quantity: 1 }, { lineId, quantity: 1 }])).rejects.toThrow('Duplicate');
    await expect(refund(inv, [{ lineId, quantity: -1 }])).rejects.toThrow('quantity');
    expect(await txRun((tx) => tx.posRefund.count({ where: { invoiceId: inv.id } }))).toBe(before);
    const partial = await refund(inv, [{ lineId, quantity: 1 }]);
    expect(partial.amountReturned).toBe('50');
    const final = await refund(inv);
    expect(final.amountReturned).toBe('50');
    expect((await db.payment.findUniqueOrThrow({ where: { id: cashReceipt.id } })).refundedAmount.toString()).toBe('60');
    expect((await db.payment.findUniqueOrThrow({ where: { id: cardReceipt.id } })).refundedAmount.toString()).toBe('40');
    expect(ctx.stock.receiveReturn).not.toHaveBeenCalled();
    await expect(refund(inv)).rejects.toThrow('cannot be refunded');
  });

  it('records provider fees and rejects a settlement larger than the source receipts', async () => {
    const beforeBank = await bal(ids.bank);
    await settleTender(ctx, { cashSessionId: session.id, sourceAccountId: ids.airtel, destinationAccountId: ids.bank, grossAmount: 30, feeAmount: 2, feeAccountId: ids.fee, reference: 'AIRTEL-STATEMENT-1', settledAt: new Date().toISOString() });
    expect((await bal(ids.airtel)).toString()).toBe('0');
    expect((await bal(ids.bank)).minus(beforeBank).toString()).toBe('28');
    expect((await bal(ids.fee)).toString()).toBe('2');
    await expect(settleTender(ctx, { cashSessionId: session.id, sourceAccountId: ids.airtel, destinationAccountId: ids.bank, grossAmount: 1, reference: 'DUPLICATE-DIFFERENT-REF', settledAt: new Date().toISOString() })).rejects.toThrow('exceeds');
  });

  it('closes against drawer cash rather than total sales and freezes the report', async () => {
    const check = await txRun((tx) => reconcileSession(tx, org, session));
    expect(check.issues).toEqual([]);
    const closed: any = await cash.close({ sessionId: session.id, closingCounted: 130 });
    expect(closed.status).toBe('closed');
    const snapshot = await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } });
    expect((snapshot.reportData as any).totals.expectedCash).toBe('130');
    const extra = await invoice(5, 1, false);
    await expect(pay(extra, 'cash', 5)).rejects.toThrow(/closed|unavailable/);
    expect((await bal(ids.cash)).toString()).toBe('130');
  });
  it('settles a provider after cash reconciliation without changing the frozen Z-report', async () => {
    const snapshot = await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } });
    await db.accountMapping.create({ data: { organizationId: org, key: 'card_clearing', accountId: ids.card } });
    ctx.tenant.userId = 'independent-reviewer';
    await cash.reconcile(session.id, {});
    const before = await bal(ids.bank);
    await settleTender(ctx, { cashSessionId: session.id, sourceAccountId: ids.card, destinationAccountId: ids.bank, grossAmount: 30, reference: 'LATE-CARD-STATEMENT', settledAt: new Date().toISOString() });
    expect((await bal(ids.bank)).minus(before).toString()).toBe('30');
    expect((await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } })).reportData).toEqual(snapshot.reportData);
  });

});
