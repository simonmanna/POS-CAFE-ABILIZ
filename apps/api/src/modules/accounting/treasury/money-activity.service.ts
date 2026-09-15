import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AccountResolverService } from '../posting/account-resolver.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';
import { Prisma } from '@prisma/client';
import {
  CATEGORY_OPTIONS,
  classifyMoneyEntry,
  type MoneyActivityDirection,
  type MoneyActivityFigures,
} from './money-activity.taxonomy';
import { DIRECTION_SQL, EFFECTIVE_SOURCE_TYPE, categorySql } from './money-activity.sql';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MoneyActivityFilters {
  from?: string;
  to?: string;
  categories?: string[];
  accountId?: string;
  direction?: MoneyActivityDirection | 'all';
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface MoneyActivity extends MoneyActivityFigures {
  id: string;
  journalEntryId: string;
  entryNumber: string;
  occurredAt: Date;
  currencyCode: string | null;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: 'posted' | 'reversed';
  register: { id: string; name: string; sessionId: string } | null;
}

const SESSION_SOURCE_TYPES = new Set(['cash_session_opening', 'cash_session_banking', 'cash_session_variance']);

/**
 * Money Activity — one row per journal entry that touches a money account,
 * classified by the shared taxonomy with every money-account leg attached
 * (a split-tender sale is one activity with three legs, a transfer one
 * activity with two).
 */
@Injectable()
export class MoneyActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly accounts: AccountResolverService,
  ) {}

  async list(filters: MoneyActivityFilters) {
    const orgId = this.tenant.organizationId;
    const page = Math.max(1, Number(filters.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize ?? 25) || 25));
    const from = this.parseDate(filters.from, 'from');
    const to = this.parseDate(filters.to, 'to', true);
    if (from && to && from > to) throw new BadRequestException('`from` must be on or before `to`');

    const moneyAccounts = await this.accounts.cashEquivalentAccounts();
    const meta = new Map(moneyAccounts.map((a) => [a.id, a]));
    const moneyAccountIds = moneyAccounts.map((a) => a.id);
    if (filters.accountId && !moneyAccountIds.includes(filters.accountId)) {
      throw new BadRequestException('Account is not an active cash, bank or mobile-money account');
    }

    const org = await this.prisma.client.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true },
    });
    const currencyCode = (org as any)?.currencyCode ?? null;

    const empty = { data: [] as MoneyActivity[], total: 0, page, pageSize, totalPages: 1, currencyCode, categoryOptions: CATEGORY_OPTIONS };
    if (moneyAccountIds.length === 0) return empty;

    // ── Page of entry ids: classification, direction and filters all in SQL ──
    const statuses = [...BALANCE_AFFECTING_STATUSES].map(String);
    const where: Prisma.Sql[] = [
      Prisma.sql`je."organizationId" = ${orgId}`,
      Prisma.sql`je.status::text IN (${Prisma.join(statuses)})`,
      // Sums run over every money leg so direction matches the row's
      // classification; the account filter only selects which entries.
      Prisma.sql`jl."accountId" IN (${Prisma.join(moneyAccountIds)})`,
    ];
    if (filters.accountId) {
      where.push(Prisma.sql`EXISTS (SELECT 1 FROM "JournalLine" al WHERE al."journalEntryId" = je.id AND al."accountId" = ${filters.accountId})`);
    }
    if (from) where.push(Prisma.sql`je."postingDate" >= ${from}`);
    if (to) where.push(Prisma.sql`je."postingDate" <= ${to}`);
    if (filters.categories?.length) where.push(categorySql(filters.categories));
    const q = filters.search?.trim();
    if (q) {
      const like = `%${q}%`;
      where.push(Prisma.sql`(je."entryNumber" ILIKE ${like} OR je.description ILIKE ${like} OR EXISTS (
        SELECT 1 FROM "JournalLine" sl JOIN "Account" sa ON sa.id = sl."accountId"
        WHERE sl."journalEntryId" = je.id AND (sa.name ILIKE ${like} OR sa.code ILIKE ${like})
      ))`);
    }
    const directionFilter = filters.direction && filters.direction !== 'all'
      ? Prisma.sql`WHERE ${DIRECTION_SQL} = ${filters.direction}`
      : Prisma.empty;
    const base = Prisma.sql`
      FROM (
        SELECT je.id, je."postingDate", je."createdAt", ${EFFECTIVE_SOURCE_TYPE} AS eff,
          SUM(jl."baseDebit") AS d, SUM(jl."baseCredit") AS c
        FROM "JournalEntry" je
        JOIN "JournalLine" jl ON jl."journalEntryId" = je.id
        WHERE ${Prisma.join(where, ' AND ')}
        GROUP BY je.id
      ) x
      ${directionFilter}
    `;
    const [countRows, idRows] = await Promise.all([
      this.prisma.raw.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS n ${base}`),
      this.prisma.raw.$queryRaw<{ id: string; eff: string | null }[]>(Prisma.sql`
        SELECT x.id, x.eff ${base}
        ORDER BY x."postingDate" DESC, x."createdAt" DESC, x.id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
    ]);
    const total = Number(countRows[0]?.n ?? 0);
    const effOf = new Map(idRows.map((r) => [r.id, r.eff]));

    const moneyIds = new Set(moneyAccountIds);
    const entries = idRows.length
      ? await this.prisma.client.journalEntry.findMany({
        where: { organizationId: orgId, id: { in: idRows.map((r) => r.id) } },
        select: {
          id: true, entryNumber: true, postingDate: true, description: true,
          sourceType: true, sourceId: true, status: true,
          lines: { select: { accountId: true, baseDebit: true, baseCredit: true, account: { select: { name: true } } } },
        },
      })
      : [];
    const byId = new Map((entries as any[]).map((e) => [e.id, e]));

    const data: MoneyActivity[] = idRows.map((r) => byId.get(r.id)).filter(Boolean).map((entry: any) => {
      const moneyLines = entry.lines
        .filter((l: any) => moneyIds.has(l.accountId))
        .map((l: any) => ({
          accountId: l.accountId,
          accountName: meta.get(l.accountId)?.name ?? l.account?.name ?? '—',
          accountType: meta.get(l.accountId)?.categoryKey ?? null,
          baseDebit: l.baseDebit.toString(),
          baseCredit: l.baseCredit.toString(),
        }));
      return {
        id: entry.id,
        journalEntryId: entry.id,
        entryNumber: entry.entryNumber,
        occurredAt: entry.postingDate,
        currencyCode,
        description: entry.description ?? null,
        sourceType: entry.sourceType ?? null,
        sourceId: entry.sourceId ?? null,
        status: String(entry.status) === 'reversed' ? 'reversed' as const : 'posted' as const,
        register: null,
        ...classifyMoneyEntry(effOf.get(entry.id) ?? entry.sourceType, moneyLines),
      };
    });

    await this.attachRegisters(data);

    const totals = data.reduce(
      (t, a) => {
        if (a.status === 'reversed') return t;
        t.externalIn += Number(a.externalIn);
        t.externalOut += Number(a.externalOut);
        t.internalMoved += Number(a.internalMoved);
        return t;
      },
      { externalIn: 0, externalOut: 0, internalMoved: 0 },
    );

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      currencyCode,
      /** Totals of the rows on this page (reversed entries excluded). */
      pageTotals: {
        externalIn: totals.externalIn.toFixed(2),
        externalOut: totals.externalOut.toFixed(2),
        internalMoved: totals.internalMoved.toFixed(2),
      },
      categoryOptions: CATEGORY_OPTIONS,
    };
  }

  /** Resolve the register/shift behind drawer movements, shift postings and settlements. */
  private async attachRegisters(rows: MoneyActivity[]) {
    if (rows.length === 0) return;
    const orgId = this.tenant.organizationId;
    const entryIds = rows.map((r) => r.journalEntryId);
    const sessionOfEntry = new Map<string, string>();

    const paymentIds = rows.filter((r) => r.sourceType === 'payment' && r.sourceId).map((r) => r.sourceId!);
    const [movements, settlements, payments] = await Promise.all([
      this.prisma.client.cashMovement.findMany({
        where: { organizationId: orgId, journalEntryId: { in: entryIds } },
        select: { journalEntryId: true, cashSessionId: true },
      }),
      this.prisma.client.tenderSettlement.findMany({
        where: { organizationId: orgId, journalEntryId: { in: entryIds }, cashSessionId: { not: null } },
        select: { journalEntryId: true, cashSessionId: true },
      }),
      paymentIds.length
        ? this.prisma.client.payment.findMany({
          where: { organizationId: orgId, id: { in: paymentIds }, cashSessionId: { not: null } },
          select: { journalEntryId: true, cashSessionId: true },
        })
        : Promise.resolve([]),
    ]);
    for (const m of [...movements, ...settlements, ...payments] as any[]) {
      if (m.journalEntryId && m.cashSessionId) sessionOfEntry.set(m.journalEntryId, m.cashSessionId);
    }
    for (const r of rows) {
      if (r.sourceType && SESSION_SOURCE_TYPES.has(r.sourceType) && r.sourceId) sessionOfEntry.set(r.journalEntryId, r.sourceId);
    }
    if (sessionOfEntry.size === 0) return;

    const sessions = await this.prisma.client.cashSession.findMany({
      where: { organizationId: orgId, id: { in: [...new Set(sessionOfEntry.values())] } },
      select: { id: true, cashRegister: { select: { id: true, name: true } } },
    });
    const byId = new Map((sessions as any[]).map((s) => [s.id, s]));
    for (const r of rows) {
      const s = byId.get(sessionOfEntry.get(r.journalEntryId) ?? '');
      if (s?.cashRegister) r.register = { id: s.cashRegister.id, name: s.cashRegister.name, sessionId: s.id };
    }
  }

  private parseDate(value: string | undefined, label: string, endOfDay = false): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid \`${label}\` date: ${value}`);
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) d.setUTCHours(23, 59, 59, 999);
    return d;
  }
}
