import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { PostingService } from '../posting/posting.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';
import { CATEGORY_LABEL, categoryOf, classifyMoneyEntry, effectiveSourceType } from './money-activity.taxonomy';
import { zonedDayRange } from './cash-session.service';
import { dec, ZERO } from '../../../kernel/common/money';
import { AccountResolverService } from '../posting/account-resolver.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { assertNotDrawerAccount, assertSufficientFunds, lockAccounts, operationId, requireAccount } from './treasury-guards';

export interface CashFlowOperationInput {
  accountId: string;
  counterpartAccountId: string;
  operationType: string;
  amount: number | string;
  description: string;
  date?: string;
}

interface TreasuryOperation { key: string; label: string; classifications: string[] }

/** Money coming into a payment account from outside the payment accounts. */
export const DEPOSIT_OPERATIONS: TreasuryOperation[] = [
  { key: 'owner_contribution', label: 'Owner contribution', classifications: ['equity'] },
  { key: 'loan_received', label: 'Loan received', classifications: ['liability'] },
  { key: 'other_income', label: 'Other income (non-sales)', classifications: ['revenue'] },
  { key: 'refund_received', label: 'Refund received from supplier', classifications: ['expense'] },
];

/** Money leaving a payment account to somewhere other than another payment account. */
export const WITHDRAWAL_OPERATIONS: TreasuryOperation[] = [
  { key: 'owner_drawing', label: 'Owner drawing', classifications: ['equity'] },
  { key: 'bank_charge', label: 'Bank / provider charge', classifications: ['expense'] },
  { key: 'expense', label: 'Direct expense', classifications: ['expense'] },
  { key: 'loan_repayment', label: 'Loan repayment', classifications: ['liability'] },
  { key: 'tax_payment', label: 'Tax payment', classifications: ['liability'] },
];

/**
 * Legacy account types accepted by `createCashAccount`, mapped to the category
 * the new account is created under. Membership in "is this a payment account"
 * is decided by `AccountCategory.isCashEquivalent`, not by this map — see
 * AccountResolverService.cashEquivalentIds().
 */
const PAYMENT_TYPE_TO_CATEGORY: Record<string, string> = {
  cash: 'cash',
  bank: 'bank',
  mobile_money: 'mobile_money',
  petty_cash: 'petty_cash',
};

