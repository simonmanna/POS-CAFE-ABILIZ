/**
 * POS — X / Z reports and sales analytics (financial-grade).
 *
 *   X-report: mid-shift snapshot (live, recomputed on each call).
 *   Z-report: end-of-shift frozen snapshot — same data as X, stamped to a
 *             `PosReportSnapshot` row when the cash session is closed.
 *
 * Design rules (audit-hardened):
 *   • SALES figures are derived from the POS `Invoice` pipeline (all tenders),
 *     NOT from cash movements — so card / mobile / credit sales are included.
 *   • CASH-DRAWER figures (expectedCash) come from `CashMovement` rows (cash
 *     only) — that is what actually hits the till.
 *   • "Revenue" means NET of tax (Invoice.subtotal). Gross, tax, discount and
 *     refunds are reported as separate lines so totals reconcile.
 *   • Only POS sales are counted: the `Invoice` table is POS-native; legacy
 *     `Document` rows are included only when `sourceType = 'pos'`.
 *   • Money is summed with Decimal (`dec`) — never floating-point — to avoid
 *     rounding drift on large sums.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { EventBus } from '../../kernel/events/event-bus';
import { EVENTS } from '@erp/shared';
import { dec } from '../../kernel/common/money';

type Money = ReturnType<typeof dec>;

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
    /** Gross sales incl. tax, all tenders (kept key for back-compat). */
    salesTotal: string;
    grossSales: string;
    /** Net revenue, ex-tax (Invoice.subtotal). */
    netRevenue: string;
    taxTotal: string;
    discountTotal: string;
    refundsTotal: string;
    /** Gross − refunds. */
    netSales: string;
    /** Cash actually collected into the drawer (cash tenders only). */
    cashCollected: string;
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

    // ── Cash drawer: derive collected / refunded / pay-in / pay-out straight
    //    from CashMovement (cash only — this is what hits the till). ──────────
    const movements = await this.prisma.client.cashMovement.findMany({
      where: { cashSessionId: session.id },
    });
    let cashCollected = dec(0);
    let cashRefunds = dec(0);
    let payInsTotal = dec(0);
    let payOutsTotal = dec(0);
    for (const m of movements as any[]) {
      const amt = dec(m.amount);
      if (m.movementType === 'sale') cashCollected = cashCollected.plus(amt);
      else if (m.movementType === 'refund') cashRefunds = cashRefunds.plus(amt);
      else if (m.movementType === 'pay_in') payInsTotal = payInsTotal.plus(amt);
      else if (m.movementType === 'pay_out') payOutsTotal = payOutsTotal.plus(amt);
    }

    // ── Sales: ALL tenders for this session, from the POS Invoice pipeline. ──
    const invoices = await this.prisma.client.invoice.findMany({
      where: { organizationId, cashSessionId: session.id },
      include: { items: true },
    });

    const overrides = await this.prisma.client.auditLog.findMany({
      where: {
        organizationId,
        entity: 'PosOverride' as any,
        createdAt: { gte: session.openedAt ?? new Date(0) },
      },
    });

    let saleCount = 0;
    let grossSales = dec(0);
    let netRevenue = dec(0);
    let taxTotal = dec(0);
    let discountTotal = dec(0);
    let refundsTotal = dec(0);
    const byMethodMap = new Map<string, { method: string; count: number; total: Money }>();
    const saleItems: any[] = [];
    const productIds = new Set<string>();

    for (const inv of invoices as any[]) {
      if (inv.status === 'refunded') {
        refundsTotal = refundsTotal.plus(dec(inv.totalAmount));
        continue;
      }
      if (inv.status !== 'posted' && inv.status !== 'paid') continue; // skip draft/cancelled
      saleCount += 1;
      grossSales = grossSales.plus(dec(inv.totalAmount));
      netRevenue = netRevenue.plus(dec(inv.subtotal));
      taxTotal = taxTotal.plus(dec(inv.taxAmount));
      discountTotal = discountTotal.plus(dec(inv.discountTotal));

      const method = inv.paymentMode ?? 'unpaid';
      const b = byMethodMap.get(method) ?? { method, count: 0, total: dec(0) };
      b.count += 1;
      b.total = b.total.plus(dec(inv.totalAmount));
      byMethodMap.set(method, b);

      for (const it of inv.items ?? []) {
        saleItems.push(it);
        if (it.productId) productIds.add(it.productId);
      }
    }

    // Category breakdown from the sale lines.
    const products = productIds.size
      ? await this.prisma.client.product.findMany({
          where: { id: { in: Array.from(productIds) } },
          include: { category: true },
        })
      : [];
    const productMap = new Map(products.map((p: any) => [p.id, p]));
    const byCategoryMap = new Map<string, { categoryId: string | null; categoryName: string; count: number; total: Money }>();
    for (const it of saleItems) {
      const product = it.productId ? productMap.get(it.productId) : null;
      const cat = (product as any)?.category;
      const key = cat?.id ?? 'uncategorised';
      const bucket = byCategoryMap.get(key) ?? {
        categoryId: cat?.id ?? null,
        categoryName: cat?.name ?? 'Uncategorised',
        count: 0,
        total: dec(0),
      };
      bucket.count += Number(it.quantity);
      bucket.total = bucket.total.plus(dec(it.total ?? 0));
      byCategoryMap.set(key, bucket);
    }

    const overridesTotal = overrides.reduce((s, o) => {
      const v = (o as any).newValues;
      return s.plus(v && v.amount ? dec(v.amount) : dec(0));
    }, dec(0));

    const expectedCash = dec(session.openingFloat)
      .plus(cashCollected)
      .minus(cashRefunds)
      .plus(payInsTotal)
      .minus(payOutsTotal);
    const netSales = grossSales.minus(refundsTotal);

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
        salesTotal: grossSales.toFixed(2),
        grossSales: grossSales.toFixed(2),
        netRevenue: netRevenue.toFixed(2),
        taxTotal: taxTotal.toFixed(2),
        discountTotal: discountTotal.toFixed(2),
        refundsTotal: refundsTotal.toFixed(2),
        netSales: netSales.toFixed(2),
        cashCollected: cashCollected.toFixed(2),
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

  /** Z-report: same shape as X but the cash session must be closed. */
  async zReport(cashSessionId?: string): Promise<XReport> {
    const report = await this.xReport(cashSessionId);
    if (report.cashSession && (await this.sessionStatus(report.cashSession.id)) !== 'closed') {
      throw new BadRequestException('Z-report requires the cash session to be closed');
    }
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

  /** Hourly buckets for a given day (POS sales only, gross). */
  async salesByHour(date: string) {
    const organizationId = this.tenant.organizationId;
    const start = new Date(date);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid date');
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const [docs, invoices] = await Promise.all([
      this.prisma.client.document.findMany({
        where: {
          organizationId,
          documentType: 'sales_invoice',
          sourceType: 'pos', // POS-only — exclude /invoicing retail invoices
          status: { in: ['posted', 'paid'] },
          createdAt: { gte: start, lt: end },
        },
        select: { totalAmount: true, createdAt: true },
      }),
      this.prisma.client.invoice.findMany({
        where: {
          organizationId,
          status: { in: ['posted', 'paid'] },
          createdAt: { gte: start, lt: end },
        },
        select: { totalAmount: true, createdAt: true },
      }),
    ]);

    const buckets = new Array(24).fill(0).map((_, hour) => ({ hour, count: 0, total: dec(0) }));
    for (const d of [...docs, ...invoices] as any[]) {
      const hour = new Date(d.createdAt).getHours();
      buckets[hour].count += 1;
      buckets[hour].total = buckets[hour].total.plus(dec(d.totalAmount));
    }
    return {
      date: start.toISOString().slice(0, 10),
      buckets: buckets.map((b) => ({ hour: b.hour, count: b.count, total: b.total.toFixed(2) })),
    };
  }

  /**
   * Sales summary — period-aggregated revenue (NET of tax), gross, tax,
   * discounts and refunds, grouped by day / week / month, with a
   * payment-method breakdown derived from actual allocations.
   */
  async salesSummary(fromDate: string, toDate: string, groupBy: 'day' | 'week' | 'month') {
    const organizationId = this.tenant.organizationId;
    const start = new Date(fromDate);
    const end = new Date(toDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid fromDate/toDate');
    }
    end.setHours(23, 59, 59, 999);

    const [invoices, docs] = await Promise.all([
      this.prisma.client.invoice.findMany({
        where: {
          organizationId,
          status: { in: ['posted', 'paid', 'refunded'] },
          createdAt: { gte: start, lte: end },
        },
        select: { id: true, subtotal: true, totalAmount: true, discountTotal: true, taxAmount: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.client.document.findMany({
        where: {
          organizationId,
          documentType: 'sales_invoice',
          sourceType: 'pos', // POS-only
          status: { in: ['posted', 'paid'] },
          createdAt: { gte: start, lte: end },
        },
        select: { id: true, subtotal: true, totalAmount: true, discountTotal: true, taxAmount: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const rows = [
      ...invoices.map((i: any) => ({ ...i, refunded: i.status === 'refunded' })),
      ...docs.map((d: any) => ({ ...d, refunded: false })),
    ];

    const periodKey = (d: Date): string => {
      if (groupBy === 'day') return d.toISOString().slice(0, 10);
      if (groupBy === 'week') {
        const dow = d.getUTCDay();
        const mon = new Date(d);
        mon.setUTCDate(d.getUTCDate() - dow + (dow === 0 ? -6 : 1));
        return mon.toISOString().slice(0, 10);
      }
      return d.toISOString().slice(0, 7);
    };

    type Bucket = { gross: Money; net: Money; tax: Money; discount: Money; refunds: Money; orders: number };
    const fresh = (): Bucket => ({ gross: dec(0), net: dec(0), tax: dec(0), discount: dec(0), refunds: dec(0), orders: 0 });
    const grouped = new Map<string, Bucket>();
    const overall = fresh();

    for (const r of rows as any[]) {
      const key = periodKey(new Date(r.createdAt));
      const cur = grouped.get(key) ?? fresh();
      if (r.refunded) {
        cur.refunds = cur.refunds.plus(dec(r.totalAmount));
        overall.refunds = overall.refunds.plus(dec(r.totalAmount));
      } else {
        cur.gross = cur.gross.plus(dec(r.totalAmount));
        cur.net = cur.net.plus(dec(r.subtotal));
        cur.tax = cur.tax.plus(dec(r.taxAmount));
        cur.discount = cur.discount.plus(dec(r.discountTotal));
        cur.orders += 1;
        overall.gross = overall.gross.plus(dec(r.totalAmount));
        overall.net = overall.net.plus(dec(r.subtotal));
        overall.tax = overall.tax.plus(dec(r.taxAmount));
        overall.discount = overall.discount.plus(dec(r.discountTotal));
        overall.orders += 1;
      }
      grouped.set(key, cur);
    }

    // Payment-method breakdown — actual money received, by allocation amount,
    // inbound only (refunds excluded so methods aren't inflated).
    const invIds = invoices.map((i: any) => i.id);
    const docIds = docs.map((d: any) => d.id);
    const allocations = (invIds.length || docIds.length)
      ? await this.prisma.client.paymentAllocation.findMany({
          where: { OR: [{ invoiceId: { in: invIds } }, { documentId: { in: docIds } }] },
          include: { payment: { select: { paymentMethod: true, direction: true } } },
        })
      : [];
    const byMethodMap = new Map<string, { method: string; count: number; total: Money }>();
    for (const a of allocations as any[]) {
      if (a.payment?.direction !== 'inbound') continue;
      const method = a.payment.paymentMethod;
      const cur = byMethodMap.get(method) ?? { method, count: 0, total: dec(0) };
      cur.count += 1;
      cur.total = cur.total.plus(dec(a.amount));
      byMethodMap.set(method, cur);
    }

    const aov = (gross: Money, orders: number) => (orders > 0 ? gross.dividedBy(orders).toFixed(2) : '0.00');

    return {
      fromDate: start.toISOString().slice(0, 10),
      toDate: end.toISOString().slice(0, 10),
      groupBy,
      totals: {
        revenue: overall.net.toFixed(2), // NET of tax
        grossSales: overall.gross.toFixed(2),
        netSales: overall.gross.minus(overall.refunds).toFixed(2),
        refunds: overall.refunds.toFixed(2),
        orders: overall.orders,
        avgOrderValue: aov(overall.gross, overall.orders),
        discounts: overall.discount.toFixed(2),
        taxes: overall.tax.toFixed(2),
      },
      periods: Array.from(grouped.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, p]) => ({
          periodKey: key,
          revenue: p.net.toFixed(2), // NET
          grossSales: p.gross.toFixed(2),
          refunds: p.refunds.toFixed(2),
          orders: p.orders,
          avgOrderValue: aov(p.gross, p.orders),
          discounts: p.discount.toFixed(2),
          taxes: p.tax.toFixed(2),
        })),
      byMethod: Array.from(byMethodMap.values()).map((m) => ({
        method: m.method,
        count: m.count,
        total: m.total.toFixed(2),
      })),
    };
  }

  /**
   * Top N items sold in a date range (POS only, gross line total). Aggregated
   * in SQL via groupBy so it scales without loading every line into memory.
   */
  async topItems(fromDate: string, toDate: string, limit = 20) {
    const organizationId = this.tenant.organizationId;
    const start = new Date(fromDate);
    const end = new Date(toDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid fromDate/toDate');
    }
    end.setHours(23, 59, 59, 999);
    const cap = Math.min(200, Math.max(1, Math.trunc(limit) || 20));

    const [invGroups, docGroups] = await Promise.all([
      this.prisma.client.invoiceItem.groupBy({
        by: ['productId'],
        where: { organizationId, invoice: { status: { in: ['posted', 'paid'] }, createdAt: { gte: start, lte: end } } },
        _sum: { quantity: true, total: true },
      }),
      this.prisma.client.documentLine.groupBy({
        by: ['productId'],
        where: {
          organizationId,
          document: { documentType: 'sales_invoice', sourceType: 'pos', status: { in: ['posted', 'paid'] }, createdAt: { gte: start, lte: end } },
        },
        _sum: { quantity: true, total: true },
      }),
    ]);

    const merged = new Map<string, { productId: string; quantity: Money; total: Money }>();
    for (const g of [...invGroups, ...docGroups] as any[]) {
      const pid = g.productId;
      if (!pid) continue; // skip free-text (non-product) lines
      const cur = merged.get(pid) ?? { productId: pid, quantity: dec(0), total: dec(0) };
      cur.quantity = cur.quantity.plus(dec(g._sum?.quantity ?? 0));
      cur.total = cur.total.plus(dec(g._sum?.total ?? 0));
      merged.set(pid, cur);
    }

    const products = merged.size
      ? await this.prisma.client.product.findMany({ where: { id: { in: Array.from(merged.keys()) } }, select: { id: true, name: true, sku: true } })
      : [];
    const productMap = new Map(products.map((p: any) => [p.id, p]));

    return Array.from(merged.values())
      .map((r) => {
        const p = productMap.get(r.productId);
        return {
          productId: r.productId,
          name: p?.name ?? '(deleted product)',
          sku: p?.sku ?? null,
          quantity: Number(r.quantity),
          total: r.total,
        };
      })
      .sort((a, b) => b.total.minus(a.total).toNumber())
      .slice(0, cap)
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
