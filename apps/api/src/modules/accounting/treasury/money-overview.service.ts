import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';
import { CashFlowService } from './cash-flow.service';
import { CashSessionService, zonedDayRange } from './cash-session.service';
import { MoneyActivityService } from './money-activity.service';
import { EFFECTIVE_SOURCE_TYPE, POS_SALE_SOURCE_TYPES } from './money-activity.sql';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type AttentionSeverity = 'warning' | 'info';

export interface AttentionItem {
  kind:
    | 'variance_unresolved'
    | 'awaiting_banking'
    | 'payment_method_unmapped'
    | 'register_open_too_long'
    | 'config_incomplete'
    | 'provider_no_recent_settlement';
  severity: AttentionSeverity;
  message: string;
  amount?: string;
  /** Front-end route that resolves the item. */
  href: string;
  actionLabel: string;
}

const positiveNumber = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Money & Accounts overview — "where is the money now, what changed today,
 * what needs attention". Every figure is a breakdown of posted GL balances on
 * money accounts; register expectations are operational detail of the drawer
 * slice, never added on top.
 */
@Injectable()
export class MoneyOverviewService {
  private readonly registerOpenHours = positiveNumber(process.env.MONEY_REGISTER_OPEN_HOURS, 16);
  private readonly settlementReminderDays = positiveNumber(process.env.MONEY_SETTLEMENT_REMINDER_DAYS, 5);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cashFlow: CashFlowService,
    private readonly sessions: CashSessionService,
    private readonly activity: MoneyActivityService,
  ) {}

  async overview() {
    const orgId = this.tenant.organizationId;
    const org = await this.prisma.client.organization.findUnique({
      where: { id: orgId },
      select: { currencyCode: true, timezone: true },
    });
    const baseCurrency: string | null = (org as any)?.currencyCode ?? null;
    const timezone: string = (org as any)?.timezone || 'UTC';

    const [accounts, registers, openSessions, methods, pendingVariances] = await Promise.all([
      this.cashFlow.getCashAccounts(),
      this.prisma.client.cashRegister.findMany({
        where: { organizationId: orgId, isActive: true, deletedAt: null },
        select: { id: true, code: true, name: true, defaultAccountId: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.client.cashSession.findMany({
        where: { organizationId: orgId, status: 'open' },
        select: { id: true, cashRegisterId: true, userId: true, openedAt: true, drawerAccountId: true, cashRegister: { select: { id: true, name: true } } },
        orderBy: { openedAt: 'asc' },
      }),
      this.prisma.client.posPaymentMethod.findMany({
        where: { organizationId: orgId, deletedAt: null, isActive: true },
        select: { id: true, label: true, kind: true, accountId: true, account: { select: { id: true, name: true, isActive: true, deletedAt: true } } },
      }),
      this.prisma.client.cashSession.findMany({
        where: { organizationId: orgId, status: 'closed', varianceStatus: 'pending_review' },
        select: { id: true, closingDifference: true, closedAt: true, cashRegister: { select: { name: true } } },
        orderBy: { closedAt: 'desc' },
        take: 20,
      }),
    ]);

    // ── Balances (base currency only) ──────────────────────────────────────
    const inBase = (a: any) => !a.currencyId || !baseCurrency || a.currencyId === baseCurrency;
    const drawerIds = new Set<string>([
      ...registers.map((r: any) => r.defaultAccountId).filter(Boolean),
      ...openSessions.map((s: any) => s.drawerAccountId).filter(Boolean),
    ]);
    const balanceOf = new Map(accounts.map((a: any) => [a.id, Number(a.balance)]));

    const GROUPS: Record<string, { key: string; label: string }> = {
      drawer: { key: 'drawers', label: 'Register drawers' },
      bank: { key: 'bank', label: 'Bank' },
      mobile_money: { key: 'mobile_money', label: 'Mobile money' },
      petty_cash: { key: 'petty_cash', label: 'Petty cash' },
      cash: { key: 'cash', label: 'Cash & safe' },
    };
    const byType = new Map<string, { key: string; label: string; balance: number; accountCount: number }>();
    let total = 0;
    const foreign: { id: string; name: string; currencyId: string }[] = [];
    for (const a of accounts as any[]) {
      if (!inBase(a)) { foreign.push({ id: a.id, name: a.name, currencyId: a.currencyId }); continue; }
      const g = drawerIds.has(a.id) ? GROUPS.drawer : GROUPS[a.accountType] ?? { key: a.accountType ?? 'other', label: 'Other' };
      const cur = byType.get(g.key) ?? { ...g, balance: 0, accountCount: 0 };
      cur.balance += Number(a.balance);
      cur.accountCount += 1;
      byType.set(g.key, cur);
      total += Number(a.balance);
    }

    // ── Registers ──────────────────────────────────────────────────────────
    const users = openSessions.length
      ? await this.prisma.client.user.findMany({
        where: { id: { in: [...new Set(openSessions.map((s: any) => s.userId))] } },
        select: { id: true, firstName: true, lastName: true },
      })
      : [];
    const userName = new Map((users as any[]).map((u) => [u.id, `${u.firstName}${u.lastName ? ` ${u.lastName}` : ''}`]));
    const now = Date.now();
    const openRegisters = await Promise.all(openSessions.map(async (s: any) => ({
      registerId: s.cashRegisterId,
      registerName: s.cashRegister?.name ?? '—',
      sessionId: s.id,
      cashierName: userName.get(s.userId) ?? null,
      openedAt: s.openedAt,
      hoursOpen: Math.floor((now - new Date(s.openedAt).getTime()) / 36e5),
      expectedCash: (await this.sessions.expectedCash(s.id)).toFixed(2),
    })));
    const openRegisterIds = new Set(openSessions.map((s: any) => s.cashRegisterId));
    const closedDrawers = registers
      .filter((r: any) => !openRegisterIds.has(r.id) && (balanceOf.get(r.defaultAccountId) ?? 0) > 0)
      .map((r: any) => ({ registerId: r.id, registerName: r.name, accountId: r.defaultAccountId, amount: (balanceOf.get(r.defaultAccountId) ?? 0).toFixed(2) }));
    const cashAwaitingBanking = closedDrawers.reduce((n, d) => n + Number(d.amount), 0);

    // ── Today (org time zone) ──────────────────────────────────────────────
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const { start, end } = zonedDayRange(todayStr, timezone);
    const today = await this.todayTotals(accounts.map((a: any) => a.id), start, end);

    // ── Needs attention (reliable signals only) ────────────────────────────
    const attention: AttentionItem[] = [];
    for (const v of pendingVariances as any[]) {
      const diff = Number(v.closingDifference ?? 0);
      attention.push({
        kind: 'variance_unresolved', severity: 'warning',
        message: `${v.cashRegister?.name ?? 'A register'} closed ${diff < 0 ? 'short' : 'over'} and the variance has not been reviewed`,
        amount: Math.abs(diff).toFixed(2), href: '/pos/cash-registers?tab=history', actionLabel: 'Review variance',
      });
    }
    for (const d of closedDrawers) {
      attention.push({
        kind: 'awaiting_banking', severity: 'warning',
        message: `${d.registerName} has cash from closed shifts that has not been banked`,
        amount: d.amount, href: '/pos/cash-registers?tab=history', actionLabel: 'Bank cash',
      });
    }
    for (const r of openRegisters) {
      if (r.hoursOpen >= this.registerOpenHours) {
        attention.push({
          kind: 'register_open_too_long', severity: 'warning',
          message: `${r.registerName} has been open for ${r.hoursOpen} hours${r.cashierName ? ` (${r.cashierName})` : ''}`,
          href: '/pos/cash-registers', actionLabel: 'View register',
        });
      }
    }
    for (const m of methods as any[]) {
      if (m.kind === 'cash' || m.kind === 'store_credit') continue;
      if (!m.accountId || !m.account || !m.account.isActive || m.account.deletedAt) {
        attention.push({
          kind: 'payment_method_unmapped', severity: 'warning',
          message: `${m.label} is not connected to an active receiving account`,
          href: '/settings/payment-methods', actionLabel: 'Connect account',
        });
      }
    }
    if (!(accounts as any[]).some((a) => a.accountType === 'bank')) {
      attention.push({
        kind: 'config_incomplete', severity: 'warning',
        message: 'No bank account exists yet, so cash cannot be banked and providers cannot be settled',
        href: '/accounts/cash-accounts/accounts?new=bank', actionLabel: 'Add bank account',
      });
    }
    if (registers.length === 0) {
      attention.push({
        kind: 'config_incomplete', severity: 'warning',
        message: 'No cash register is set up, so the POS cannot take cash',
        href: '/settings/registers', actionLabel: 'Add register',
      });
    }
    attention.push(...(await this.settlementReminders(methods as any[], balanceOf)));

    const recent = await this.activity.list({ page: 1, pageSize: 10 });

    return {
      baseCurrency,
      timezone,
      /** Organisation-local calendar date the "today" figures cover. */
      todayDate: todayStr,
      totalAvailableBookBalance: total.toFixed(2),
      byType: [...byType.values()]
        .sort((x, y) => y.balance - x.balance)
        .map((g) => ({ ...g, balance: g.balance.toFixed(2) })),
      foreignCurrencyAccounts: foreign,
      openRegisters,
      cashAwaitingBanking: cashAwaitingBanking.toFixed(2),
      closedDrawers,
      today,
      attention,
      recent: recent.data,
    };
  }

  private async todayTotals(accountIds: string[], start: Date, end: Date) {
    const zero = { externalIn: '0.00', externalOut: '0.00', internalMoved: '0.00', posReceipts: '0.00', activityCount: 0 };
    if (accountIds.length === 0) return zero;
    const rows = await this.prisma.raw.$queryRaw<
      { pos: boolean; external_in: string; external_out: string; internal_moved: string; n: bigint }[]
    >(Prisma.sql`
      SELECT x.pos,
        COALESCE(SUM(GREATEST(x.d - x.c, 0)), 0)::text AS external_in,
        COALESCE(SUM(GREATEST(x.c - x.d, 0)), 0)::text AS external_out,
        COALESCE(SUM(LEAST(x.d, x.c)), 0)::text AS internal_moved,
        COUNT(*)::bigint AS n
      FROM (
        SELECT je.id,
          COALESCE(${EFFECTIVE_SOURCE_TYPE} IN (${Prisma.join(POS_SALE_SOURCE_TYPES)}), false) AS pos,
          SUM(jl."baseDebit") AS d, SUM(jl."baseCredit") AS c
        FROM "JournalLine" jl
        JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
        WHERE jl."organizationId" = ${this.tenant.organizationId}
          AND jl."accountId" IN (${Prisma.join(accountIds)})
          AND je.status::text IN (${Prisma.join([...BALANCE_AFFECTING_STATUSES].map(String))})
          AND je."postingDate" >= ${start} AND je."postingDate" < ${end}
        GROUP BY je.id
      ) x
      GROUP BY x.pos
    `);
    let externalIn = 0, externalOut = 0, internalMoved = 0, posReceipts = 0, n = 0;
    for (const r of rows) {
      externalIn += Number(r.external_in);
      externalOut += Number(r.external_out);
      internalMoved += Number(r.internal_moved);
      n += Number(r.n);
      if (r.pos) posReceipts += Number(r.external_in);
    }
    return {
      externalIn: externalIn.toFixed(2),
      externalOut: externalOut.toFixed(2),
      internalMoved: internalMoved.toFixed(2),
      posReceipts: posReceipts.toFixed(2),
      activityCount: n,
    };
  }

  /** Informational only: a provider account holds money and has no recent recorded settlement. */
  private async settlementReminders(methods: any[], balanceOf: Map<string, number>): Promise<AttentionItem[]> {
    const accountIds = [...new Set(methods.filter((m) => m.kind !== 'cash' && m.accountId).map((m) => m.accountId as string))];
    if (accountIds.length === 0) return [];
    const last = await this.prisma.client.tenderSettlement.groupBy({
      by: ['sourceAccountId'],
      where: { organizationId: this.tenant.organizationId, sourceAccountId: { in: accountIds } },
      _max: { settledAt: true },
    });
    const lastOf = new Map((last as any[]).map((l) => [l.sourceAccountId, l._max.settledAt as Date | null]));
    const out: AttentionItem[] = [];
    const cutoff = Date.now() - this.settlementReminderDays * 864e5;
    for (const id of accountIds) {
      const balance = balanceOf.get(id);
      if (!balance || balance <= 0) continue; // not a money account in this list, or nothing held
      const lastAt = lastOf.get(id);
      if (lastAt && lastAt.getTime() >= cutoff) continue;
      const name = methods.find((m) => m.accountId === id)?.account?.name ?? 'A provider account';
      out.push({
        kind: 'provider_no_recent_settlement', severity: 'info',
        message: lastAt
          ? `${name} has a balance and no recorded settlement for ${Math.floor((Date.now() - lastAt.getTime()) / 864e5)} days`
          : `${name} has a balance and no settlement has been recorded yet`,
        amount: balance.toFixed(2),
        href: `/accounts/cash-accounts/settlements?source=${id}`, actionLabel: 'Open settlements',
      });
    }
    return out;
  }
}