@Injectable()
export class CashFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly posting: PostingService,
    private readonly accounts: AccountResolverService,
    private readonly audit: AuditService,
  ) {}

  async getCashAccounts() {
    const orgId = this.tenant.organizationId;
    const accounts = await this.prisma.client.account.findMany({
      where: {
        organizationId: orgId,
        category: { isCashEquivalent: true },
        isActive: true,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: {
        category: { select: { key: true, name: true } },
        cashRegisters: { where: { deletedAt: null }, select: { id: true, name: true, code: true, isActive: true } },
      },
    });
    const ids = accounts.map((a) => a.id);

    const [grouped, org, methods, openSessions] = await Promise.all([
      this.prisma.client.journalLine.groupBy({
        by: ['accountId'],
        where: {
          organizationId: orgId,
          accountId: { in: ids },
          // Balance must count both `posted` and `reversed` entries: a reversed
          // entry's lines are still real and are cancelled by the mirror reversal
          // entry. Filtering to `posted` alone keeps the reversal but drops the
          // original, so the balance diverges from the trial balance / GL.
          entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] } },
        },
        _sum: { baseDebit: true, baseCredit: true },
        _max: { createdAt: true },
      }),
      this.prisma.client.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true, timezone: true } }),
      this.prisma.client.posPaymentMethod.findMany({
        where: { organizationId: orgId, deletedAt: null, accountId: { in: ids } },
        select: { id: true, code: true, label: true, kind: true, isActive: true, accountId: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      }),
      this.prisma.client.cashSession.findMany({
        where: { organizationId: orgId, status: 'open' },
        select: { id: true, cashRegisterId: true, drawerAccountId: true },
      }),
    ]);

    const balanceMap = new Map<string, Prisma.Decimal>();
    const lastActivity = new Map<string, Date | null>();
    for (const g of grouped) {
      const debit = (g as any)._sum.baseDebit ?? ZERO;
      const credit = (g as any)._sum.baseCredit ?? ZERO;
      balanceMap.set(g.accountId, dec(debit).minus(dec(credit)));
      lastActivity.set(g.accountId, (g as any)._max?.createdAt ?? null);
    }

    // Today's in/out per account, in the organisation's time zone.
    const timezone = (org as any)?.timezone || 'UTC';
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const { start, end } = zonedDayRange(todayStr, timezone);
    const today = ids.length
      ? await this.prisma.client.journalLine.groupBy({
        by: ['accountId'],
        where: {
          organizationId: orgId,
          accountId: { in: ids },
          entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] }, postingDate: { gte: start, lt: end } },
        },
        _sum: { baseDebit: true, baseCredit: true },
      })
      : [];
    const todayMap = new Map((today as any[]).map((t) => [t.accountId, t._sum]));

    const methodsOf = new Map<string, any[]>();
    for (const m of methods as any[]) {
      const arr = methodsOf.get(m.accountId) ?? [];
      arr.push({ id: m.id, code: m.code, label: m.label, kind: m.kind, isActive: m.isActive });
      methodsOf.set(m.accountId, arr);
    }
    const openDrawerIds = new Set((openSessions as any[]).map((s) => s.drawerAccountId).filter(Boolean));
    const baseCurrency = (org as any)?.currencyCode ?? null;

    return accounts.map((a) => {
      const registers = ((a as any).cashRegisters ?? []).map((r: any) => ({ id: r.id, name: r.name, code: r.code, isActive: r.isActive }));
      const isDrawer = registers.length > 0 || openDrawerIds.has(a.id);
      const t = todayMap.get(a.id);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        // `accountType` is the payment-mode key the frontend groups/filters on
        // (cash | bank | mobile_money | petty_cash) — sourced from the category.
        accountType: (a as any).category?.key ?? null,
        currencyId: a.currencyId,
        /** Native currency label; balances are always in `baseCurrency`. */
        currencyCode: a.currencyId ?? baseCurrency,
        baseCurrency,
        bankName: a.bankName,
        accountNumber: a.accountNumber,
        isDefault: a.isDefault,
        balance: balanceMap.get(a.id)?.toString() ?? '0',
        cashRegister: registers[0] ?? null,
        registers,
        posMethods: methodsOf.get(a.id) ?? [],
        /** `drawer`: money moves only through register shifts (no deposit / withdrawal / transfer). */
        restrictions: isDrawer ? ['drawer'] : [],
        lastActivityAt: lastActivity.get(a.id) ?? null,
        todayIn: dec(t?.baseDebit ?? 0).toFixed(2),
        todayOut: dec(t?.baseCredit ?? 0).toFixed(2),
      };
    });
  }

  async create(dto: {
    code: string;
    name: string;
    accountType: string;
    currencyId?: string;
    bankName?: string;
    accountNumber?: string;
    isDefault?: boolean;
  }) {
    const orgId = this.tenant.organizationId;
    if (!dto.code || !dto.name) throw new BadRequestException('Code and name are required');
    const categoryKey = PAYMENT_TYPE_TO_CATEGORY[dto.accountType];
    if (!categoryKey) {
      throw new BadRequestException('Account type must be a payment account type');
    }
    const category = await this.prisma.client.accountCategory.findFirst({
      where: { key: categoryKey },
    });
    if (!category) {
      throw new BadRequestException(
        `Account category '${categoryKey}' is missing for this organization. ` +
          'Run the accounting backfill (prisma/backfill-account-category.ts).',
      );
    }

    const existing = await this.prisma.client.account.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: dto.code } },
    });
    if (existing) throw new BadRequestException('Account code already exists');

    return this.prisma.client.$transaction(async (tx: any) => {
      if (dto.isDefault) {
        await tx.$queryRawUnsafe('SELECT id FROM "AccountCategory" WHERE id = $1 FOR UPDATE', category.id);
        await tx.account.updateMany({
          where: { organizationId: orgId, categoryId: category.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.account.create({ data: {
        organizationId: orgId,
        code: dto.code,
        name: dto.name,
        categoryId: category.id,
        normalBalance: category.normalBalance,
        currencyId: dto.currencyId ?? null,
        bankName: dto.bankName ?? null,
        accountNumber: dto.accountNumber ?? null,
        isDefault: dto.isDefault ?? false,
        cashFlowCategory: 'operating',
      } });
    });
  }

  async update(id: string, dto: {
    name?: string;
    currencyId?: string;
    bankName?: string;
    accountNumber?: string;
    isDefault?: boolean;
  }) {
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({ where: { id, organizationId: orgId } });
    if (!account) throw new NotFoundException('Account not found');

    return this.prisma.client.$transaction(async (tx: any) => {
      if (dto.isDefault) {
        await tx.$queryRawUnsafe('SELECT id FROM "AccountCategory" WHERE id = $1 FOR UPDATE', account.categoryId);
        await tx.account.updateMany({
          where: { organizationId: orgId, categoryId: account.categoryId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.account.update({ where: { id }, data: {
        name: dto.name,
        currencyId: dto.currencyId,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        isDefault: dto.isDefault,
      } });
    });
  }

  async remove(id: string) {
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({ where: { id, organizationId: orgId } });
    if (!account) throw new NotFoundException('Account not found');
    const [registers, methods, openSessions] = await Promise.all([
      this.prisma.client.cashRegister.count({ where: { organizationId: orgId, defaultAccountId: id, isActive: true } }),
      this.prisma.client.posPaymentMethod.count({ where: { organizationId: orgId, accountId: id, isActive: true } }),
      this.prisma.client.cashSession.count({ where: { organizationId: orgId, status: 'open', cashRegister: { defaultAccountId: id } } }),
    ]);
    if (registers || methods || openSessions) {
      throw new BadRequestException('Account is in active use by a register, payment method or open shift');
    }
    return this.prisma.client.account.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /** Operation catalogue + the accounts each operation may use as its counterpart. */
  async operationTypes() {
    const orgId = this.tenant.organizationId;
    const accounts = await this.prisma.client.account.findMany({
      where: { organizationId: orgId, isActive: true, deletedAt: null, isPostable: true },
      include: { category: { select: { key: true, classification: true, isCashEquivalent: true } } },
      orderBy: [{ code: 'asc' }],
    });
    const eligible = (op: TreasuryOperation) => accounts
      .filter((a: any) => !a.category?.isCashEquivalent && op.classifications.includes(a.category?.classification))
      .map((a: any) => ({ id: a.id, code: a.code, name: a.name, classification: a.category.classification }));
    return {
      deposit: DEPOSIT_OPERATIONS.map((op) => ({ key: op.key, label: op.label, accounts: eligible(op) })),
      withdrawal: WITHDRAWAL_OPERATIONS.map((op) => ({ key: op.key, label: op.label, accounts: eligible(op) })),
    };
  }

  deposit(dto: CashFlowOperationInput) {
    return this.postOperation('deposit', dto);
  }

  withdraw(dto: CashFlowOperationInput) {
    return this.postOperation('withdrawal', dto);
  }

  /**
   * One explicit treasury operation → one balanced journal. The counterpart is
   * constrained by the operation type (an owner drawing must hit equity, a bank
   * charge an expense, ...), register drawers are refused (they move only
   * through their shift), both accounts are row-locked before the balance
   * check, and the posting key is derived from the Idempotency-Key so a retried
   * request cannot post twice.
   */
  private async postOperation(direction: 'deposit' | 'withdrawal', dto: CashFlowOperationInput) {
    const amount = dec(dto.amount);
    if (!amount.isFinite() || !amount.gt(0)) throw new BadRequestException('Amount must be positive');
    const catalogue = direction === 'deposit' ? DEPOSIT_OPERATIONS : WITHDRAWAL_OPERATIONS;
    const op = catalogue.find((o) => o.key === dto.operationType);
    if (!op) throw new BadRequestException(`Choose a ${direction} type: ${catalogue.map((o) => o.key).join(', ')}`);
    if (!dto.description?.trim()) throw new BadRequestException('A description is required for every treasury operation');
    if (dto.counterpartAccountId === dto.accountId) throw new BadRequestException('Counterpart account must differ from the payment account');
    const orgId = this.tenant.organizationId;

    return this.prisma.client.$transaction(async (tx: any) => {
      await lockAccounts(tx, orgId, [dto.accountId, dto.counterpartAccountId]);
      const account = await requireAccount(tx, orgId, dto.accountId, 'Payment account');
      if (!account.category?.isCashEquivalent) throw new BadRequestException('Account is not a cash, bank or mobile-money account');
      await assertNotDrawerAccount(tx, orgId, account.id, direction === 'deposit' ? 'A deposit' : 'A withdrawal');
      const counterpart = await requireAccount(tx, orgId, dto.counterpartAccountId, 'Counterpart account');
      if (counterpart.category?.isCashEquivalent) throw new BadRequestException('Moving money between payment accounts is a transfer, not a deposit or withdrawal');
      if (!op.classifications.includes(counterpart.category?.classification)) {
        throw new BadRequestException(`${op.label} must use a ${op.classifications.join(' or ')} account; ${counterpart.code} is ${counterpart.category?.classification}`);
      }
      if (direction === 'withdrawal') await assertSufficientFunds(tx, orgId, account.id, amount, account.name);

      const id = operationId();
      const description = `${op.label}: ${dto.description.trim()}`;
      const lines = direction === 'deposit'
        ? [{ accountId: account.id, debit: amount.toString() }, { accountId: counterpart.id, credit: amount.toString() }]
        : [{ accountId: counterpart.id, debit: amount.toString() }, { accountId: account.id, credit: amount.toString() }];
      const entry = await this.posting.post({
        journalCode: account.category?.key === 'cash' || account.category?.key === 'petty_cash' ? 'CASH' : 'BANK',
        date: dto.date ? new Date(dto.date) : new Date(),
        description,
        sourceType: direction === 'deposit' ? 'cash_flow_deposit' : 'cash_flow_withdrawal',
        sourceId: id,
        postingKey: `cash-flow:${direction}:${id}`,
        dimensions: { treasuryOperation: op.key },
        lines,
      } as any, tx);
      await this.audit.recordInTx(tx, {
        entity: 'TreasuryOperation', entityId: id, action: 'create',
        newValues: { direction, operationType: op.key, accountId: account.id, counterpartAccountId: counterpart.id, amount: amount.toString(), journalEntryId: entry.id, description },
      });
      await recordBusinessOutcome(tx, entry, true);
      return entry;
    });
  }

  async getTransactions(accountId: string, page: number, pageSize: number) {
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, organizationId: orgId },
      include: { category: { select: { key: true } }, cashRegisters: { where: { deletedAt: null }, select: { id: true, code: true, name: true } } },
    });
    if (!account) throw new BadRequestException('Account not found');

    const where = {
      organizationId: orgId,
      accountId,
      // Match the balance query (getCashAccounts) and the GL: show both posted
      // and reversed lines so a reversed movement isn't silently hidden.
      entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] } },
    };

    const [total, lines] = await Promise.all([
      this.prisma.client.journalLine.count({ where: where as any }),
      this.prisma.client.journalLine.findMany({
        where: where as any,
        include: {
          entry: {
            select: {
              id: true,
              entryNumber: true,
              postingDate: true,
              description: true,
              sourceType: true,
              sourceId: true,
            },
          },
        },
        // Deterministic order (ties broken by id) so pages never overlap or skip.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const aggregate = await this.prisma.client.journalLine.aggregate({ where: where as any, _sum: { baseDebit: true, baseCredit: true } });
    const currentBalance = dec(aggregate._sum.baseDebit ?? 0).minus(aggregate._sum.baseCredit ?? 0);
    // Running balances are authoritative on every page: start from the current
    // balance less everything newer than this page (all earlier pages).
    const offset = (page - 1) * pageSize;
    let newerDelta = ZERO;
    if (offset > 0) {
      const [row] = await this.prisma.client.$queryRawUnsafe<Array<{ delta: string | null }>>(
        `SELECT COALESCE(SUM(x."baseDebit" - x."baseCredit"), 0)::text AS delta FROM (
           SELECT l."baseDebit", l."baseCredit" FROM "JournalLine" l
           JOIN "JournalEntry" e ON e.id = l."journalEntryId"
           WHERE l."organizationId" = $1 AND l."accountId" = $2 AND e.status IN ('posted', 'reversed')
           ORDER BY l."createdAt" DESC, l.id DESC
           LIMIT $3
         ) x`,
        orgId, accountId, offset,
      );
      newerDelta = dec(row?.delta ?? 0);
    }
    const paymentIds = lines.filter((l: any) => l.entry.sourceType === 'payment' && l.entry.sourceId).map((l: any) => l.entry.sourceId);
    const paymentRows = paymentIds.length
      ? await this.prisma.client.payment.findMany({ where: { organizationId: orgId, id: { in: paymentIds } }, select: { id: true, cashSessionId: true, direction: true } })
      : [];
    const paymentOf = new Map((paymentRows as any[]).map((p) => [p.id, { cashSessionId: p.cashSessionId, direction: String(p.direction) }]));
    const rows = lines.map((l) => {
      const effective = effectiveSourceType((l as any).entry.sourceType, paymentOf.get((l as any).entry.sourceId));
      const runningBalance = currentBalance.minus(newerDelta);
      newerDelta = newerDelta.plus(dec(l.baseDebit).minus(l.baseCredit));
      return ({
      id: l.id,
      journalEntryId: l.journalEntryId,
      entryNumber: (l as any).entry.entryNumber,
      postingDate: (l as any).entry.postingDate,
      description: (l as any).entry.description ?? l.description,
      sourceType: (l as any).entry.sourceType,
      sourceId: (l as any).entry.sourceId ?? null,
      category: categoryOf(effective),
      categoryLabel: CATEGORY_LABEL.get(categoryOf(effective)) ?? 'Other',
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      baseDebit: l.baseDebit.toString(),
      baseCredit: l.baseCredit.toString(),
      runningBalance: runningBalance.toString(),
    }); });

    return {
      data: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        accountType: (account as any).category?.key ?? null,
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        currencyId: account.currencyId,
        currentBalance: currentBalance.toString(),
        cashRegister: (account as any).cashRegisters?.[0] ?? null,
        registers: (account as any).cashRegisters ?? [],
      },
    };
  }

  /**
   * Org-wide treasury movement log: every journal line touching a cash-equivalent
   * account (deposit / withdrawal / transfer). Each line is classified by its
   * journal entry `sourceType`. For transfers the counterparty account (the other
   * leg of the same entry) is resolved so the UI can show "Cash → Bank".
   */
  async getAllTransactions(page: number, pageSize: number, type?: 'deposit' | 'withdrawal' | 'transfer', search?: string) {
    const orgId = this.tenant.organizationId;
    const cashIds = new Set(await this.accounts.cashEquivalentIds());
    const typeSource = type === 'deposit' ? 'cash_flow_deposit'
      : type === 'withdrawal' ? 'cash_flow_withdrawal'
        : type === 'transfer' ? 'treasury_transfer' : undefined;
    const q = search?.trim();
    const where: any = {
      organizationId: orgId,
      status: { in: [...BALANCE_AFFECTING_STATUSES] },
      lines: { some: { accountId: { in: [...cashIds] } } },
      ...(typeSource ? { sourceType: typeSource } : {}),
      ...(q ? { OR: [
        { entryNumber: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { lines: { some: { account: { OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { code: { contains: q, mode: 'insensitive' } },
        ] } } } },
      ] } : {}),
    };

    const [total, entries] = await Promise.all([
      this.prisma.client.journalEntry.count({ where }),
      this.prisma.client.journalEntry.findMany({
        where,
        include: { lines: { include: { account: { select: { id: true, code: true, name: true } } } } },
        orderBy: [{ postingDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const accountName = (l: any) => l?.account?.name ?? l?.account?.code ?? '—';
    const rows = (entries as any[]).map((entry: any) => {
      const cashLines = entry.lines.filter((l: any) => cashIds.has(l.accountId));
      const sourceType: string = entry.sourceType;
      // Direction and amount come from the netted money legs (shared taxonomy),
      // never a default: a supplier payment is money out, not a "deposit".
      const figures = classifyMoneyEntry(sourceType, cashLines.map((l: any) => ({
        accountId: l.accountId,
        accountName: accountName(l),
        accountType: null,
        baseDebit: l.baseDebit.toString(),
        baseCredit: l.baseCredit.toString(),
      })));
      const type: 'deposit' | 'withdrawal' | 'transfer' = figures.direction === 'internal' ? 'transfer'
        : figures.direction === 'out' ? 'withdrawal' : 'deposit';
      const outLeg = figures.legs.find((l) => l.side === 'out');
      const inLeg = figures.legs.find((l) => l.side === 'in');
      const fromName = type === 'transfer' ? outLeg?.accountName ?? null : null;
      const toName = type === 'transfer' ? inLeg?.accountName ?? null : null;
      const primaryLeg = figures.direction === 'out' ? outLeg : inLeg ?? outLeg;
      const primary = cashLines.find((l: any) => l.accountId === primaryLeg?.accountId) ?? cashLines[0];
      const amount = figures.direction === 'internal' ? figures.internalMoved
        : figures.direction === 'out' ? figures.externalOut
          : figures.direction === 'in' ? figures.externalIn : figures.grossAmount;
      return {
        id: entry.id,
        journalEntryId: entry.id,
        entryNumber: entry.entryNumber,
        date: entry.postingDate,
        description: entry.description ?? primary?.description,
        sourceType,
        type,
        category: figures.category,
        categoryLabel: figures.categoryLabel,
        amount,
        direction: figures.direction === 'out' ? 'out' : figures.direction === 'internal' ? 'internal' : 'in',
        accountId: primary?.accountId,
        accountName: accountName(primary),
        fromName,
        toName,
      };
    });

    return {
      data: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

}
