import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaService } from '../../../kernel/prisma/prisma.service';

interface DateRange {
  from?: string;
  to?: string;
}

const ZERO = new Prisma.Decimal(0);

@Injectable()
export class AccountingReportingService {
  constructor(private readonly prisma: PrismaService) {}

  private entryDateFilter(range: DateRange): any {
    const filter: any = { status: 'posted' };
    if (range.from || range.to) {
      filter.postingDate = {};
      if (range.from) filter.postingDate.gte = new Date(range.from);
      if (range.to) filter.postingDate.lte = new Date(range.to);
    }
    return filter;
  }

  /** Trial balance: net debit/credit per account over posted entries (base currency). */
  async trialBalance(range: DateRange) {
    const grouped = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: this.entryDateFilter(range) },
      _sum: { baseDebit: true, baseCredit: true },
    });

    const accounts = await this.prisma.client.account.findMany({
      where: { id: { in: grouped.map((g: any) => g.accountId) } },
    });
    const accountMap = new Map(accounts.map((a: any) => [a.id, a]));

    let totalDebit = ZERO;
    let totalCredit = ZERO;
    const rows = grouped
      .map((g: any) => {
        const debit: Prisma.Decimal = g._sum.baseDebit ?? ZERO;
        const credit: Prisma.Decimal = g._sum.baseCredit ?? ZERO;
        const account = accountMap.get(g.accountId);
        totalDebit = totalDebit.plus(debit);
        totalCredit = totalCredit.plus(credit);
        return {
          accountId: g.accountId,
          code: account?.code ?? '',
          name: account?.name ?? '',
          accountType: account?.accountType ?? '',
          debit: debit.toString(),
          credit: credit.toString(),
          balance: debit.minus(credit).toString(),
        };
      })
      .sort((a: any, b: any) => a.code.localeCompare(b.code));

    return {
      rows,
      totals: { debit: totalDebit.toString(), credit: totalCredit.toString() },
      balanced: totalDebit.minus(totalCredit).abs().lessThanOrEqualTo(0.0001),
    };
  }

  /** Account ledger: posted lines for one account with a running balance. */
  async accountLedger(accountId: string, range: DateRange) {
    const account = await this.prisma.client.account.findFirst({ where: { id: accountId } });
    const lines = await this.prisma.client.journalLine.findMany({
      where: { accountId, entry: this.entryDateFilter(range) },
      include: { entry: true },
      orderBy: [{ entry: { postingDate: 'asc' } }, { lineNumber: 'asc' }],
    });

    let running = ZERO;
    const rows = lines.map((l: any) => {
      running = running.plus(l.baseDebit).minus(l.baseCredit);
      return {
        id: l.id,
        date: l.entry.postingDate,
        entryNumber: l.entry.entryNumber,
        description: l.description,
        debit: (l.baseDebit as Prisma.Decimal).toString(),
        credit: (l.baseCredit as Prisma.Decimal).toString(),
        balance: running.toString(),
      };
    });

    return { account, lines: rows, closingBalance: running.toString() };
  }

  /** General ledger: flat, paginated list of posted lines with account + entry. */
  async generalLedger(range: DateRange, page = 1, pageSize = 100) {
    const where = { entry: this.entryDateFilter(range) };
    const [lines, total] = await Promise.all([
      this.prisma.client.journalLine.findMany({
        where,
        include: { entry: true, account: true },
        orderBy: [{ entry: { postingDate: 'asc' } }, { lineNumber: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.journalLine.count({ where }),
    ]);

    return {
      data: lines.map((l: any) => ({
        id: l.id,
        date: l.entry.postingDate,
        entryNumber: l.entry.entryNumber,
        accountCode: l.account.code,
        accountName: l.account.name,
        description: l.description,
        debit: (l.baseDebit as Prisma.Decimal).toString(),
        credit: (l.baseCredit as Prisma.Decimal).toString(),
      })),
      meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }
}
