import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { scopedPrisma } from '../scoped-prisma';
import { PaymentService } from '../../src/modules/invoicing/payment/payment.service';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { PostingService } from '../../src/modules/accounting/posting/posting.service';
import { FiscalPeriodService } from '../../src/modules/accounting/posting/fiscal-period.service';
import { AccountResolverService } from '../../src/modules/accounting/posting/account-resolver.service';
import { reconcileSession, settleTender } from '../../src/modules/accounting/treasury/session-reconciliation';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';

/**
 * Shift close gates:
 *  - a wallet is compared with THIS shift's expectation, never the all-time GL
 *    balance still carrying earlier shifts' unswept receipts;
 *  - every held order in the organization blocks the close, including orders
 *    that carry no cashSessionId (waiter tablets, Android, earlier shifts).
 */
const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL!).pathname);
(isolated ? describe : describe.skip)('Stage 1: shift close gates', () => {
  const org = randomUUID();
  const db = scopedPrisma(new PrismaClient(), () => org);
  let partner: string, cashier: string, session: any;
  const ids: Record<string, string> = {};
  let sequence = 0, ctx: any, payments: PaymentService, cash: CashSessionService, posting: PostingService;
  const txRun = (fn: (tx: any) => Promise<any>) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`;
    return fn(tx);
  }, { timeout: 20000 });
  const body = async (p: Promise<any>) => {
    try { await p; } catch (e: any) { return typeof e.getResponse === 'function' ? e.getResponse() : { message: e.message }; }
    throw new Error('expected the close to be refused');
  };

  beforeAll(async () => {
    await db.$connect();
    await db.currency.upsert({ where: { code: 'USD' }, update: {}, create: { code: 'USD', name: 'US Dollar', symbol: '$' } });
    await db.organization.create({ data: { id: org, code: `CLOSE-${Date.now()}`, name: 'Isolated close gates', currencyCode: 'USD' } });
    cashier = (await db.user.create({ data: { organizationId: org, email: 'cashier@close.test', firstName: 'Cashier', passwordHash: 'not-a-login' } })).id;
    partner = (await db.partner.create({ data: { organizationId: org, code: 'CUSTOMER', name: 'Close test customer', isCustomer: true } })).id;
    const categories = await ensureAccountCategories(db);
    const mk = makeAccountFactory(db, categories);
    for (const [key, category] of Object.entries({ cash: 'cash', safe: 'cash', bank: 'bank', momo: 'mobile_money', ar: 'receivable', revenue: 'revenue', equity: 'equity', fee: 'operating_expense' })) {
      ids[key] = (await mk(org, key.toUpperCase(), key, category as any)).id;
    }
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN']) await db.journal.create({ data: { organizationId: org, code, name: code, journalType: 'general' } });
    const register = await db.cashRegister.create({ data: { organizationId: org, code: 'REGISTER', name: 'Front counter', defaultAccountId: ids.cash } });
    const tenant: any = { organizationId: org, userId: cashier, optionalOrganizationId: org, permissions: [] };
    const client = new Proxy(db, { get(target, prop) { return prop === '$transaction' ? txRun : Reflect.get(target, prop); } });
    const prisma: any = { client, raw: db };
    const events: any = { publish: jest.fn() };
    const audit: any = { recordInTx: jest.fn() };
    const seq: any = { next: jest.fn(async (_key, opts) => `${opts.prefix}${++sequence}`) };
    const determination: any = { mapped: async (key: string) => ({ default_cash: ids.cash, default_bank: ids.bank, mobile_money: ids.momo, cash_over_short: ids.fee } as any)[key], receivableAccount: async () => ids.ar, payableAccount: async () => ids.ar };
    posting = new PostingService(prisma, tenant, events, seq, new FiscalPeriodService(prisma, tenant), {} as any, new AccountResolverService(prisma, tenant));
    cash = new CashSessionService(prisma, tenant, events, audit, {} as any, posting, determination);
    payments = new PaymentService(prisma, tenant, events, seq, posting, determination, cash, {} as any, audit, {} as any);
    ctx = { prisma, tenant, posting, audit };
    await txRun((tx) => posting.post({ journalCode: 'GEN', date: new Date(), lines: [{ accountId: ids.safe, debit: '1000' }, { accountId: ids.equity, credit: '1000' }] }, tx));
    // Earlier shifts left 50,000 on the wallet that nobody swept to the bank.
    await txRun((tx) => posting.post({ journalCode: 'GEN', date: new Date(), lines: [{ accountId: ids.momo, debit: '50000' }, { accountId: ids.revenue, credit: '50000' }] }, tx));
    session = await cash.open({ cashRegisterId: register.id, openingFloat: 100, openingSourceAccountId: ids.safe, notes: 'Float from safe' });
    // The tracked wallet/bank accounts the terminal asks the cashier to count.
    for (const [code, account, kind] of [['momo', ids.momo, 'mobile_money'], ['bank', ids.bank, 'bank']] as const) {
      await db.posPaymentMethod.create({ data: { organizationId: org, code, label: code.toUpperCase(), kind: kind as any, accountId: account, trackInShift: true, isActive: true } as any });
    }
    const inv = await txRun(async (tx) => {
      const row = await tx.invoice.create({ data: { organizationId: org, invoiceNumber: `SALE-${++sequence}`, partnerId: partner, cashSessionId: session.id, subtotal: 10000, totalAmount: 10000, amountResidual: 10000, status: 'posted', receivableAccountId: ids.ar, items: { create: { organizationId: org, description: 'Coffee', quantity: 1, unitPrice: 10000, subtotal: 10000, total: 10000, accountId: ids.revenue } } } });
      const je = await posting.post({ journalCode: 'SALES', date: new Date(), sourceType: 'pos_invoice', sourceId: row.id, lines: [{ accountId: ids.ar, debit: '10000', partnerId: partner }, { accountId: ids.revenue, credit: '10000' }] }, tx);
      return tx.invoice.update({ where: { id: row.id }, data: { journalEntryId: je.id } });
    });
    await payments.createReceipt({ partnerId: partner, paymentDate: new Date().toISOString(), paymentMethod: 'mobile_money' as any, amount: 10000, cashSessionId: session.id, allocations: [{ invoiceId: inv.id, amount: 10000 }] });
  }, 60000);

  afterAll(async () => { await db.$disconnect(); });

  const heldOrder = (opts: { cancelledOnly?: boolean; invoiced?: boolean } = {}) => txRun(async (tx) => tx.order.create({
    data: {
      organizationId: org, orderNumber: `ORD-${++sequence}`, orderType: 'dine_in', status: 'confirmed', cashSessionId: null,
      ...(opts.invoiced ? { invoiceId: (await tx.invoice.findFirst({ where: { organizationId: org } })).id } : {}),
      totalAmount: 4500,
      items: { create: { organizationId: org, description: 'Tea', quantity: 1, unitPrice: 4500, cancelled: !!opts.cancelledOnly } },
    } as any,
  }));

  it('previews the wallet expectation from this shift, not the 60,000 GL balance', async () => {
    const check: any = await txRun((tx) => reconcileSession(tx, org, session));
    const momo = check.accounts.find((a: any) => a.accountId === ids.momo);
    const bank = check.accounts.find((a: any) => a.accountId === ids.bank);
    expect(momo).toMatchObject({ expected: '10000', openingKnown: false });
    expect(bank).toMatchObject({ expected: '0', tracked: true });
  });

  it('refuses a real wallet difference with a structured code', async () => {
    const res: any = await body(cash.close({ sessionId: session.id, closingCounted: 100, closingAccounts: { [ids.momo]: 9000, [ids.bank]: 0 } }));
    expect(res.code).toBe('PROVIDER_BALANCE_VARIANCE');
    expect(res.accounts).toEqual([expect.objectContaining({ accountId: ids.momo, expected: '10000', observed: '9000', difference: '-1000' })]);
  });

  it('blocks on every held order in the org, counting beyond the display limit', async () => {
    for (let i = 0; i < 51; i++) await heldOrder();
    await heldOrder({ cancelledOnly: true });
    await heldOrder({ invoiced: true });
    const res: any = await body(cash.close({ sessionId: session.id, closingCounted: 100, closingAccounts: { [ids.momo]: 10000, [ids.bank]: 0 } }));
    expect(res.code).toBe('OPEN_ORDERS');
    expect(res.openOrderCount).toBe(51);
    expect(res.openOrders).toHaveLength(50);
    await db.order.updateMany({ where: { organizationId: org, status: 'confirmed' }, data: { status: 'cancelled' } });
  });

  it('closes once orders are cleared, with a settlement swept out during the shift', async () => {
    await settleTender(ctx, { cashSessionId: session.id, sourceAccountId: ids.momo, destinationAccountId: ids.bank, grossAmount: 5000, feeAmount: 0, reference: 'MOMO-SWEEP-1', settledAt: new Date().toISOString() });
    // Wallet 10,000 − 5,000 swept; bank 0 + 5,000 received.
    const refused: any = await body(cash.close({ sessionId: session.id, closingCounted: 100, closingAccounts: { [ids.momo]: 10000, [ids.bank]: 5000 } }));
    expect(refused.code).toBe('PROVIDER_BALANCE_VARIANCE');
    const closed: any = await cash.close({ sessionId: session.id, closingCounted: 100, closingAccounts: { [ids.momo]: 5000, [ids.bank]: 5000 } });
    expect(closed.status).toBe('closed');
    const momo = (closed.closingAccounts as any)[ids.momo];
    expect(momo).toMatchObject({ expected: '5000', observed: '5000', difference: '0', ledger: '55000' });
  });
});
