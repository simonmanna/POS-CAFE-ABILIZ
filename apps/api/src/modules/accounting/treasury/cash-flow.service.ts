import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { PostingService } from '../posting/posting.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';
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
        cashRegisters: { select: { id: true, name: true, code: true } },
      },
    });

    const grouped = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: {
        organizationId: orgId,
        accountId: { in: accounts.map((a) => a.id) },
        // Balance must count both `posted` and `reversed` entries: a reversed
        // entry's lines are still real and are cancelled by the mirror reversal
        // entry. Filtering to `posted` alone keeps the reversal but drops the
        // original, so the balance diverges from the trial balance / GL.
        entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] } },
      },
      _sum: { baseDebit: true, baseCredit: true },
    });

    const balanceMap = new Map<string, Prisma.Decimal>();
    for (const g of grouped) {
      const debit = (g as any)._sum.baseDebit ?? ZERO;
      const credit = (g as any)._sum.baseCredit ?? ZERO;
      balanceMap.set(g.accountId, dec(debit).minus(dec(credit)));
    }

    return accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      // `accountType` is the payment-mode key the frontend groups/filters on
      // (cash | bank | mobile_money | petty_cash) — sourced from the category.
      accountType: (a as any).category?.key ?? null,
      currencyId: a.currencyId,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
      isDefault: a.isDefault,
      balance: balanceMap.get(a.id)?.toString() ?? '0',
      cashRegister: (a as any).cashRegisters?.[0] ?? null,
    }));
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
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const aggregate = await this.prisma.client.journalLine.aggregate({ where: where as any, _sum: { baseDebit: true, baseCredit: true } });
    const currentBalance = dec(aggregate._sum.baseDebit ?? 0).minus(aggregate._sum.baseCredit ?? 0);
    let newerDelta = ZERO;
    const rows = lines.map((l) => {
      const runningBalance = currentBalance.minus(newerDelta);
      newerDelta = newerDelta.plus(dec(l.baseDebit).minus(l.baseCredit));
      return ({
      id: l.id,
      journalEntryId: l.journalEntryId,
      entryNumber: (l as any).entry.entryNumber,
      postingDate: (l as any).entry.postingDate,
      description: (l as any).entry.description ?? l.description,
      sourceType: (l as any).entry.sourceType,
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
      let type: 'deposit' | 'withdrawal' | 'transfer' = 'deposit';
      let fromName: string | null = null;
      let toName: string | null = null;
      if (sourceType === 'treasury_transfer') {
        type = 'transfer';
        fromName = accountName(cashLines.find((l: any) => dec(l.baseCredit).gt(0)));
        toName = accountName(cashLines.find((l: any) => dec(l.baseDebit).gt(0)));
      } else if (sourceType === 'cash_flow_withdrawal') {
        type = 'withdrawal';
      }
      const primary = type === 'withdrawal'
        ? cashLines.find((l: any) => dec(l.baseCredit).gt(0))
        : cashLines.find((l: any) => dec(l.baseDebit).gt(0)) ?? cashLines[0];
      const amount = type === 'transfer'
        ? dec(cashLines.find((l: any) => dec(l.baseCredit).gt(0))?.baseCredit ?? 0)
        : dec(primary?.baseDebit ?? 0).plus(primary?.baseCredit ?? 0);
      return {
        id: entry.id,
        journalEntryId: entry.id,
        entryNumber: entry.entryNumber,
        date: entry.postingDate,
        description: entry.description ?? primary?.description,
        sourceType,
        type,
        amount: amount.toString(),
        direction: type === 'withdrawal' || type === 'transfer' ? 'out' : 'in',
        accountId: primary?.accountId ?? cashLines[0]?.accountId,
        accountName: accountName(primary ?? cashLines[0]),
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
