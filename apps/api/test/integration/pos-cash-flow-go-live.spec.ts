/**
 * Cash-flow go-live regression suite (re-audit 2026-09-13).
 *
 * Every assertion here maps to a production-readiness finding and runs against
 * real PostgreSQL (triggers, row locks, unique keys) — never the business
 * database: the suite only runs on a disposable `pos_stage1_<digits>` database.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { scopedPrisma } from '../scoped-prisma';
import { CashSessionService } from '../../src/modules/accounting/treasury/cash-session.service';
import { CashFlowService } from '../../src/modules/accounting/treasury/cash-flow.service';
import { TreasuryService } from '../../src/modules/accounting/treasury/treasury.service';
import { CashRegisterService } from '../../src/modules/accounting/treasury/cash-register.service';
import { PaymentService } from '../../src/modules/invoicing/payment/payment.service';
import { ExpensesService } from '../../src/modules/expenses/expenses.service';
import { PostingService } from '../../src/modules/accounting/posting/posting.service';
import { FiscalPeriodService } from '../../src/modules/accounting/posting/fiscal-period.service';
import { AccountResolverService } from '../../src/modules/accounting/posting/account-resolver.service';
import { IdempotencyService } from '../../src/kernel/idempotency/idempotency.service';
import { accountLedgerBalance, reconcileSession } from '../../src/modules/accounting/treasury/session-reconciliation';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';

const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL!).pathname);

(isolated ? describe : describe.skip)('Cash flow go-live: real PostgreSQL controls', () => {
  const org = randomUUID();
  const raw = new PrismaClient();
  const db = scopedPrisma(raw, () => org);
  const ids: Record<string, string> = {};
  const users: Record<string, string> = {};
  let sequence = 0;
  let tenant: any;
  let client: any;
  let posting: PostingService;
  let cash: CashSessionService;
  let cashFlow: CashFlowService;
  let treasury: TreasuryService;
  let registers: CashRegisterService;
  let payments: PaymentService;
  let expenses: ExpensesService;
  let idempotency: IdempotencyService;
  let registerId: string;
  let session: any;

  const txRun = (fn: (tx: any) => Promise<any>) => db.$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`;
    return fn(tx);
  }, { timeout: 30000 });
  const bal = async (id: string) => (await txRun((tx) => accountLedgerBalance(tx, org, id))).toString();
  const as = (userId: string, permissions: string[] = []) => { tenant.userId = userId; tenant.permissions = permissions; };
  const sqlError = async (sql: string, ...params: any[]) => {
    try { await txRun((tx) => tx.$executeRawUnsafe(sql, ...params)); return null; } catch (e: any) { return String(e.message); }
  };

  beforeAll(async () => {
    await raw.$connect();
    await db.currency.upsert({ where: { code: 'USD' }, update: {}, create: { code: 'USD', name: 'US Dollar', symbol: '$' } });
    await db.organization.create({ data: { id: org, code: `GOLIVE-${Date.now()}`, name: 'Cash flow go-live', currencyCode: 'USD' } });
    const role = await db.role.create({ data: { organizationId: org, name: 'Manager', permissions: ['cash_session:approve_variance', 'cash_session:force_close', 'cash_session:correct', 'cash_session:reconcile', 'cash_session:cash_out'] } });
    for (const name of ['cashier', 'cashier2', 'manager']) {
      users[name] = (await db.user.create({ data: { organizationId: org, email: `${name}@golive.test`, firstName: name, passwordHash: 'x', pinHash: '4321', ...(name === 'manager' ? { roles: { connect: { id: role.id } } } : {}) } })).id;
    }
    ids.partner = (await db.partner.create({ data: { organizationId: org, code: 'SUP', name: 'Supplier', isSupplier: true, isCustomer: true } })).id;
    const mk = makeAccountFactory(db, await ensureAccountCategories(db));
    for (const [key, category] of Object.entries({
      drawer: 'cash', drawer2: 'cash', safe: 'cash', bank: 'bank', airtel: 'mobile_money', ar: 'receivable', ap: 'payable',
      revenue: 'revenue', equity: 'equity', expense: 'operating_expense', shortOver: 'operating_expense', wht: 'current_liability', loan: 'current_liability',
    })) ids[key] = (await mk(org, key.toUpperCase(), key, category as any)).id;
    for (const code of ['SALES', 'CASH', 'BANK', 'GEN']) await db.journal.create({ data: { organizationId: org, code, name: code, journalType: 'general' } });
    await db.posPaymentMethod.create({ data: { organizationId: org, code: 'airtel', label: 'Airtel Money', kind: 'mobile_money', accountId: ids.airtel, trackInShift: true } });
    registerId = (await db.cashRegister.create({ data: { organizationId: org, code: 'R1', name: 'Front', defaultAccountId: ids.drawer } })).id;

    tenant = { organizationId: org, optionalOrganizationId: org, userId: users.cashier, permissions: [] as string[], has(p: string) { return this.permissions.includes(p); } };
    client = new Proxy(db, { get(target, prop) { return prop === '$transaction' ? txRun : Reflect.get(target, prop); } });
    const prisma: any = { client, raw: db };
    const events: any = { publish: jest.fn() };
    const audit: any = { recordInTx: jest.fn(), record: jest.fn() };
    const seq: any = { next: jest.fn(async (_key: string, opts: any) => `${opts.prefix}${++sequence}`) };
    const determination: any = {
      mapped: async (key: string) => ({ default_cash: ids.drawer, default_bank: ids.bank, cash_short_over: ids.shortOver, withholding_payable: ids.wht } as any)[key],
      receivableAccount: async () => ids.ar,
      payableAccount: async () => ids.ap,
    };
    const password: any = { compare: async (pin: string, hash: string) => pin === hash };
    const resolver = new AccountResolverService(prisma, tenant);
    posting = new PostingService(prisma, tenant, events, seq, new FiscalPeriodService(prisma, tenant), {} as any, resolver);
    cash = new CashSessionService(prisma, tenant, events, audit, password, posting, determination);
    cashFlow = new CashFlowService(prisma, tenant, posting, resolver, audit);
    treasury = new TreasuryService(tenant, events, posting, prisma, audit);
    registers = new CashRegisterService(prisma, tenant);
    payments = new PaymentService(prisma, tenant, events, seq, posting, determination, cash, {} as any, audit, { checkOrRequestApproval: async () => null } as any);
    expenses = new ExpensesService(prisma, tenant, events, seq, audit, { checkOrRequestApproval: async () => null } as any, posting);
    idempotency = new IdempotencyService(prisma, tenant);

    await txRun((tx) => posting.post({ journalCode: 'GEN', date: new Date(), lines: [{ accountId: ids.safe, debit: '1000' }, { accountId: ids.equity, credit: '1000' }] }, tx));
    as(users.cashier);
    session = await cash.open({ cashRegisterId: registerId, openingFloat: 200, openingSourceAccountId: ids.safe, notes: 'Float from safe' });
  }, 60000);

  afterAll(async () => { await raw.$disconnect(); }); // evidence stays in the disposable database

  describe('P0-4 posted evidence is append-only at the database', () => {
    it('refuses to rewrite or delete drawer movements, closed shifts, Z reports and posted journals', async () => {
      const opening = await db.journalEntry.findFirstOrThrow({ where: { organizationId: org, sourceType: 'cash_session_opening' }, include: { lines: true } });
      expect(await sqlError('UPDATE "JournalLine" SET debit = debit + 1 WHERE id = $1', opening.lines[0].id)).toMatch(/posted journal/i);
      expect(await sqlError('DELETE FROM "JournalEntry" WHERE id = $1', opening.id)).toMatch(/cannot be deleted/i);
      expect(await sqlError('UPDATE "CashSession" SET "openingFloat" = 0 WHERE id = $1', session.id)).toMatch(/cannot change/i);
      expect(await sqlError('DELETE FROM "CashSession" WHERE id = $1', session.id)).toMatch(/cannot be deleted/i);
    });
  });

  describe('P0-5 / N-03 / N-04 treasury operations', () => {
    it('rejects a counterpart outside the operation type and never touches a register drawer', async () => {
      as(users.manager, ['treasury:transfer']);
      await expect(cashFlow.deposit({ accountId: ids.bank, counterpartAccountId: ids.revenue, operationType: 'owner_contribution', amount: 50, description: 'x' })).rejects.toThrow(/equity/);
      await expect(cashFlow.deposit({ accountId: ids.drawer, counterpartAccountId: ids.equity, operationType: 'owner_contribution', amount: 50, description: 'x' })).rejects.toThrow(/drawer account/);
      await expect(cashFlow.deposit({ accountId: ids.bank, counterpartAccountId: ids.safe, operationType: 'owner_contribution', amount: 50, description: 'x' })).rejects.toThrow(/transfer/);
      await expect(treasury.transfer({ fromAccountId: ids.safe, toAccountId: ids.drawer, amount: 10, date: new Date().toISOString() } as any)).rejects.toThrow(/drawer account/);
      const entry = await cashFlow.deposit({ accountId: ids.bank, counterpartAccountId: ids.equity, operationType: 'owner_contribution', amount: 500, description: 'Capital' });
      expect(entry.postingKey).toMatch(/^cash-flow:deposit:/);
      expect(await bal(ids.bank)).toBe('500');
    });

    it('two concurrent withdrawals of the whole balance: exactly one posts, the account never goes negative', async () => {
      const outcomes = await Promise.allSettled([
        cashFlow.withdraw({ accountId: ids.bank, counterpartAccountId: ids.equity, operationType: 'owner_drawing', amount: 500, description: 'A' }),
        cashFlow.withdraw({ accountId: ids.bank, counterpartAccountId: ids.equity, operationType: 'owner_drawing', amount: 500, description: 'B' }),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((o) => o.status === 'rejected')!.reason.message).toMatch(/insufficient/i);
      expect(await bal(ids.bank)).toBe('0');
    });

    it('a retried request with the same key posts once; a reused key with a different body is refused', async () => {
      const key = `deposit-${randomUUID()}`;
      const path = '/api/v1/accounts/cash-flow/deposit';
      const body = { accountId: ids.bank, counterpartAccountId: ids.loan, operationType: 'loan_received', amount: 300, description: 'Loan' };
      const run = () => idempotency.executeWithKey({ key, path, requestHash: 'hash-a', runHandler: async () => ({ statusCode: 201, body: await cashFlow.deposit(body) }) });
      const first = await run();
      const retry = await run(); // the client never saw the first response
      expect(retry.replayed).toBe(true);
      expect(await db.journalEntry.count({ where: { organizationId: org, sourceType: 'cash_flow_deposit', description: { contains: 'Loan' } } })).toBe(1);
      expect((retry.body as any).id).toBe((first.body as any).id);
      await expect(idempotency.executeWithKey({ key, path, requestHash: 'hash-b', runHandler: async () => ({ statusCode: 201, body: {} }) })).rejects.toThrow(/different request/);
      expect(await bal(ids.bank)).toBe('300');
    });

    it('an abandoned attempt that committed nothing is re-run instead of wedging the key forever', async () => {
      const key = `abandoned-${randomUUID()}`;
      await db.idempotencyRecord.create({ data: { organizationId: org, key, requestHash: 'h', method: 'POST', path: '/api/v1/treasury/transfer', statusCode: 0, responseJson: {}, status: 'pending', createdAt: new Date(Date.now() - 10 * 60_000) } });
      const out = await idempotency.executeWithKey({ key, path: '/api/v1/treasury/transfer', requestHash: 'h', runHandler: async () => ({ statusCode: 201, body: await treasury.transfer({ fromAccountId: ids.bank, toAccountId: ids.airtel, amount: 100, date: new Date().toISOString() } as any) }) });
      expect(out.replayed).toBe(false);
      expect(await bal(ids.airtel)).toBe('100');
    });
  });

  describe('N-01 / N-02 expenses', () => {
    let categoryId: string;
    beforeAll(async () => {
      categoryId = (await db.expenseCategory.create({ data: { organizationId: org, name: 'Supplies', ledgerAccountId: ids.expense } })).id;
    });

    it('takes identity from the authenticated user, refuses drawers and pays exactly once under concurrency', async () => {
      as(users.cashier, ['expense:create']);
      const created: any = await expenses.create({ title: 'Paper', amount: 40, expenseDate: new Date().toISOString(), paymentType: 'CREDIT', categoryId, createdBy: users.manager } as any);
      const row = await db.expense.findFirstOrThrow({ where: { id: created.id } });
      expect(row.createdById).toBe(users.cashier);
      await expect(expenses.create({ title: 'Cash now', amount: 5, expenseDate: new Date().toISOString(), paymentType: 'CASH', categoryId, paymentMethod: 'CASH', accountId: ids.safe } as any)).rejects.toThrow(/expense:post/);

      as(users.manager, ['expense:post']);
      await expect(expenses.pay(created.id, { paymentMethod: 'CASH', accountId: ids.drawer } as any)).rejects.toThrow(/drawer account/);
      const safeBefore = await bal(ids.safe);
      const outcomes = await Promise.allSettled([
        expenses.pay(created.id, { paymentMethod: 'CASH', accountId: ids.safe } as any),
        expenses.pay(created.id, { paymentMethod: 'CASH', accountId: ids.safe } as any),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(await db.expensePayment.count({ where: { expenseId: created.id } })).toBe(1);
      expect(Number(await bal(ids.safe))).toBe(Number(safeBefore) - 40);
      const payment = await db.expensePayment.findFirstOrThrow({ where: { expenseId: created.id } });
      expect(payment.journalEntryId).toBeTruthy();
      expect(payment.paidById).toBe(users.manager);
    });
  });

  describe('shift controls', () => {
    it('WHT: a cash supplier payment net of withholding reconciles cleanly', async () => {
      as(users.cashier);
      await payments.createSupplierPayment({ partnerId: ids.partner, paymentDate: new Date().toISOString(), paymentMethod: 'cash', amount: 100, withholdingAmount: 6, cashSessionId: session.id, allowOverpayment: true } as any);
      const check = await txRun((tx) => reconcileSession(tx, org, session));
      expect(check.issues).toEqual([]);
      expect(check.report.totals.expectedCash).toBe('106');
      expect(check.report.totals.supplierPayouts).toBe('94');
      expect(await bal(ids.wht)).toBe('-6');
      const movement = await db.cashMovement.findFirstOrThrow({ where: { cashSessionId: session.id, movementType: 'supplier_payment' } });
      expect(await sqlError('UPDATE "CashMovement" SET amount = 1 WHERE id = $1', movement.id)).toMatch(/posted drawer evidence/);
      expect(await sqlError('DELETE FROM "CashMovement" WHERE id = $1', movement.id)).toMatch(/posted drawer evidence/);
      expect(await sqlError('UPDATE "Payment" SET amount = 1 WHERE id = $1', movement.paymentId)).toMatch(/immutable/);
    });

    it('register custody cannot change while its shift is open', async () => {
      as(users.manager);
      await expect(registers.update(registerId, { defaultAccountId: ids.drawer2 })).rejects.toThrow(/active shift/);
    });

    it('a tracked tender must be observed, or explicitly not counted with a reason and a manager', async () => {
      as(users.cashier);
      await expect(cash.close({ sessionId: session.id, closingCounted: 106 })).rejects.toThrow(/Airtel Money/);
      await expect(cash.close({ sessionId: session.id, closingCounted: 106, uncountedAccounts: { [ids.airtel]: 'Phone offline' } })).rejects.toThrow(/manager approval/);
      as(users.cashier2);
      await expect(cash.close({ sessionId: session.id, closingCounted: 106, closingAccounts: { [ids.airtel]: 100 } })).rejects.toThrow(/Only the session cashier/);
      await expect(cash.close({ sessionId: session.id, closingCounted: 106, closingAccounts: { [ids.airtel]: 100 }, notes: 'left' }, { force: true })).rejects.toThrow(/approve_variance/);
      as(users.cashier);
      const closed: any = await cash.close({ sessionId: session.id, closingCounted: 106, uncountedAccounts: { [ids.airtel]: 'Phone offline' }, approverEmail: 'manager@golive.test', managerPin: '4321' });
      expect(closed.status).toBe('closed');
      expect((closed.closingAccounts as any)[ids.airtel]).toMatchObject({ notCounted: true, approvedById: users.manager });
    });

    it('banking after close posts drawer → bank and leaves the frozen shift untouched', async () => {
      const before = await db.cashSession.findUniqueOrThrow({ where: { id: session.id } });
      const snapshot = await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } });
      const movementCount = await db.cashMovement.count({ where: { cashSessionId: session.id } });
      as(users.manager, ['cash_session:reconcile']);
      await cash.recordBankDeposit(session.id, { amount: 106, bankName: 'Bank', destinationAccountId: ids.bank });
      const after = await db.cashSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(after.closingDifference?.toString()).toBe(before.closingDifference?.toString());
      expect(after.bankedAmount).toEqual(before.bankedAmount);
      expect(await db.cashMovement.count({ where: { cashSessionId: session.id } })).toBe(movementCount);
      expect((await db.posReportSnapshot.findFirstOrThrow({ where: { cashSessionId: session.id } })).reportData).toEqual(snapshot.reportData);
      expect(await bal(ids.drawer)).toBe('0');
      await expect(cash.recordBankDeposit(session.id, { amount: 1, bankName: 'Bank', destinationAccountId: ids.bank })).rejects.toThrow(/exceeds/);
    });

    it('handover and force-close enforce segregation of duties', async () => {
      as(users.cashier);
      // The wallet still holds the previous shift's 100: record it at open, so
      // the close compares with this shift's expectation (100), not the GL.
      const next = await cash.open({ cashRegisterId: registerId, openingFloat: 0, openingAccounts: { [ids.airtel]: 100 } });
      await expect(cash.handover({ cashRegisterId: registerId, closingCounted: 0, incomingUserId: users.cashier2, approvedById: users.cashier, closingAccounts: { [ids.airtel]: 100 } })).rejects.toThrow(/neither the outgoing/);
      as(users.manager);
      const out = await cash.handover({ cashRegisterId: registerId, closingCounted: 0, incomingUserId: users.cashier2, approvedById: users.manager, closingAccounts: { [ids.airtel]: 100 } });
      expect(out.variance).toBe('0');
      expect((await db.cashSession.findUniqueOrThrow({ where: { id: next.id } })).status).toBe('closed');
      as(users.manager, ['cash_session:force_close']);
      const forced: any = await cash.close({ sessionId: out.incomingSessionId, closingCounted: 0, closingAccounts: { [ids.airtel]: 100 }, notes: 'Cashier left without closing' }, { force: true });
      expect(forced.status).toBe('closed');
      expect(forced.notes).toMatch(/Force-closed by manager/);
      expect(await db.posReportSnapshot.count({ where: { cashSessionId: out.incomingSessionId } })).toBe(1);
    });
  });
});
