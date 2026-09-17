import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { dec } from '../../../kernel/common/money';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';
import { accountLedgerBalance } from './session-reconciliation';
import { EFFECTIVE_SOURCE_TYPE, POS_SALE_SOURCE_TYPES } from './money-activity.sql';
import { orgDateBound, orgTimezone } from './org-dates';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Payment kinds whose money waits on a provider account until it is settled to the bank. */
const SETTLEABLE_KINDS = ['mobile_money', 'card'];

export interface SettlementHistoryFilters {
  sourceAccountId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Provider settlements (card / mobile-money → bank). Read side only; posting
 * stays in `settleTender`. Figures are deliberately conservative: there is no
 * payment-to-settlement allocation, so nothing here is called "pending" — the
 * UI shows the provider-account balance and POS receipts since the last
 * recorded settlement as a suggestion to verify against the provider statement.
 */
@Injectable()
export class MoneySettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async sources() {
    const orgId = this.tenant.organizationId;
    const methods = await this.prisma.client.posPaymentMethod.findMany({
      where: { organizationId: orgId, deletedAt: null, kind: { in: SETTLEABLE_KINDS }, accountId: { not: null } },
      select: { id: true, label: true, kind: true, isActive: true, accountId: true, account: { select: { id: true, code: true, name: true, isActive: true, deletedAt: true, category: { select: { key: true } } } } },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });

    // One card per financial account; methods sharing an account become chips.
    const byAccount = new Map<string, { account: any; methods: any[] }>();
    for (const m of methods as any[]) {
      if (!m.account || !m.account.isActive || m.account.deletedAt) continue;
      const cur = byAccount.get(m.accountId) ?? { account: m.account, methods: [] };
      cur.methods.push({ id: m.id, label: m.label, kind: m.kind, isActive: m.isActive });
      byAccount.set(m.accountId, cur);
    }
    const accountIds = [...byAccount.keys()];

    const last = accountIds.length
      ? await this.prisma.client.tenderSettlement.groupBy({
        by: ['sourceAccountId'],
        where: { organizationId: orgId, sourceAccountId: { in: accountIds } },
        _max: { settledAt: true },
        _count: { _all: true },
      })
      : [];
    const lastOf = new Map((last as any[]).map((l) => [l.sourceAccountId, { at: l._max.settledAt as Date | null, count: l._count._all as number }]));

    const sources = [];
    for (const [accountId, { account, methods: chips }] of byAccount) {
      const balance = await accountLedgerBalance(this.prisma.client, orgId, accountId);
      const lastAt = lastOf.get(accountId)?.at ?? null;
      const posReceipts = await this.posReceiptsSince(accountId, lastAt);
      const suggested = Prisma.Decimal.max(0, Prisma.Decimal.min(posReceipts, balance));
      sources.push({
        accountId,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.category?.key ?? null,
        methods: chips,
        balance: balance.toFixed(2),
        posReceiptsSinceLastSettlement: posReceipts.toFixed(2),
        suggestedAmount: suggested.toFixed(2),
        lastSettledAt: lastAt,
        settlementCount: lastOf.get(accountId)?.count ?? 0,
      });
    }

    const [destinations, feeAccounts, org] = await Promise.all([
      this.prisma.client.account.findMany({
        where: { organizationId: orgId, isActive: true, deletedAt: null, isPostable: true, category: { key: 'bank' } },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.client.account.findMany({
        where: { organizationId: orgId, isActive: true, deletedAt: null, isPostable: true, category: { classification: 'expense' } },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.client.organization.findUnique({ where: { id: orgId }, select: { currencyCode: true } }),
    ]);

    return { currencyCode: (org as any)?.currencyCode ?? null, sources, destinations, feeAccounts };
  }

  async history(filters: SettlementHistoryFilters) {
    const orgId = this.tenant.organizationId;
    const page = Math.max(1, Number(filters.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize ?? 25) || 25));
    const where: any = { organizationId: orgId };
    if (filters.sourceAccountId) where.sourceAccountId = filters.sourceAccountId;
    const timezone = await orgTimezone(this.prisma, orgId);
    const from = orgDateBound(filters.from, 'from', timezone, 'start');
    const to = orgDateBound(filters.to, 'to', timezone, 'end');
    if (from || to) where.settledAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

    const [total, rows] = await Promise.all([
      this.prisma.client.tenderSettlement.count({ where }),
      this.prisma.client.tenderSettlement.findMany({
        where,
        orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const accountIds = [...new Set((rows as any[]).flatMap((r) => [r.sourceAccountId, r.destinationAccountId, r.feeAccountId]).filter(Boolean))];
    const sessionIds = [...new Set((rows as any[]).map((r) => r.cashSessionId).filter(Boolean))];
    const [accounts, sessions] = await Promise.all([
      accountIds.length ? this.prisma.client.account.findMany({ where: { organizationId: orgId, id: { in: accountIds } }, select: { id: true, code: true, name: true } }) : [],
      sessionIds.length ? this.prisma.client.cashSession.findMany({ where: { organizationId: orgId, id: { in: sessionIds } }, select: { id: true, openedAt: true, cashRegister: { select: { name: true } } } }) : [],
    ]);
    const acc = new Map((accounts as any[]).map((a) => [a.id, a]));
    const ses = new Map((sessions as any[]).map((s) => [s.id, s]));

    return {
      data: (rows as any[]).map((r) => {
        const gross = dec(r.grossAmount);
        const fee = dec(r.feeAmount ?? 0);
        const session = r.cashSessionId ? ses.get(r.cashSessionId) : null;
        return {
          id: r.id,
          settledAt: r.settledAt,
          reference: r.reference,
          source: acc.get(r.sourceAccountId) ?? { id: r.sourceAccountId, code: '', name: '—' },
          destination: acc.get(r.destinationAccountId) ?? { id: r.destinationAccountId, code: '', name: '—' },
          feeAccount: r.feeAccountId ? acc.get(r.feeAccountId) ?? null : null,
          grossAmount: gross.toFixed(2),
          feeAmount: fee.toFixed(2),
          netAmount: gross.minus(fee).toFixed(2),
          session: session ? { id: session.id, registerName: session.cashRegister?.name ?? null, openedAt: session.openedAt } : null,
          journalEntryId: r.journalEntryId ?? null,
        };
      }),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** Σ POS receipts booked to the provider account after the last settlement (all time if none). */
  private async posReceiptsSince(accountId: string, since: Date | null) {
    const rows = await this.prisma.raw.$queryRaw<{ total: string }[]>(Prisma.sql`
      SELECT COALESCE(SUM(jl."baseDebit" - jl."baseCredit"), 0)::text AS total
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      WHERE jl."organizationId" = ${this.tenant.organizationId}
        AND jl."accountId" = ${accountId}
        AND je.status::text IN (${Prisma.join([...BALANCE_AFFECTING_STATUSES].map(String))})
        AND ${EFFECTIVE_SOURCE_TYPE} IN (${Prisma.join([...POS_SALE_SOURCE_TYPES, 'pos_refund', 'pos_payment_refund'])})
        ${since ? Prisma.sql`AND je."postingDate" > ${since}` : Prisma.empty}
    `);
    return dec(rows[0]?.total ?? 0);
  }

}
