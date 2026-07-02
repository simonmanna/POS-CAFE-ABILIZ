import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { PostingService } from '../posting/posting.service';
import { AccountDeterminationService } from '../posting/account-determination.service';
import { dec, ZERO } from '../../../kernel/common/money';

const CASH_ACCOUNT_TYPES: AccountType[] = ['cash', 'bank', 'mobile_money'];

@Injectable()
export class CashFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly posting: PostingService,
    private readonly determination: AccountDeterminationService,
  ) {}

  async getCashAccounts() {
    const orgId = this.tenant.organizationId;
    const accounts = await this.prisma.client.account.findMany({
      where: {
        organizationId: orgId,
        accountType: { in: CASH_ACCOUNT_TYPES },
        isActive: true,
        deletedAt: null,
      },
      orderBy: { accountType: 'asc' },
    });

    const grouped = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: {
        organizationId: orgId,
        accountId: { in: accounts.map((a) => a.id) },
        entry: { status: 'posted' },
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
      accountType: a.accountType,
      currencyId: a.currencyId,
      balance: balanceMap.get(a.id)?.toString() ?? '0',
    }));
  }

  async deposit(accountId: string, amount: number, description?: string) {
    if (amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, organizationId: orgId },
    });
    if (!account) throw new BadRequestException('Account not found');
    if (!CASH_ACCOUNT_TYPES.includes(account.accountType)) {
      throw new BadRequestException('Account is not a cash/bank/mobile_money account');
    }
    const suspenseId = await this.determination.mapped('cash_suspense');
    return this.posting.post({
      journalCode: 'CASH',
      date: new Date(),
      description: description ?? 'Cash deposit',
      sourceType: 'cash_flow_deposit',
      sourceId: accountId,
      lines: [
        { accountId, debit: amount },
        { accountId: suspenseId, credit: amount },
      ],
    });
  }

  async withdraw(accountId: string, amount: number, description?: string) {
    if (amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, organizationId: orgId },
    });
    if (!account) throw new BadRequestException('Account not found');
    if (!CASH_ACCOUNT_TYPES.includes(account.accountType)) {
      throw new BadRequestException('Account is not a cash/bank/mobile_money account');
    }
    const suspenseId = await this.determination.mapped('cash_suspense');
    return this.posting.post({
      journalCode: 'CASH',
      date: new Date(),
      description: description ?? 'Cash withdrawal',
      sourceType: 'cash_flow_withdrawal',
      sourceId: accountId,
      lines: [
        { accountId: suspenseId, debit: amount },
        { accountId, credit: amount },
      ],
    });
  }

  async getTransactions(
    accountId: string,
    page: number,
    pageSize: number,
  ) {
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, organizationId: orgId },
    });
    if (!account) throw new BadRequestException('Account not found');

    const where = {
      organizationId: orgId,
      accountId,
      entry: { status: 'posted' as const },
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

    const rows = lines.map((l) => ({
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
    }));

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
        accountType: account.accountType,
      },
    };
  }
}
