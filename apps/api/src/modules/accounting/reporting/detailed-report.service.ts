import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { AccountResolverService } from '../posting/account-resolver.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZERO = new Prisma.Decimal(0);

/** Hard ceiling on transaction lines returned in one call. */
const MAX_LINES = 20_000;
const DEFAULT_MAX_LINES = 5_000;

export interface DetailedReportQuery {
  from?: string;
  to?: string;
  /** Comma-separated account ids; empty = every account with activity. */
  accountIds?: string;
  /** asset | liability | equity | income | expense */
  classification?: string;
  branchId?: string;
  costCenterId?: string;
  journalId?: string;
  partnerId?: string;
  /** Include accounts whose opening, movement and closing are all zero. */
  includeZero?: boolean;
  /** Drop the per-account transaction detail and return summary rows only. */
  summaryOnly?: boolean;
  maxLines?: number;
}

export interface DetailedReportLine {
  id: string;
  date: Date;
  entryId: string;
  entryNumber: string;
  entryStatus: string;
  journalCode: string | null;
  journalName: string | null;
  sourceType: string | null;
  sourceId: string | null;
  partnerName: string | null;
  branchName: string | null;
  costCenterName: string | null;
  description: string | null;
  debit: string;
  credit: string;
  /** Running balance within the account, opening balance included. */
  balance: string;
}

export interface DetailedReportAccount {
  accountId: string;
  code: string;
  name: string;
  classification: string | null;
  categoryKey: string | null;
  normalBalance: string;
  opening: string;
  debit: string;
  credit: string;
  movement: string;
  closing: string;
  lineCount: number;
  lines: DetailedReportLine[];
}

/**
 * Detailed Accounting Report — the "general ledger detail" statement.
 *
 * One pass over the period that returns, per account: the opening balance
 * carried in from before `from`, every posted transaction line inside the
 * window with a running balance, and the closing balance. This is what the
 * Trial Balance (totals with no drill-down) and the Account Ledger (drill-down
 * for exactly one account, with no opening balance) each only do half of.
 *
 * Signed convention: every balance is debit-positive (debit − credit), so
 * credit-normal accounts (liability/equity/income) read negative. The client
 * flips the sign for presentation using `normalBalance`.
 */
