/**
 * POS Phase A — X / Z reports and sales analytics.
 *
 *   X-report: mid-shift snapshot (live, recomputed on each call).
 *   Z-report: end-of-shift frozen snapshot — same data as X, but stamped to
 *             a single `ReportSnapshot` row at the moment the cash session
 *             is closed so it can be re-printed/emailed later.
 *
 * Sales by hour / top items are derived from posted sales_invoice documents
 * with sourceType='pos' so they only count POS sales (not retail invoices
 * raised through the /invoicing module).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { EventBus } from '../../kernel/events/event-bus';
import { EVENTS } from '@erp/shared';
import { dec } from '../../kernel/common/money';

export interface XReport {
  asOf: string;
  cashSession: {
    id: string;
    cashRegisterId: string;
    userId: string | null;
    openedAt: Date | null;
    openingFloat: string;
  } | null;
  totals: {
    saleCount: number;
    salesTotal: string;
    refundsTotal: string;
    netSales: string;
    overridesTotal: string;
    payInsTotal: string;
    payOutsTotal: string;
    expectedCash: string;
  };
  byMethod: Array<{ method: string; count: number; total: string }>;
  byCategory: Array<{ categoryId: string | null; categoryName: string; count: number; total: string }>;
}

@Injectable()
export class PosReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /** Live mid-shift X-report for a given cash session (or the open one). */
  async xReport(cashSessionId?: string): Promise<XReport> {
    const organizationId = this.tenant.organizationId;
    const session = await this.resolveSession(organizationId, cashSessionId);
    if (!session) throw new NotFoundException('No cash session found');

    // Cash-session link is via CashMovement (not a Payment column). Pull
    // all movements for the session, then resolve the matching payments.
    const movements = await this.prisma.client.cashMovement.findMany({
      where: { cashSessionId: session.id },
      include: { payment: true },
    });
    const payments = movements
      .filter((m: any) => m.payment)
      .map((m: any) => m.payment);
    const overrides = await this.prisma.client.auditLog.findMany({
      where: {
        organizationId,
        entity: 'PosOverride' as any,
        createdAt: { gte: session.openedAt ?? new Date(0) },
      },
    });

    // Bucket payments by method
    const byMethodMap = new Map<string, { method: string; count: number; total: number }>();
    let saleCount = 0;
    let salesTotal = 0;
    let refundsTotal = 0;
    let payInsTotal = 0;
    let payOutsTotal = 0;
    for (const p of payments) {
      const amt = Number(p.amount);
      const isRefund = (p as any).direction === 'outbound';
      const key = isRefund ? `${p.paymentMethod} (refund)` : p.paymentMethod;
      const bucket = byMethodMap.get(key) ?? { method: key, count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += amt;
      byMethodMap.set(key, bucket);
      if (isRefund) refundsTotal += amt;
      else { saleCount += 1; salesTotal += amt; }
    }
    for (const m of movements) {
      // Manual movements (not linked to a payment) — pay-in / pay-out / adjustment.
      if (!m.paymentId) {
        const amt = Number(m.amount);
        if (m.movementType === 'pay_in') payInsTotal += amt;
        else if (m.movementType === 'pay_out') payOutsTotal += amt;
      }
    }
    const expectedCash =
      Number(session.openingFloat) + salesTotal - refundsTotal + payInsTotal - payOutsTotal;
    const overridesTotal = overrides.reduce((s, o) => {
      const v = (o as any).newValues;
      return s + (v && v.amount ? Number(v.amount) : 0);
    }, 0);

    // Sales by product category — union Document + Invoice allocations.
    const paymentIds = payments.map((p: any) => p.id);
    const allocations = await this.prisma.client.paymentAllocation.findMany({
      where: { paymentId: { in: paymentIds } },
    });
    const docIds = Array.from(new Set(allocations.map((a: any) => a.documentId).filter(Boolean)));
    const docs = docIds.length
      ? await this.prisma.client.document.findMany({
          where: { id: { in: docIds }, documentType: 'sales_invoice' },
          include: { lines: true },
        })
      : [];
    const invIds = Array.from(new Set(allocations.map((a: any) => a.invoiceId).filter(Boolean)));
    const invoiceItems = invIds.length
      ? await this.prisma.client.invoiceItem.findMany({ where: { invoiceId: { in: invIds } } })
      : [];
    const allProductIds = Array.from(
      new Set([
        ...docs.flatMap((d: any) => d.lines.map((l: any) => l.productId).filter(Boolean)),
        ...invoiceItems.map((i: any) => i.productId).filter(Boolean),
      ]),
    );
    const products = allProductIds.length
      ? await this.prisma.client.product.findMany({
          where: { id: { in: allProductIds as string[] } },
          include: { category: true },
        })
      : [];
    const productMap = new Map(products.map((p: any) => [p.id, p]));

    const byCategoryMap = new Map<string, { categoryId: string | null; categoryName: string; count: number; total: number }>();
    for (const doc of docs) {
      for (const ln of (doc as any).lines) {
        const product = ln.productId ? productMap.get(ln.productId) : null;
        const cat = (product as any)?.category;
        const key = cat?.id ?? 'uncategorised';
        const bucket = byCategoryMap.get(key) ?? {
          categoryId: cat?.id ?? null,
          categoryName: cat?.name ?? 'Uncategorised',
          count: 0,
          total: 0,
        };
        bucket.count += Number(ln.quantity);
        bucket.total += Number(ln.total ?? ln.subtotal ?? 0);
        byCategoryMap.set(key, bucket);
      }
    }
    for (const item of invoiceItems) {
      const product = item.productId ? productMap.get(item.productId) : null;
      const cat = (product as any)?.category;
      const key = cat?.id ?? 'uncategorised';
      const bucket = byCategoryMap.get(key) ?? {
        categoryId: cat?.id ?? null,
        categoryName: cat?.name ?? 'Uncategorised',
        count: 0,
        total: 0,
      };
      bucket.count += Number(item.quantity);
      bucket.total += Number(item.total);
      byCategoryMap.set(key, bucket);
    }

    this.events.publish(EVENTS.PosReportGenerated, {
      organizationId,
      reportKind: 'x',
      cashSessionId: session.id,
      asOf: new Date().toISOString(),
    });

    return {
      asOf: new Date().toISOString(),
      cashSession: {
        id: session.id,
        cashRegisterId: session.cashRegisterId,
        userId: session.userId,
        openedAt: session.openedAt,
        openingFloat: dec(session.openingFloat).toString(),
      },
      totals: {
        saleCount,
        salesTotal: salesTotal.toFixed(2),
        refundsTotal: refundsTotal.toFixed(2),
        netSales: (salesTotal - refundsTotal).toFixed(2),
        overridesTotal: overridesTotal.toFixed(2),
        payInsTotal: payInsTotal.toFixed(2),
        payOutsTotal: payOutsTotal.toFixed(2),
        expectedCash: expectedCash.toFixed(2),
      },
      byMethod: Array.from(byMethodMap.values()).map((b) => ({
        method: b.method,
        count: b.count,
        total: b.total.toFixed(2),
      })),
      byCategory: Array.from(byCategoryMap.values()).map((b) => ({
        categoryId: b.categoryId,
        categoryName: b.categoryName,
        count: b.count,
        total: b.total.toFixed(2),
      })),
    };
  }

  /** Z-report: same shape as X but the cash session should be closed. */
  async zReport(cashSessionId?: string): Promise<XReport> {
    const report = await this.xReport(cashSessionId);
    if (report.cashSession && (await this.sessionStatus(report.cashSession.id)) !== 'closed') {
      throw new BadRequestException('Z-report requires the cash session to be closed');
    }
    // Persist frozen snapshot so the report can be reprinted later
    if (report.cashSession?.id) {
      const organizationId = this.tenant.organizationId;
      await this.prisma.client.posReportSnapshot.upsert({
        where: { cashSessionId: report.cashSession.id },
        create: {
          organizationId,
          cashSessionId: report.cashSession.id,
          kind: 'z',
          reportData: report as any,
        },
        update: {
          reportData: report as any,
          generatedAt: new Date(),
        },
      });
    }
    await this.audit.record({
      entity: 'PosReport' as any,
      entityId: report.cashSession?.id ?? 'no-session',
      action: 'create' as any,
      newValues: { kind: 'z', totals: report.totals, asOf: report.asOf },
    });
    this.events.publish(EVENTS.PosReportGenerated, {
      organizationId: this.tenant.organizationId,
      reportKind: 'z',
      cashSessionId: report.cashSession?.id,
      asOf: report.asOf,
    });
    return report;
  }

  /** Hourly buckets for a given day. */
  async salesByHour(date: string) {
    const organizationId = this.tenant.organizationId;
    const start = new Date(date);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid date');
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const docs = await this.prisma.client.document.findMany({
      where: {
        organizationId,
        documentType: 'sales_invoice',
        status: { in: ['posted', 'paid'] },
        createdAt: { gte: start, lt: end },
      },
      select: { id: true, totalAmount: true, createdAt: true },
    });
    const invoices = await this.prisma.client.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['posted', 'paid'] },
        createdAt: { gte: start, lt: end },
      },
      select: { id: true, totalAmount: true, createdAt: true },
    });
    const buckets = new Array(24).fill(0).map((_, hour) => ({
      hour,
      count: 0,
      total: 0,
    }));
    for (const d of docs) {
      const hour = new Date(d.createdAt).getHours();
      buckets[hour].count += 1;
      buckets[hour].total += Number(d.totalAmount);
    }
    for (const inv of invoices) {
      const hour = new Date(inv.createdAt).getHours();
      buckets[hour].count += 1;
      buckets[hour].total += Number(inv.totalAmount);
    }
    return {
      date: start.toISOString().slice(0, 10),
      buckets: buckets.map((b) => ({ hour: b.hour, count: b.count, total: b.total.toFixed(2) })),
    };
  }

  /**
   * Sales summary — period-aggregated revenue, orders, discounts, taxes.
   * Groups by day / week / month and includes a payment-method breakdown.
   */
  async salesSummary(fromDate: string, toDate: string, groupBy: 'day' | 'week' | 'month') {
    const organizationId = this.tenant.organizationId;
    const start = new Date(fromDate);
    const end = new Date(toDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid fromDate/toDate');
    }
    end.setHours(23, 59, 59, 999);

    // Fetch all posted/paid sales invoices (Document + Invoice) in the range
    const docs = await this.prisma.client.document.findMany({
      where: {
        organizationId,
        documentType: 'sales_invoice',
        status: { in: ['posted', 'paid'] },
        createdAt: { gte: start, lte: end },
      },
      select: { id: true, totalAmount: true, discountTotal: true, taxAmount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const invoices = await this.prisma.client.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['posted', 'paid'] },
        createdAt: { gte: start, lte: end },
      },
      select: { id: true, totalAmount: true, discountTotal: true, taxAmount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const periodKey = (d: Date): string => {
      if (groupBy === 'day') return d.toISOString().slice(0, 10);
      if (groupBy === 'week') {
        const dow = d.getDay();
        const diff = d.getDate() - dow + (dow === 0 ? -6 : 1);
        const mon = new Date(d);
        mon.setDate(diff);
        return mon.toISOString().slice(0, 10);
      }
      return d.toISOString().slice(0, 7);
    };

    // Group by period in JS
    const grouped = new Map<string, { revenue: number; orders: number; discounts: number; taxes: number }>();
    for (const doc of docs) {
      const key = periodKey(new Date(doc.createdAt));
      const cur = grouped.get(key) ?? { revenue: 0, orders: 0, discounts: 0, taxes: 0 };
      cur.revenue += Number(doc.totalAmount);
      cur.orders += 1;
      cur.discounts += Number(doc.discountTotal);
      cur.taxes += Number(doc.taxAmount);
      grouped.set(key, cur);
    }
    for (const inv of invoices) {
      const key = periodKey(new Date(inv.createdAt));
      const cur = grouped.get(key) ?? { revenue: 0, orders: 0, discounts: 0, taxes: 0 };
      cur.revenue += Number(inv.totalAmount);
      cur.orders += 1;
      cur.discounts += Number(inv.discountTotal);
      cur.taxes += Number(inv.taxAmount);
      grouped.set(key, cur);
    }

    // Payment-method breakdown for the whole range (union Document + Invoice)
    const docIds = docs.map((d) => d.id);
    const invIds = invoices.map((i) => i.id);
    const allocations = await this.prisma.client.paymentAllocation.findMany({
      where: { OR: [{ documentId: { in: docIds } }, { invoiceId: { in: invIds } }] },
      include: { payment: { select: { paymentMethod: true, amount: true } } },
    });
    const byMethodMap = new Map<string, { method: string; count: number; total: number }>();
    for (const a of allocations) {
      const method = a.payment.paymentMethod;
      const cur = byMethodMap.get(method) ?? { method, count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(a.payment.amount);
      byMethodMap.set(method, cur);
    }

    const overall = Array.from(grouped.values()).reduce(
      (acc, p) => ({
        revenue: acc.revenue + p.revenue,
        orders: acc.orders + p.orders,
        discounts: acc.discounts + p.discounts,
        taxes: acc.taxes + p.taxes,
      }),
      { revenue: 0, orders: 0, discounts: 0, taxes: 0 },
    );

    return {
      fromDate: start.toISOString().slice(0, 10),
      toDate: end.toISOString().slice(0, 10),
      groupBy,
      totals: {
        revenue: overall.revenue.toFixed(2),
        orders: overall.orders,
        avgOrderValue: overall.orders > 0 ? (overall.revenue / overall.orders).toFixed(2) : '0.00',
        discounts: overall.discounts.toFixed(2),
        taxes: overall.taxes.toFixed(2),
      },
      periods: Array.from(grouped.entries()).map(([periodKey, p]) => ({
        periodKey,
        revenue: p.revenue.toFixed(2),
        orders: p.orders,
        avgOrderValue: p.orders > 0 ? (p.revenue / p.orders).toFixed(2) : '0.00',
        discounts: p.discounts.toFixed(2),
        taxes: p.taxes.toFixed(2),
      })),
      byMethod: Array.from(byMethodMap.values()).map((m) => ({
        method: m.method,
        count: m.count,
        total: m.total.toFixed(2),
      })),
    };
  }

  /** Top N items sold in a date range (inclusive of both ends). */
  async topItems(fromDate: string, toDate: string, limit = 20) {
    const organizationId = this.tenant.organizationId;
    const start = new Date(fromDate);
    const end = new Date(toDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid fromDate/toDate');
    }
    end.setHours(23, 59, 59, 999);
    // Document-based lines
    const docLines = await this.prisma.client.documentLine.findMany({
      where: {
        organizationId,
        document: {
          documentType: 'sales_invoice',
          status: { in: ['posted', 'paid'] },
          createdAt: { gte: start, lte: end },
        },
      },
    });
    // Invoice-based items
    const invoiceItems = await this.prisma.client.invoiceItem.findMany({
      where: {
        organizationId,
        invoice: {
          status: { in: ['posted', 'paid'] },
          createdAt: { gte: start, lte: end },
        },
      },
    });

    const allProductIds = Array.from(
      new Set([
        ...docLines.map((l: any) => l.productId).filter(Boolean),
        ...invoiceItems.map((i: any) => i.productId).filter(Boolean),
      ]),
    );
    const products = allProductIds.length
      ? await this.prisma.client.product.findMany({
          where: { id: { in: allProductIds as string[] } },
        })
      : [];
    const productMap = new Map(products.map((p: any) => [p.id, p]));

    const grouped = new Map<string, { productId: string; name: string; sku: string | null; quantity: number; total: number }>();
    for (const ln of docLines) {
      const product = ln.productId ? productMap.get(ln.productId) : null;
      const key = ln.productId ?? `_desc:${ln.description}`;
      const cur = grouped.get(key) ?? {
        productId: ln.productId ?? '',
        name: product?.name ?? ln.description,
        sku: product?.sku ?? null,
        quantity: 0,
        total: 0,
      };
      cur.quantity += Number(ln.quantity);
      cur.total += Number(ln.total ?? ln.subtotal ?? 0);
      grouped.set(key, cur);
    }
    for (const item of invoiceItems) {
      const product = item.productId ? productMap.get(item.productId) : null;
      const key = item.productId ?? `_desc:${item.description}`;
      const cur = grouped.get(key) ?? {
        productId: item.productId ?? '',
        name: product?.name ?? item.description,
        sku: product?.sku ?? null,
        quantity: 0,
        total: 0,
      };
      cur.quantity += Number(item.quantity);
      cur.total += Number(item.total);
      grouped.set(key, cur);
    }
    return Array.from(grouped.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, limit)
      .map((r) => ({ ...r, total: r.total.toFixed(2) }));
  }

  /** Retrieve a frozen Z-report snapshot for reprint. */
  async getZReportSnapshot(cashSessionId: string) {
    const organizationId = this.tenant.organizationId;
    const snap = await this.prisma.client.posReportSnapshot.findFirst({
      where: { organizationId, cashSessionId },
    });
    if (!snap) throw new NotFoundException('No Z-report snapshot for this session');
    return snap;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────
  private async resolveSession(organizationId: string, cashSessionId?: string) {
    if (cashSessionId) {
      return this.prisma.client.cashSession.findFirst({ where: { id: cashSessionId, organizationId } });
    }
    return this.prisma.client.cashSession.findFirst({
      where: { organizationId, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });
  }

  private async sessionStatus(id: string): Promise<string> {
    const s = await this.prisma.client.cashSession.findFirst({ where: { id }, select: { status: true } });
    return s?.status ?? 'unknown';
  }
}