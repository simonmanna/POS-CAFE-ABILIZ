import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AccountResolverService } from '../posting/account-resolver.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Cash Flow Report — the operational counterpart to the accounting Cash Flow
 * Statement (`reporting/cash-flow-report.service.ts`).
 *
 * The statement answers "how much cash did operating/investing/financing
 * produce". This report answers the till-level question instead: *which*
 * movements happened, in or out of *which* payment account, driven by *what*
 * (POS sales, customer receipts, supplier payments, transfers, drawer ops …),
 * with drill-down rows behind every number.
 *
 * Every figure is derived from the same filtered movement set, so a rendered
 * filter is always a sent filter: summary, per-account, per-category and the
 * trend series can never disagree with the row list.
 *
 * Movement = one JournalLine on a cash-equivalent account. `baseDebit` is cash
 * in, `baseCredit` is cash out (both in org base currency, so mixed-currency
 * accounts still add up).
 */

/** Movement categories, derived from the journal entry's `sourceType`. */
export const CASH_MOVEMENT_CATEGORIES: { key: string; label: string; sourceTypes: string[] }[] = [
  { key: 'pos_sales', label: 'POS Sales', sourceTypes: ['pos', 'pos_invoice', 'pos_invoice_extra'] },
  {
    key: 'customer_receipts',
    label: 'Customer Receipts',
    sourceTypes: ['payment', 'invoice', 'sales_invoice', 'document', 'reservation', 'agreement'],
  },
  {
    key: 'refunds',
    label: 'Refunds & Credits',
    sourceTypes: ['pos_refund', 'credit_note', 'pos_invoice_writeoff', 'store_credit_issue'],
  },
  {
    key: 'supplier_payments',
    label: 'Supplier Payments',
    sourceTypes: ['purchase_payment', 'vendor_bill', 'debit_note', 'purchase_order', 'goods_receipt'],
  },
  { key: 'expenses', label: 'Expenses', sourceTypes: ['expense_payment'] },
  { key: 'payroll', label: 'Payroll', sourceTypes: ['payroll_run'] },
  { key: 'transfers', label: 'Internal Transfers', sourceTypes: ['treasury_transfer'] },
  { key: 'deposits', label: 'Deposits', sourceTypes: ['cash_flow_deposit'] },
  { key: 'withdrawals', label: 'Withdrawals', sourceTypes: ['cash_flow_withdrawal'] },
  {
    key: 'cash_drawer',
    label: 'Cash Drawer',
    sourceTypes: [
      'cash_movement',
      'cash_session_opening',
      'cash_session_variance',
      'drawer_account_split',
    ],
  },
  { key: 'tender_settlement', label: 'Tender Settlement', sourceTypes: ['tender_settlement'] },
  { key: 'rental', label: 'Rental', sourceTypes: ['rental_checkout', 'rental_inspect', 'rental_return'] },
  {
    key: 'adjustments',
    label: 'Manual & Adjustments',
    sourceTypes: [
      'manual',
      'reversal',
      'fx_revaluation',
      'period_close',
      'recurring',
      'a009_legacy_adjustment',
    ],
  },
];

const OTHER_CATEGORY = { key: 'other', label: 'Other', sourceTypes: [] as string[] };

const CATEGORY_OF_SOURCE = new Map<string, string>();
for (const c of CASH_MOVEMENT_CATEGORIES) {
  for (const st of c.sourceTypes) CATEGORY_OF_SOURCE.set(st, c.key);
}
const KNOWN_SOURCE_TYPES = [...CATEGORY_OF_SOURCE.keys()];

const CATEGORY_LABEL = new Map<string, string>(
  [...CASH_MOVEMENT_CATEGORIES, OTHER_CATEGORY].map((c) => [c.key, c.label]),
);

export type CashMovementGrouping = 'day' | 'week' | 'month';

export interface CashMovementReportFilters {
  from?: string;
  to?: string;
  /** Restrict to these payment accounts (empty = all cash-equivalent accounts). */
  accountIds?: string[];
  /** Restrict by payment-account category key: cash | bank | mobile_money | petty_cash. */
  accountTypes?: string[];
  /** Movement categories (see CASH_MOVEMENT_CATEGORIES, plus 'other'). */
  categories?: string[];
  direction?: 'in' | 'out' | 'all';
  /** Free text over entry number, description and account name. */
  search?: string;
  /** Only movements at or above this base-currency amount. */
  minAmount?: number;
  groupBy?: CashMovementGrouping;
  page?: number;
  pageSize?: number;
}