@Injectable()
export class DetailedAccountingReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountResolverService,
  ) {}

  async detailed(query: DetailedReportQuery) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const maxLines = Math.min(
      Math.max(Number(query.maxLines) || DEFAULT_MAX_LINES, 1),
      MAX_LINES,
    );

    const accountFilter = (query.accountIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const allMeta = await this.accounts.allMeta();
    // Resolve the account universe up front so `classification` narrows both
    // the opening balances and the period lines with one predicate.
    let scopedAccountIds: string[] | undefined;
    if (accountFilter.length > 0) {
      scopedAccountIds = accountFilter;
    } else if (query.classification) {
      scopedAccountIds = [...allMeta.values()]
        .filter((m) => m.classification === query.classification)
        .map((m) => m.id);
      // An empty classification match must return nothing, not everything.
      if (scopedAccountIds.length === 0) {
        return this.empty(from, to, maxLines);
      }
    }

    const dimensionWhere = this.dimensionWhere(query, scopedAccountIds);

    // ─── Opening balances (everything strictly before `from`) ───────────────
    const opening = new Map<string, Prisma.Decimal>();
    if (from) {
      const openingRows = await this.prisma.client.journalLine.groupBy({
        by: ['accountId'],
        where: {
          ...dimensionWhere,
          entry: {
            ...(dimensionWhere as any).entry,
            postingDate: { lt: from },
          },
        } as any,
        _sum: { baseDebit: true, baseCredit: true },
      });
      for (const row of openingRows as any[]) {
        opening.set(
          row.accountId,
          (row._sum.baseDebit ?? ZERO).minus(row._sum.baseCredit ?? ZERO),
        );
      }
    }

    // ─── Period movement ───────────────────────────────────────────────────
    const periodWhere = {
      ...dimensionWhere,
      entry: {
        ...(dimensionWhere as any).entry,
        ...(from || to
          ? { postingDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
    } as any;

    const movementRows = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: periodWhere,
      _sum: { baseDebit: true, baseCredit: true },
      _count: { _all: true },
    });
    const movement = new Map<
      string,
      { debit: Prisma.Decimal; credit: Prisma.Decimal; count: number }
    >();
    for (const row of movementRows as any[]) {
      movement.set(row.accountId, {
        debit: row._sum.baseDebit ?? ZERO,
        credit: row._sum.baseCredit ?? ZERO,
        count: row._count?._all ?? 0,
      });
    }

    const totalLines = [...movement.values()].reduce((n, m) => n + m.count, 0);
    const truncated = !query.summaryOnly && totalLines > maxLines;

    // ─── Transaction detail ────────────────────────────────────────────────
    const linesByAccount = new Map<string, any[]>();
    if (!query.summaryOnly) {
      const lines = await this.prisma.client.journalLine.findMany({
        where: periodWhere,
        include: { entry: { include: { journal: true } } },
        orderBy: [{ entry: { postingDate: 'asc' } }, { journalEntryId: 'asc' }, { lineNumber: 'asc' }],
        take: maxLines,
      });
      for (const line of lines as any[]) {
        const bucket = linesByAccount.get(line.accountId);
        if (bucket) bucket.push(line);
        else linesByAccount.set(line.accountId, [line]);
      }
    }

    const labels = await this.labels(
      [...linesByAccount.values()].flat(),
    );

    // ─── Assemble ──────────────────────────────────────────────────────────
    const accountIds = new Set<string>([...opening.keys(), ...movement.keys()]);
    if (scopedAccountIds && query.includeZero) {
      for (const id of scopedAccountIds) accountIds.add(id);
    }

    const rows: DetailedReportAccount[] = [];
    let totalOpening = ZERO;
    let totalDebit = ZERO;
    let totalCredit = ZERO;

    for (const accountId of accountIds) {
      const meta = allMeta.get(accountId);
      if (!meta) continue;
      if (scopedAccountIds && !scopedAccountIds.includes(accountId)) continue;

      const open = opening.get(accountId) ?? ZERO;
      const move = movement.get(accountId) ?? { debit: ZERO, credit: ZERO, count: 0 };
      const net = move.debit.minus(move.credit);
      const close = open.plus(net);

      if (!query.includeZero && open.isZero() && move.count === 0) continue;

      let running = open;
      const lines: DetailedReportLine[] = (linesByAccount.get(accountId) ?? []).map((l) => {
        running = running.plus(l.baseDebit).minus(l.baseCredit);
        return {
          id: l.id,
          date: l.entry.postingDate,
          entryId: l.entry.id,
          entryNumber: l.entry.entryNumber,
          entryStatus: l.entry.status,
          journalCode: l.entry.journal?.code ?? null,
          journalName: l.entry.journal?.name ?? null,
          sourceType: l.entry.sourceType ?? null,
          sourceId: l.entry.sourceId ?? null,
          partnerName: l.partnerId ? labels.partners.get(l.partnerId) ?? null : null,
          branchName: l.branchId ? labels.branches.get(l.branchId) ?? null : null,
          costCenterName: l.costCenterId ? labels.costCenters.get(l.costCenterId) ?? null : null,
          description: l.description ?? l.entry.description ?? null,
          debit: (l.baseDebit as Prisma.Decimal).toString(),
          credit: (l.baseCredit as Prisma.Decimal).toString(),
          balance: running.toString(),
        };
      });

      totalOpening = totalOpening.plus(open);
      totalDebit = totalDebit.plus(move.debit);
      totalCredit = totalCredit.plus(move.credit);

      rows.push({
        accountId,
        code: meta.code,
        name: meta.name,
        classification: meta.classification ?? null,
        categoryKey: meta.categoryKey ?? null,
        normalBalance: meta.normalBalance,
        opening: open.toString(),
        debit: move.debit.toString(),
        credit: move.credit.toString(),
        movement: net.toString(),
        closing: close.toString(),
        lineCount: move.count,
        lines,
      });
    }

    rows.sort((a, b) => {
      const am = allMeta.get(a.accountId);
      const bm = allMeta.get(b.accountId);
      return (am?.sortOrder ?? 0) - (bm?.sortOrder ?? 0) || a.code.localeCompare(b.code);
    });

    return {
      period: { from: from ?? null, to: to ?? null },
      filters: {
        accountIds: accountFilter,
        classification: query.classification ?? null,
        branchId: query.branchId ?? null,
        costCenterId: query.costCenterId ?? null,
        journalId: query.journalId ?? null,
        partnerId: query.partnerId ?? null,
        includeZero: !!query.includeZero,
        summaryOnly: !!query.summaryOnly,
      },
      accounts: rows,
      totals: {
        opening: totalOpening.toString(),
        debit: totalDebit.toString(),
        credit: totalCredit.toString(),
        movement: totalDebit.minus(totalCredit).toString(),
        closing: totalOpening.plus(totalDebit).minus(totalCredit).toString(),
        lineCount: totalLines,
      },
      /**
       * Debits equal credits only when the report covers every account. Any
       * account/classification filter legitimately breaks the tie-out, so the
       * client must not read `false` as corruption when a filter is on.
       */
      balanced: totalDebit.minus(totalCredit).abs().lessThanOrEqualTo(0.0001),
      filtered: !!(scopedAccountIds || query.branchId || query.costCenterId || query.journalId || query.partnerId),
      truncated,
      maxLines,
    };
  }

  /** Shared predicate: posted-only, plus whatever dimensions were requested. */
  private dimensionWhere(query: DetailedReportQuery, accountIds?: string[]): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      status: { in: [...BALANCE_AFFECTING_STATUSES] },
    };
    if (query.journalId) entry.journalId = query.journalId;

    const where: Record<string, unknown> = { entry };
    if (accountIds) where.accountId = { in: accountIds };
    if (query.branchId) where.branchId = query.branchId;
    if (query.costCenterId) where.costCenterId = query.costCenterId;
    if (query.partnerId) where.partnerId = query.partnerId;
    return where;
  }

  /** One batched lookup per dimension so the row mapper stays synchronous. */
  private async labels(lines: any[]) {
    const partnerIds = [...new Set(lines.map((l) => l.partnerId).filter(Boolean))] as string[];
    const branchIds = [...new Set(lines.map((l) => l.branchId).filter(Boolean))] as string[];
    const costCenterIds = [...new Set(lines.map((l) => l.costCenterId).filter(Boolean))] as string[];

    const [partners, branches, costCenters] = await Promise.all([
      partnerIds.length
        ? this.prisma.client.partner.findMany({
            where: { id: { in: partnerIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      branchIds.length
        ? this.prisma.client.branch.findMany({
            where: { id: { in: branchIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      costCenterIds.length
        ? this.prisma.client.costCenter.findMany({
            where: { id: { in: costCenterIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      partners: new Map((partners as any[]).map((p) => [p.id, p.name])),
      branches: new Map((branches as any[]).map((b) => [b.id, b.name])),
      costCenters: new Map((costCenters as any[]).map((c) => [c.id, c.name])),
    };
  }

  private empty(from: Date | undefined, to: Date | undefined, maxLines: number) {
    return {
      period: { from: from ?? null, to: to ?? null },
      filters: {},
      accounts: [] as DetailedReportAccount[],
      totals: { opening: '0', debit: '0', credit: '0', movement: '0', closing: '0', lineCount: 0 },
      balanced: true,
      filtered: true,
      truncated: false,
      maxLines,
    };
  }
}
