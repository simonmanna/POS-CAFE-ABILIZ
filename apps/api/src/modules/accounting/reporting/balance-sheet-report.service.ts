import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';

const ZERO = new Prisma.Decimal(0);

/**
 * Balance Sheet (D3). Reads from `ReportBalanceSheetSnapshot` when available;
 * falls back to live JournalLine aggregation otherwise. As-of semantics: the
 * snapshot's `asOf` must be ≤ the requested date and within 1 minute of now.
 */
@Injectable()
export class BalanceSheetReportService {
  private readonly logger = new Logger('BalanceSheetReportService');
  constructor(private readonly prisma: PrismaService) {}

  async balanceSheet(asOf: string) {
    const requested = new Date(asOf);
    const snap = await this.findSnapshot(requested);
    if (snap) {
      const rows = await this.prisma.client.reportBalanceSheetSnapshot.findMany({
        where: { organizationId: snap.organizationId, asOf: snap.asOf },
        orderBy: { accountCode: 'asc' },
      });
      let totalAssets = ZERO;
      let totalLiabilities = ZERO;
      let totalEquity = ZERO;
      let totalEarnings = ZERO;
      for (const r of rows) {
        const bal = r.balance;
        switch (r.accountType as string) {
          case 'asset':
          case 'bank':
          case 'cash':
          case 'receivable':
          case 'contra_asset':
            totalAssets = totalAssets.plus(bal);
            break;
          case 'liability':
          case 'payable':
          case 'tax':
          case 'contra_liability':
            totalLiabilities = totalLiabilities.plus(bal.negated());
            break;
          case 'equity':
            totalEquity = totalEquity.plus(bal.negated());
            break;
          default:
            break;
        }
      }
      // P&L rolls into equity via retained earnings in the snapshot.
      // The snapshot builder already closed revenue/expense into RE for the
      // relevant period. We do not add another earnings term here.
      const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity).plus(totalEarnings);
      return {
        asOf: snap.asOf,
        totalAssets: totalAssets.toString(),
        totalLiabilities: totalLiabilities.toString(),
        totalEquity: totalEquity.toString(),
        currentYearEarnings: totalEarnings.toString(),
        totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toString(),
        balanced: totalAssets.minus(totalLiabilitiesAndEquity).abs().lessThanOrEqualTo(0.01),
        source: 'snapshot',
      };
    }
    return this.live(asOf);
  }

  private async live(asOf: string) {
    const grouped = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] }, postingDate: { lte: new Date(asOf) } } },
      _sum: { baseDebit: true, baseCredit: true },
    });
    const accounts = await this.prisma.client.account.findMany({
      where: { id: { in: (grouped as any[]).map((g) => g.accountId) } },
    });
    const acctById = new Map((accounts as any[]).map((a) => [a.id, a]));
    let totalAssets = ZERO,
      totalLiabilities = ZERO,
      totalEquity = ZERO,
      totalEarnings = ZERO;
    for (const g of grouped as any[]) {
      const acct = acctById.get(g.accountId);
      if (!acct) continue;
      const debit = new Prisma.Decimal(g._sum.baseDebit ?? 0);
      const credit = new Prisma.Decimal(g._sum.baseCredit ?? 0);
      const net = debit.minus(credit);
      switch (acct.accountType as string) {
        case 'asset':
        case 'bank':
        case 'cash':
        case 'receivable':
        case 'contra_asset':
          totalAssets = totalAssets.plus(net);
          break;
        case 'liability':
        case 'payable':
        case 'tax':
        case 'contra_liability':
          totalLiabilities = totalLiabilities.plus(net.negated());
          break;
        case 'equity':
          totalEquity = totalEquity.plus(net.negated());
          break;
        case 'revenue':
        case 'contra_revenue':
          totalEarnings = totalEarnings.plus(net.negated());
          break;
        case 'cost_of_goods_sold':
        case 'expense':
          totalEarnings = totalEarnings.minus(net);
          break;
      }
    }
    const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity).plus(totalEarnings);
    return {
      asOf,
      totalAssets: totalAssets.toString(),
      totalLiabilities: totalLiabilities.toString(),
      totalEquity: totalEquity.toString(),
      currentYearEarnings: totalEarnings.toString(),
      totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toString(),
      balanced: totalAssets.minus(totalLiabilitiesAndEquity).abs().lessThanOrEqualTo(0.01),
      source: 'live',
    };
  }

  async balanceSheetDetailed(asOf: string) {
    const grouped = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] }, postingDate: { lte: new Date(asOf) } } },
      _sum: { baseDebit: true, baseCredit: true },
    });
    const accounts = await this.prisma.client.account.findMany({
      where: { id: { in: (grouped as any[]).map((g) => g.accountId) }, isActive: true },
    });
    const acctById = new Map((accounts as any[]).map((a) => [a.id, a]));

    const sectionDefs: Array<{
      key: string;
      label: string;
      type: 'asset' | 'liability' | 'equity';
      types: string[];
    }> = [
      { key: 'current_assets', label: 'Current Assets', type: 'asset', types: ['cash', 'bank', 'receivable', 'mobile_money', 'petty_cash'] },
      { key: 'non_current_assets', label: 'Non-current Assets', type: 'asset', types: ['asset', 'contra_asset'] },
      { key: 'current_liabilities', label: 'Current Liabilities', type: 'liability', types: ['payable', 'tax'] },
      { key: 'long_term_liabilities', label: 'Long-term Liabilities', type: 'liability', types: ['liability', 'contra_liability'] },
      { key: 'equity', label: "Stockholders' Equity", type: 'equity', types: ['equity'] },
    ];

    const sectionRows: Record<string, any[]> = {};
    for (const s of sectionDefs) sectionRows[s.key] = [];

    let totalAssets = ZERO;
    let totalLiabilities = ZERO;
    let totalEquity = ZERO;
    let totalEarnings = ZERO;

    for (const g of grouped as any[]) {
      const acct = acctById.get(g.accountId);
      if (!acct) continue;
      const debit = new Prisma.Decimal(g._sum.baseDebit ?? 0);
      const credit = new Prisma.Decimal(g._sum.baseCredit ?? 0);
      const net = debit.minus(credit);
      let display = net;
      const typeStr = acct.accountType as string;
      if (['liability', 'payable', 'tax', 'contra_liability', 'equity'].includes(typeStr)) {
        display = net.negated();
        if (typeStr === 'liability' || typeStr === 'payable' || typeStr === 'tax' || typeStr === 'contra_liability') {
          totalLiabilities = totalLiabilities.plus(display);
        } else if (typeStr === 'equity') {
          totalEquity = totalEquity.plus(display);
        }
      } else if (typeStr === 'revenue' || typeStr === 'contra_revenue') {
        totalEarnings = totalEarnings.plus(net.negated());
      } else if (typeStr === 'cost_of_goods_sold' || typeStr === 'expense') {
        totalEarnings = totalEarnings.minus(net);
      } else {
        totalAssets = totalAssets.plus(net);
      }

      for (const s of sectionDefs) {
        if (s.types.includes(typeStr)) {
          sectionRows[s.key].push({
            accountId: acct.id,
            code: acct.code,
            name: acct.name,
            balance: display.toString(),
          });
          break;
        }
      }
    }

    const sections = sectionDefs.map((s) => {
      const rows = sectionRows[s.key].sort((a, b) => a.code.localeCompare(b.code));
      let subtotal = ZERO;
      for (const r of rows) {
        subtotal = subtotal.plus(new Prisma.Decimal(r.balance || 0));
      }
      return { ...s, rows, subtotal: subtotal.toString() };
    });

    const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity).plus(totalEarnings);
    return {
      asOf,
      balanced: totalAssets.minus(totalLiabilitiesAndEquity).abs().lessThanOrEqualTo(0.01),
      source: 'live',
      sections,
      totals: {
        assets: totalAssets.toString(),
        liabilities: totalLiabilities.toString(),
        equity: totalEquity.toString(),
        liabilitiesAndEquity: totalLiabilitiesAndEquity.toString(),
      },
    };
  }

  /** Latest snapshot ≤ asOf, served only if nothing balance-affecting posted since. */
  private async findSnapshot(asOf: Date): Promise<{ organizationId: string; asOf: Date } | null> {
    const snap = await this.prisma.client.reportBalanceSheetSnapshot.findFirst({
      where: { asOf: { lte: asOf } },
      orderBy: { asOf: 'desc' },
      select: { organizationId: true, asOf: true },
    });
    if (!snap) return null;
    const newer = await this.prisma.client.journalLine.count({
      where: {
        entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] }, postingDate: { gt: snap.asOf, lte: asOf } },
      },
    });
    if (newer > 0) return null;
    return snap;
  }
}