interface RawRow {
  id: string;
  journalEntryId: string;
  entryNumber: string;
  postingDate: Date;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  baseDebit: string;
  baseCredit: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string | null;
  branchName: string | null;
  costCenterName: string | null;
}

@Injectable()
export class CashMovementReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly accounts: AccountResolverService,
  ) {}

  async report(filters: CashMovementReportFilters) {
    const orgId = this.tenant.organizationId;
    const from = this.parseDate(filters.from, 'from');
    const to = this.parseDate(filters.to, 'to', true);
    if (from && to && from > to) {
      throw new BadRequestException('`from` must be on or before `to`');
    }

    const page = Math.max(1, Number(filters.page ?? 1) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(filters.pageSize ?? 50) || 50));
    const groupBy: CashMovementGrouping = filters.groupBy ?? 'day';

    // ── Scope: which payment accounts are in play ────────────────────────────
    const cashAccounts = await this.accounts.cashEquivalentAccounts();
    const accountMeta = new Map(cashAccounts.map((a) => [a.id, a]));

    let scopedIds = cashAccounts.map((a) => a.id);
    if (filters.accountTypes?.length) {
      const wanted = new Set(filters.accountTypes);
      scopedIds = scopedIds.filter((id) => wanted.has(accountMeta.get(id)?.categoryKey ?? ''));
    }
    if (filters.accountIds?.length) {
      const wanted = new Set(filters.accountIds);
      scopedIds = scopedIds.filter((id) => wanted.has(id));
    }

    const accountOptions = cashAccounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      accountType: a.categoryKey,
    }));

    if (scopedIds.length === 0) {
      return this.emptyReport(filters, page, pageSize, groupBy, accountOptions);
    }

    // ── WHERE: one filter builder feeds every query below ────────────────────
    const scope = Prisma.sql`
      jl."organizationId" = ${orgId}
      AND jl."accountId" IN (${Prisma.join(scopedIds)})
      AND je.status::text IN (${Prisma.join([...BALANCE_AFFECTING_STATUSES].map((s) => String(s)))})
    `;
    const where = Prisma.sql`${scope} ${this.movementFilters(filters, from, to)}`;

    const [totals, rows, byAccount, byCategory, series, opening] = await Promise.all([
      this.queryTotals(where),
      this.queryRows(where, page, pageSize),
      this.queryByAccount(where),
      this.queryByCategory(where),
      this.querySeries(where, groupBy),
      // Opening balance ignores the movement filters (type/category/search) on
      // purpose — it is a *balance*, so only the account scope applies.
      from ? this.queryOpening(scope, from) : Promise.resolve({ inflow: 0, outflow: 0 }),
    ]);

    const counterparties = await this.queryCounterparties(rows);

    const cashIn = totals.inflow;
    const cashOut = totals.outflow;
    const openingBalance = opening.inflow - opening.outflow;

    return {
      filters: {
        from: filters.from ?? null,
        to: filters.to ?? null,
        accountIds: filters.accountIds ?? [],
        accountTypes: filters.accountTypes ?? [],
        categories: filters.categories ?? [],
        direction: filters.direction ?? 'all',
        search: filters.search ?? '',
        minAmount: filters.minAmount ?? null,
        groupBy,
      },
      summary: {
        openingBalance: openingBalance.toFixed(2),
        cashIn: cashIn.toFixed(2),
        cashOut: cashOut.toFixed(2),
        netChange: (cashIn - cashOut).toFixed(2),
        closingBalance: (openingBalance + cashIn - cashOut).toFixed(2),
        movementCount: totals.count,
        inflowCount: totals.inflowCount,
        outflowCount: totals.outflowCount,
        largestInflow: totals.largestInflow.toFixed(2),
        largestOutflow: totals.largestOutflow.toFixed(2),
      },
      data: rows.map((r) => {
        const inflow = Number(r.baseDebit);
        const outflow = Number(r.baseCredit);
        const category = this.categoryOf(r.sourceType);
        return {
          id: r.id,
          journalEntryId: r.journalEntryId,
          entryNumber: r.entryNumber,
          date: r.postingDate,
          description: r.description,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          category,
          categoryLabel: CATEGORY_LABEL.get(category) ?? 'Other',
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountName: r.accountName,
          accountType: r.accountType,
          branchName: r.branchName,
          costCenterName: r.costCenterName,
          direction: inflow > 0 ? ('in' as const) : ('out' as const),
          inflow: inflow.toFixed(2),
          outflow: outflow.toFixed(2),
          amount: (inflow > 0 ? inflow : outflow).toFixed(2),
          signedAmount: (inflow - outflow).toFixed(2),
          counterparties: counterparties.get(r.id) ?? [],
        };
      }),
      byAccount: byAccount.map((a) => {
        const meta = accountMeta.get(a.accountId);
        return {
          accountId: a.accountId,
          code: meta?.code ?? '',
          name: meta?.name ?? '',
          accountType: meta?.categoryKey ?? null,
          cashIn: a.inflow.toFixed(2),
          cashOut: a.outflow.toFixed(2),
          net: (a.inflow - a.outflow).toFixed(2),
          movementCount: a.count,
        };
      }),
      byCategory: byCategory.map((c) => ({
        category: c.category,
        label: CATEGORY_LABEL.get(c.category) ?? 'Other',
        cashIn: c.inflow.toFixed(2),
        cashOut: c.outflow.toFixed(2),
        net: (c.inflow - c.outflow).toFixed(2),
        movementCount: c.count,
      })),
      series: this.withRunningBalance(series, openingBalance),
      accountOptions,
      categoryOptions: [...CASH_MOVEMENT_CATEGORIES, OTHER_CATEGORY].map((c) => ({
        key: c.key,
        label: c.label,
      })),
      page,
      pageSize,
      total: totals.count,
      totalPages: Math.max(1, Math.ceil(totals.count / pageSize)),
    };
  }

  // ───────────────────────────── filters ──────────────────────────────────────

  private movementFilters(
    f: CashMovementReportFilters,
    from?: Date,
    to?: Date,
  ): Prisma.Sql {
    const parts: Prisma.Sql[] = [];

    if (from) parts.push(Prisma.sql`je."postingDate" >= ${from}`);
    if (to) parts.push(Prisma.sql`je."postingDate" <= ${to}`);

    if (f.direction === 'in') parts.push(Prisma.sql`jl."baseDebit" > 0`);
    if (f.direction === 'out') parts.push(Prisma.sql`jl."baseCredit" > 0`);

    if (f.categories?.length) {
      const keys = new Set(f.categories);
      const sourceTypes = KNOWN_SOURCE_TYPES.filter((st) => keys.has(CATEGORY_OF_SOURCE.get(st)!));
      const clauses: Prisma.Sql[] = [];
      if (sourceTypes.length) {
        clauses.push(Prisma.sql`je."sourceType" IN (${Prisma.join(sourceTypes)})`);
      }
      if (keys.has('other')) {
        // 'other' = anything the map does not know about, NULL included.
        clauses.push(
          Prisma.sql`(je."sourceType" IS NULL OR je."sourceType" NOT IN (${Prisma.join(KNOWN_SOURCE_TYPES)}))`,
        );
      }
      // A category filter that resolves to nothing must return nothing.
      parts.push(clauses.length ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})` : Prisma.sql`FALSE`);
    }

    const q = f.search?.trim();
    if (q) {
      const like = `%${q}%`;
      parts.push(Prisma.sql`(
        je."entryNumber" ILIKE ${like}
        OR je.description ILIKE ${like}
        OR jl.description ILIKE ${like}
        OR a.name ILIKE ${like}
        OR a.code ILIKE ${like}
      )`);
    }

    const min = Number(f.minAmount);
    if (Number.isFinite(min) && min > 0) {
      parts.push(Prisma.sql`GREATEST(jl."baseDebit", jl."baseCredit") >= ${new Prisma.Decimal(min)}`);
    }

    return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
  }

  /** FROM clause shared by every aggregate — `a` is joined so filters can hit it. */
  private get fromClause(): Prisma.Sql {
    return Prisma.sql`
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      JOIN "Account" a ON a.id = jl."accountId"
    `;
  }

  // ───────────────────────────── queries ──────────────────────────────────────

  private async queryTotals(where: Prisma.Sql) {
    const rows = await this.prisma.raw.$queryRaw<
      {
        count: bigint;
        inflow: string;
        outflow: string;
        inflow_count: bigint;
        outflow_count: bigint;
        max_in: string;
        max_out: string;
      }[]
    >(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS count,
        COALESCE(SUM(jl."baseDebit"), 0)::text AS inflow,
        COALESCE(SUM(jl."baseCredit"), 0)::text AS outflow,
        COUNT(*) FILTER (WHERE jl."baseDebit" > 0)::bigint AS inflow_count,
        COUNT(*) FILTER (WHERE jl."baseCredit" > 0)::bigint AS outflow_count,
        COALESCE(MAX(jl."baseDebit"), 0)::text AS max_in,
        COALESCE(MAX(jl."baseCredit"), 0)::text AS max_out
      ${this.fromClause}
      WHERE ${where}
    `);
    const r = rows[0];
    return {
      count: Number(r?.count ?? 0),
      inflow: Number(r?.inflow ?? 0),
      outflow: Number(r?.outflow ?? 0),
      inflowCount: Number(r?.inflow_count ?? 0),
      outflowCount: Number(r?.outflow_count ?? 0),
      largestInflow: Number(r?.max_in ?? 0),
      largestOutflow: Number(r?.max_out ?? 0),
    };
  }

  private async queryRows(where: Prisma.Sql, page: number, pageSize: number) {
    return this.prisma.raw.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT
        jl.id,
        jl."journalEntryId",
        je."entryNumber",
        je."postingDate",
        COALESCE(je.description, jl.description) AS description,
        je."sourceType",
        je."sourceId",
        jl."baseDebit"::text AS "baseDebit",
        jl."baseCredit"::text AS "baseCredit",
        jl."accountId",
        a.code AS "accountCode",
        a.name AS "accountName",
        ac.key AS "accountType",
        br.name AS "branchName",
        cc.name AS "costCenterName"
      ${this.fromClause}
      LEFT JOIN "AccountCategory" ac ON ac.id = a."categoryId"
      LEFT JOIN "Branch" br ON br.id = COALESCE(jl."branchId", je."branchId")
      LEFT JOIN "CostCenter" cc ON cc.id = COALESCE(jl."costCenterId", je."costCenterId")
      WHERE jl."organizationId" = ${this.tenant.organizationId} AND ${where}
      ORDER BY je."postingDate" DESC, je."entryNumber" DESC, jl."lineNumber" ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
  }

  private async queryByAccount(where: Prisma.Sql) {
    const rows = await this.prisma.raw.$queryRaw<
      { accountId: string; inflow: string; outflow: string; count: bigint }[]
    >(Prisma.sql`
      SELECT
        jl."accountId",
        COALESCE(SUM(jl."baseDebit"), 0)::text AS inflow,
        COALESCE(SUM(jl."baseCredit"), 0)::text AS outflow,
        COUNT(*)::bigint AS count
      ${this.fromClause}
      WHERE ${where}
      GROUP BY jl."accountId"
    `);
    return rows
      .map((r) => ({
        accountId: r.accountId,
        inflow: Number(r.inflow),
        outflow: Number(r.outflow),
        count: Number(r.count),
      }))
      .sort((x, y) => y.inflow + y.outflow - (x.inflow + x.outflow));
  }

  /**
   * Grouped by `sourceType` in SQL, then folded into categories in JS — the
   * source-type → category map lives in one place (CASH_MOVEMENT_CATEGORIES)
   * and is not duplicated as a pile of CASE branches.
   */
  private async queryByCategory(where: Prisma.Sql) {
    const rows = await this.prisma.raw.$queryRaw<
      { sourceType: string | null; inflow: string; outflow: string; count: bigint }[]
    >(Prisma.sql`
      SELECT
        je."sourceType",
        COALESCE(SUM(jl."baseDebit"), 0)::text AS inflow,
        COALESCE(SUM(jl."baseCredit"), 0)::text AS outflow,
        COUNT(*)::bigint AS count
      ${this.fromClause}
      WHERE ${where}
      GROUP BY je."sourceType"
    `);

    const acc = new Map<string, { category: string; inflow: number; outflow: number; count: number }>();
    for (const r of rows) {
      const category = this.categoryOf(r.sourceType);
      const cur = acc.get(category) ?? { category, inflow: 0, outflow: 0, count: 0 };
      cur.inflow += Number(r.inflow);
      cur.outflow += Number(r.outflow);
      cur.count += Number(r.count);
      acc.set(category, cur);
    }
    return [...acc.values()].sort(
      (x, y) => y.inflow + y.outflow - (x.inflow + x.outflow),
    );
  }

  private async querySeries(where: Prisma.Sql, groupBy: CashMovementGrouping) {
    const unit = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';
    const rows = await this.prisma.raw.$queryRaw<
      { period: Date; inflow: string; outflow: string; count: bigint }[]
    >(Prisma.sql`
      SELECT
        date_trunc(${unit}, je."postingDate") AS period,
        COALESCE(SUM(jl."baseDebit"), 0)::text AS inflow,
        COALESCE(SUM(jl."baseCredit"), 0)::text AS outflow,
        COUNT(*)::bigint AS count
      ${this.fromClause}
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 ASC
    `);
    return rows.map((r) => ({
      period: r.period,
      inflow: Number(r.inflow),
      outflow: Number(r.outflow),
      count: Number(r.count),
    }));
  }

  /** Net movement on the scoped accounts strictly before `from`. */
  private async queryOpening(scope: Prisma.Sql, from: Date) {
    const rows = await this.prisma.raw.$queryRaw<{ inflow: string; outflow: string }[]>(Prisma.sql`
      SELECT
        COALESCE(SUM(jl."baseDebit"), 0)::text AS inflow,
        COALESCE(SUM(jl."baseCredit"), 0)::text AS outflow
      ${this.fromClause}
      WHERE ${scope} AND je."postingDate" < ${from}
    `);
    return { inflow: Number(rows[0]?.inflow ?? 0), outflow: Number(rows[0]?.outflow ?? 0) };
  }

  /**
   * The contra side of each listed movement: "Cash out 50,000 → *to what*".
   * Only the entries on the current page are fetched, so this stays cheap.
   */
  private async queryCounterparties(rows: RawRow[]) {
    const result = new Map<string, { code: string; name: string }[]>();
    if (rows.length === 0) return result;

    const entryIds = [...new Set(rows.map((r) => r.journalEntryId))];
    const legs = await this.prisma.raw.$queryRaw<
      {
        journalEntryId: string;
        lineId: string;
        code: string;
        name: string;
        baseDebit: string;
        baseCredit: string;
      }[]
    >(Prisma.sql`
      SELECT
        jl."journalEntryId",
        jl.id AS "lineId",
        a.code,
        a.name,
        jl."baseDebit"::text AS "baseDebit",
        jl."baseCredit"::text AS "baseCredit"
      FROM "JournalLine" jl
      JOIN "Account" a ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${this.tenant.organizationId} AND jl."journalEntryId" IN (${Prisma.join(entryIds)})
    `);

    const byEntry = new Map<string, typeof legs>();
    for (const l of legs) {
      const arr = byEntry.get(l.journalEntryId) ?? [];
      arr.push(l);
      byEntry.set(l.journalEntryId, arr);
    }

    for (const r of rows) {
      const inflow = Number(r.baseDebit) > 0;
      const siblings = byEntry.get(r.journalEntryId) ?? [];
      const contra = siblings.filter(
        // Opposite side of the same entry, and never the row itself.
        (s) => s.lineId !== r.id && (inflow ? Number(s.baseCredit) > 0 : Number(s.baseDebit) > 0),
      );
      const seen = new Set<string>();
      result.set(
        r.id,
        contra
          .filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)))
          .slice(0, 4)
          .map((c) => ({ code: c.code, name: c.name })),
      );
    }
    return result;
  }

  // ───────────────────────────── helpers ──────────────────────────────────────

  private categoryOf(sourceType: string | null): string {
    if (!sourceType) return 'other';
    return CATEGORY_OF_SOURCE.get(sourceType) ?? 'other';
  }

  private withRunningBalance(
    series: { period: Date; inflow: number; outflow: number; count: number }[],
    openingBalance: number,
  ) {
    let running = openingBalance;
    return series.map((s) => {
      running += s.inflow - s.outflow;
      return {
        period: s.period,
        cashIn: s.inflow.toFixed(2),
        cashOut: s.outflow.toFixed(2),
        net: (s.inflow - s.outflow).toFixed(2),
        runningBalance: running.toFixed(2),
        movementCount: s.count,
      };
    });
  }

  private parseDate(value: string | undefined, label: string, endOfDay = false): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid \`${label}\` date: ${value}`);
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      d.setUTCHours(23, 59, 59, 999);
    }
    return d;
  }

  private emptyReport(
    filters: CashMovementReportFilters,
    page: number,
    pageSize: number,
    groupBy: CashMovementGrouping,
    accountOptions: { id: string; code: string; name: string; accountType: string | null }[],
  ) {
    return {
      filters: {
        from: filters.from ?? null,
        to: filters.to ?? null,
        accountIds: filters.accountIds ?? [],
        accountTypes: filters.accountTypes ?? [],
        categories: filters.categories ?? [],
        direction: filters.direction ?? 'all',
        search: filters.search ?? '',
        minAmount: filters.minAmount ?? null,
        groupBy,
      },
      summary: {
        openingBalance: '0.00',
        cashIn: '0.00',
        cashOut: '0.00',
        netChange: '0.00',
        closingBalance: '0.00',
        movementCount: 0,
        inflowCount: 0,
        outflowCount: 0,
        largestInflow: '0.00',
        largestOutflow: '0.00',
      },
      data: [],
      byAccount: [],
      byCategory: [],
      series: [],
      accountOptions,
      categoryOptions: [...CASH_MOVEMENT_CATEGORIES, OTHER_CATEGORY].map((c) => ({
        key: c.key,
        label: c.label,
      })),
      page,
      pageSize,
      total: 0,
      totalPages: 1,
    };
  }
}
