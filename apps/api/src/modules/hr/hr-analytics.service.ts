import { Injectable, NotFoundException } from '@nestjs/common';
import { POS_SALE_STATUSES } from '@erp/shared';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * HrAnalyticsService — what an employee actually did on the floor.
 *
 * Strictly read-only. It aggregates over invoices, refunds and cash sessions by
 * the *linked user id*, which is only answerable at all because the identity
 * spine exists. Nothing here writes, and in particular nothing re-attributes a
 * historical record: if an employee is later unlinked or transferred, these
 * numbers change because the question changed, not because the past did.
 *
 * Sale statuses come from `@erp/shared` so this agrees with the POS reports
 * exactly — an employee's sales total reconciling differently in HR than in POS
 * would be worse than not showing it.
 */
@Injectable()
export class HrAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * One employee's POS footprint over a date window.
   *
   * Sales are counted on `settledBy` — who took the money — while `waiterId`
   * (who served the table) is reported separately rather than merged, because
   * they are genuinely different roles and conflating them would misattribute
   * takings in any venue where a waiter and a cashier are different people.
   */
  async posActivity(employeeId: string, query: any = {}) {
    const employee = await this.prisma.client.hrEmployee.findFirst({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        userId: true,
        employmentStatus: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const empty = {
      employee,
      linked: false as const,
      range: null as any,
      sales: { count: 0, gross: 0 },
      served: { count: 0 },
      refunds: { count: 0, amount: 0 },
      cashSessions: { count: 0, open: 0 },
      discountsApplied: 0,
      message:
        'This employee has no linked user account, so no POS activity can be attributed to them.',
    };
    if (!employee.userId) return empty;

    const { from, to } = this.range(query);
    const userId = employee.userId;
    const dateFilter = { gte: from, lt: to };
    const c = this.prisma.client as any;

    const [settled, served, refunds, sessions, openSessions, discounts] = await Promise.all([
      c.invoice.aggregate({
        where: { settledBy: userId, status: { in: [...POS_SALE_STATUSES] }, createdAt: dateFilter },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      c.invoice.count({
        where: { waiterId: userId, status: { in: [...POS_SALE_STATUSES] }, createdAt: dateFilter },
      }),
      c.posRefund.aggregate({
        where: { approvedById: userId, createdAt: dateFilter },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      c.cashSession.count({ where: { userId, openedAt: dateFilter } }),
      c.cashSession.count({ where: { userId, status: 'open' } }),
      c.invoice.count({
        where: { discountAppliedBy: userId, createdAt: dateFilter },
      }),
    ]);

    return {
      employee,
      linked: true as const,
      range: { from, to },
      sales: {
        count: settled._count?._all ?? 0,
        gross: Number(settled._sum?.totalAmount ?? 0),
      },
      served: { count: served },
      refunds: {
        count: refunds._count?._all ?? 0,
        amount: Number(refunds._sum?.amount ?? 0),
      },
      cashSessions: { count: sessions, open: openSessions },
      discountsApplied: discounts,
    };
  }

  /**
   * Workforce leaderboard for the HR dashboard — every linked employee's sales
   * over the window, busiest first.
   */
  async workforceSales(query: any = {}) {
    const { from, to } = this.range(query);
    const c = this.prisma.client as any;

    const employees = await c.hrEmployee.findMany({
      where: { userId: { not: null } },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, userId: true },
    });
    if (employees.length === 0) return { rows: [], total: 0, range: { from, to } };

    const userIds = employees.map((e: any) => e.userId);
    const grouped = await c.invoice.groupBy({
      by: ['settledBy'],
      where: {
        settledBy: { in: userIds },
        status: { in: [...POS_SALE_STATUSES] },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
      _sum: { totalAmount: true },
    });
    const byUser = new Map(grouped.map((g: any) => [g.settledBy, g]));

    const rows = employees
      .map((e: any) => {
        const g: any = byUser.get(e.userId);
        return {
          employeeId: e.id,
          employeeCode: e.employeeCode,
          firstName: e.firstName,
          lastName: e.lastName,
          salesCount: g?._count?._all ?? 0,
          salesGross: Number(g?._sum?.totalAmount ?? 0),
        };
      })
      .sort((a: any, b: any) => b.salesGross - a.salesGross);

    return { rows, total: rows.length, range: { from, to } };
  }

  /**
   * Workforce panel for the HR dashboard: headcount by lifecycle state, plus
   * how much of the workforce actually has system and POS access.
   */
  async workforceAccess() {
    const c = this.prisma.client as any;

    const [byStatus, total, linked, withPos] = await Promise.all([
      c.hrEmployee.groupBy({ by: ['employmentStatus'], _count: { _all: true } }),
      c.hrEmployee.count(),
      c.hrEmployee.count({ where: { userId: { not: null } } }),
      c.user.count({
        where: { employee: { isNot: null }, isActive: true, roles: { some: {} } },
      }),
    ]);

    return {
      total,
      linked,
      unlinked: total - linked,
      accountsActive: withPos,
      byStatus: byStatus.map((r: any) => ({
        status: r.employmentStatus,
        count: r._count?._all ?? 0,
      })),
    };
  }

  /** Inclusive-start, exclusive-end window; defaults to the last 30 days. */
  private range(query: any): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }
}
