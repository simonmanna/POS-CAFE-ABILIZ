import { reconcileSession } from '../accounting/treasury/session-reconciliation';
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
import { toCanonicalOrderStatus, ACCEPTED_ORDER_STATUSES, CANONICAL_ORDER_STATUSES } from './order-status.util';

type Money = ReturnType<typeof dec>;

/**
 * Parse a YYYY-MM-DD from/to pair into [start, end] Date bounds expressed in
 * the SERVER's local timezone (the business timezone): start = local midnight
 * of fromDate, end = last local instant (23:59:59.999) of toDate.
 *
 * `new Date('YYYY-MM-DD')` parses as UTC midnight — in UTC+ zones that rolls
 * back to "yesterday 21:00 local", silently excluding the first local hours
 * of the range. All range reports must go through this helper so a
 * "From: 2026-08-04" query actually covers local 2026-08-04 00:00–23:59.
 */
export function parseReportRange(fromDate: string, toDate: string): [Date, Date] {
  let start = parseLocalDay(fromDate, 'start');
  let end = parseLocalDay(toDate, 'end');
  // A reversed range is a UI slip, not a reason to return nothing — normalise it
  // so "From 2026-09-04 / To 2026-09-01" reports the same days as the reverse.
  if (start.getTime() > end.getTime()) {
    const f = localIso(end);
    const t = localIso(start);
    start = parseLocalDay(f, 'start');
    end = parseLocalDay(t, 'end');
  }
  return [start, end];
}

/**
 * Build the local-timezone start/end instant of a YYYY-MM-DD day.
 *
 * `new Date('YYYY-MM-DD')` parses as UTC midnight. Clamping that with
 * `setHours(0,0,0,0)` only lands on the right local day in UTC+ zones — in a
 * UTC− zone UTC midnight is still *yesterday* locally, so the whole range slid
 * back a day. Constructing from the parsed Y/M/D components is offset-agnostic.
 */
function parseLocalDay(value: string, edge: 'start' | 'end'): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!m) {
    const loose = new Date(value);
    if (Number.isNaN(loose.getTime())) throw new BadRequestException('Invalid fromDate/toDate');
    return edge === 'start'
      ? new Date(loose.getFullYear(), loose.getMonth(), loose.getDate(), 0, 0, 0, 0)
      : new Date(loose.getFullYear(), loose.getMonth(), loose.getDate(), 23, 59, 59, 999);
  }
  const [, y, mo, d] = m;
  const day = edge === 'start'
    ? new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0)
    : new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
  if (Number.isNaN(day.getTime())) throw new BadRequestException('Invalid fromDate/toDate');
  return day;
}

/**
 * Local-timezone YYYY-MM-DD. `toISOString().slice(0,10)` is UTC, so echoing a
 * range (or bucketing a period) through it silently shifts days by one either
 * side of midnight — the reason a "today" query could return a row labelled
 * yesterday.
 */
export function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Invoice statuses that represent a POS sale that actually happened.
 *
 * `refunded` belongs here: a fully-refunded sale WAS rung up, and the refund is
 * reported as its own event. Leaving it out (as several reports used to) made
 * the Sales / Items / Cashier tabs disagree with the Daily-Sales totals, which
 * always included it — the same shift reconciling two different ways.
 */
export const POS_SALE_STATUSES = ['posted', 'paid', 'refunded'] as const;

/** Order statuses a report may be narrowed to (anything else is rejected). */
const ORDER_TYPES = new Set(['dine_in', 'takeaway', 'delivery']);
const PAYMENT_MODES = new Set(['cash', 'card', 'mobile_money', 'mixed', 'credit']);

/** Filters shared by every invoice-backed POS report. */
export interface PosSaleFilters {
  waiterId?: string;
  paymentMethod?: string;
  orderType?: string;
  search?: string;
  cashSessionId?: string;
  tableId?: string;
}

/**
 * Single source of truth for "which invoices count as POS sales in this range".
 *
 * Every tabular report builds its `where` here so a filter means exactly the
 * same thing on every tab — previously each method hand-rolled its own subset
 * and they drifted (different statuses, different filters silently ignored).
 */
export function posSaleWhere(
  organizationId: string,
  start: Date,
  end: Date,
  f: PosSaleFilters = {},
): any {
  const orderScope: any = {};
  if (f.orderType) {
    if (!ORDER_TYPES.has(f.orderType)) throw new BadRequestException(`Unknown orderType "${f.orderType}"`);
    orderScope.orderType = f.orderType;
  }
  if (f.paymentMethod && !PAYMENT_MODES.has(f.paymentMethod)) {
    throw new BadRequestException(`Unknown paymentMethod "${f.paymentMethod}"`);
  }
  const search = f.search?.trim();
  return {
    organizationId,
    // POS-only: invoices bridged from an Order. Manual AR invoices live in the
    // accounting module and must never inflate POS figures.
    orderId: { not: null },
    status: { in: [...POS_SALE_STATUSES] },
    createdAt: { gte: start, lte: end },
    ...(f.waiterId ? { waiterId: f.waiterId } : {}),
    ...(f.tableId ? { tableId: f.tableId } : {}),
    ...(f.cashSessionId ? { cashSessionId: f.cashSessionId } : {}),
    ...(f.paymentMethod ? { paymentMode: f.paymentMethod as any } : {}),
    ...(Object.keys(orderScope).length ? { order: orderScope } : {}),
    ...(search
      ? {
          OR: [
            { invoiceNumber: { contains: search, mode: 'insensitive' } },
            { order: { orderNumber: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
}

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

  /**
   * Everything the report filter bar needs, in one round-trip.
   *
   * The dropdown values must come from the SAME slice of data the reports read,
   * otherwise a manager picks a waiter who never rang up a sale in the range and
   * reads the resulting empty table as a bug. Staff/category lists are therefore
   * derived from the invoices actually in the range, with the org's full lists
   * only as a fallback when the range is empty.
   */
  async filterOptions(fromDate: string, toDate: string) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    const [invoices, registers] = await Promise.all([
      this.prisma.client.invoice.findMany({
        where: posSaleWhere(organizationId, start, end),
        select: { waiterId: true, paymentMode: true, items: { select: { productId: true, menuItemId: true } } },
      }),
      this.prisma.client.cashRegister.findMany({
        where: { organizationId },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
    ]);

    const waiterIds = new Set<string>();
    const productIds = new Set<string>();
    const menuItemIds = new Set<string>();
    const paymentModes = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.waiterId) waiterIds.add(inv.waiterId);
      if (inv.paymentMode) paymentModes.add(inv.paymentMode);
      for (const it of inv.items ?? []) {
        if (it.productId) productIds.add(it.productId);
        if (it.menuItemId) menuItemIds.add(it.menuItemId);
      }
    }

    const [waiters, products, menuItems] = await Promise.all([
      waiterIds.size
        ? this.prisma.client.user.findMany({
            where: { id: { in: Array.from(waiterIds) } },
            select: { id: true, firstName: true, lastName: true },
          })
        : Promise.resolve([] as any[]),
      productIds.size
        ? this.prisma.client.product.findMany({
            where: { id: { in: Array.from(productIds) } },
            select: { category: { select: { id: true, name: true } } },
          })
        : Promise.resolve([] as any[]),
      menuItemIds.size
        ? this.prisma.client.menuItem.findMany({
            where: { id: { in: Array.from(menuItemIds) } },
            select: { category: { select: { id: true, name: true } } },
          })
        : Promise.resolve([] as any[]),
    ]);

    const categories = new Map<string, string>();
    for (const row of [...(products as any[]), ...(menuItems as any[])]) {
      if (row.category?.id) categories.set(row.category.id, row.category.name);
    }

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    return {
      fromDate: localIso(start),
      toDate: localIso(end),
      waiters: (waiters as any[])
        .map((w) => ({ id: w.id, name: `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}` }))
        .sort(byName),
      categories: Array.from(categories, ([id, name]) => ({ id, name })).sort(byName),
      // Tenders seen in the range first; the full enum stays available so a
      // manager can ask "did we take any card at all?" and get a real empty.
      paymentMethods: Array.from(PAYMENT_MODES).map((m) => ({ id: m, name: m.replace(/_/g, ' '), seen: paymentModes.has(m) })),
      orderTypes: Array.from(ORDER_TYPES).map((t) => ({ id: t, name: t.replace(/_/g, ' ') })),
      orderStatuses: CANONICAL_ORDER_STATUSES.map((s) => ({ id: s, name: s.replace(/_/g, ' ') })),
      registers: (registers as any[]).map((r) => ({ id: r.id, name: `${r.code} - ${r.name}` })),
    };
  }

  /** Live mid-shift X-report for a given cash session (or the open one). */
  async xReport(cashSessionId?: string): Promise<XReport> {
    const organizationId = this.tenant.organizationId;
    const session = await this.resolveSession(organizationId, cashSessionId);
    if (!session) throw new NotFoundException('No cash session found');

    const evidence = await this.prisma.client.$transaction((tx: any) => reconcileSession(tx, organizationId, session));
    return { ...evidence.report, accounts: evidence.accounts, settlements: evidence.settlements, issues: evidence.issues } as XReport;
  }

  /** Z-report: same shape as X but the cash session must be closed. */
  async zReport(cashSessionId?: string): Promise<XReport> {
    const session = await this.resolveSession(this.tenant.organizationId, cashSessionId);
    if (!session || session.status === 'open') throw new BadRequestException('Close the register before requesting its Z-report');
    const snapshot = await this.prisma.client.posReportSnapshot.findUnique({ where: { cashSessionId: session.id } });
    if (!snapshot) throw new NotFoundException('No frozen close report exists for this legacy shift');
    return snapshot.reportData as unknown as XReport;
  }

  /** Hourly buckets across a date range (POS sales only, gross). */
  async salesByHour(fromDate: string, toDate: string, hours?: string, filters: PosSaleFilters = {}) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    // Parse optional hour filter
    const hourFilter: Set<number> | null = hours
      ? new Set(hours.split(',').map((h) => parseInt(h, 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 23))
      : null;

    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, filters),
      select: { totalAmount: true, createdAt: true },
    });

    const buckets = new Array(24).fill(0).map((_, hour) => ({ hour, count: 0, total: dec(0) }));
    for (const d of invoices as any[]) {
      const hour = new Date(d.createdAt).getHours();
      if (hourFilter && !hourFilter.has(hour)) continue;
      buckets[hour].count += 1;
      buckets[hour].total = buckets[hour].total.plus(dec(d.totalAmount));
    }
    const grandTotal = buckets.reduce((s, b) => s.plus(b.total), dec(0));
    const grandCount = buckets.reduce((s, b) => s + b.count, 0);
    return {
      fromDate: localIso(start),
      toDate: localIso(end),
      totals: { count: grandCount, total: grandTotal.toFixed(2) },
      buckets: buckets.map((b) => ({ hour: b.hour, count: b.count, total: b.total.toFixed(2) })),
    };
  }

  /**
   * Sales summary — period-aggregated revenue (NET of tax), gross, tax,
   * discounts and refunds, grouped by day / week / month, with a
   * payment-method breakdown derived from actual allocations.
   */
  async salesSummary(
    fromDate: string,
    toDate: string,
    groupBy: 'day' | 'week' | 'month',
    filters: PosSaleFilters = {},
  ) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);
    if (!['day', 'week', 'month'].includes(groupBy)) {
      throw new BadRequestException(`Unknown groupBy "${groupBy}"`);
    }

    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, filters),
      select: { id: true, subtotal: true, totalAmount: true, discountTotal: true, taxAmount: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const rows = invoices;
    // Refunds are only comparable to the sales above when they are scoped the
    // same way. With a waiter / order-type / tender filter active, a global
    // refund total would net out money that the filtered sales never contained.
    const refunds = await this.loadRefundsForScope(organizationId, start, end, filters, invoices as any[]);

    // Period keys are LOCAL dates. Using toISOString() here bucketed an evening
    // sale into the next UTC day (or a small-hours sale into the previous one),
    // so a single-day range could render a row dated outside the range asked for.
    const periodKey = (d: Date): string => {
      if (groupBy === 'day') return localIso(d);
      if (groupBy === 'week') {
        const dow = d.getDay();
        const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        mon.setDate(mon.getDate() - dow + (dow === 0 ? -6 : 1));
        return localIso(mon);
      }
      return localIso(d).slice(0, 7);
    };

    type Bucket = { gross: Money; net: Money; tax: Money; discount: Money; refunds: Money; orders: number };
    const fresh = (): Bucket => ({ gross: dec(0), net: dec(0), tax: dec(0), discount: dec(0), refunds: dec(0), orders: 0 });
    const grouped = new Map<string, Bucket>();
    const overall = fresh();

    for (const r of rows as any[]) {
      const key = periodKey(new Date(r.createdAt));
      const cur = grouped.get(key) ?? fresh();
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
      grouped.set(key, cur);
    }

    // Refunds belong to their own event date, including partial returns and
    // returns against sales from an earlier reporting period.
    for (const refund of refunds) {
      const key = periodKey(new Date(refund.createdAt));
      const cur = grouped.get(key) ?? fresh();
      const items = Array.isArray(refund.items) ? refund.items as any[] : [];
      const net = items.reduce((n, item) => n.plus(item.subtotal ?? 0), dec(0));
      const tax = items.reduce((n, item) => n.plus(item.taxAmount ?? 0), dec(0));
      cur.refunds = cur.refunds.plus(refund.amount); overall.refunds = overall.refunds.plus(refund.amount);
      cur.net = cur.net.minus(net); overall.net = overall.net.minus(net);
      cur.tax = cur.tax.minus(tax); overall.tax = overall.tax.minus(tax);
      grouped.set(key, cur);
    }

    // Payment-method breakdown — actual money received, by allocation amount,
    // inbound only (refunds excluded so methods aren't inflated).
    const invIds = invoices.map((i: any) => i.id);
    const allocations = invIds.length
      ? await this.prisma.client.paymentAllocation.findMany({
          where: { invoiceId: { in: invIds } },
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
      fromDate: localIso(start),
      toDate: localIso(end),
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
      periods: Array.from(this.withEmptyPeriods(grouped, groupBy, start, end, fresh).entries())
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
  async topItems(
    fromDate: string,
    toDate: string,
    limit = 20,
    categoryId?: string,
    filters: PosSaleFilters = {},
  ) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);
    const cap = Math.min(200, Math.max(1, Math.trunc(limit) || 20));

    // POS sales live exclusively on Invoice/InvoiceItem (Document→Invoice
    // migration complete) — merging the legacy DocumentLine pipeline
    // double-counts migrated rows, so it is retired here.
    //
    // This where targets InvoiceItem: the invoice-level scope rides the
    // `invoice` relation; the optional category filter adds an `items`-level
    // OR over the line's product / menu item.
    const itemWhere: any = {
      organizationId,
      invoice: posSaleWhere(organizationId, start, end, filters),
    };
    if (categoryId) {
      // InvoiceItem carries loose productId/menuItemId (no relations), so the
      // category scope is applied via the line's product OR menu item.
      const [catsProducts, catsMenuItems] = await Promise.all([
        this.prisma.client.product.findMany({ where: { organizationId, categoryId }, select: { id: true } }),
        this.prisma.client.menuItem.findMany({ where: { organizationId, categoryId }, select: { id: true } }),
      ]);
      const allowedProductIds = (catsProducts as any[]).map((p) => p.id);
      const allowedMenuItemIds = (catsMenuItems as any[]).map((m) => m.id);
      if (allowedProductIds.length === 0 && allowedMenuItemIds.length === 0) return [];
      itemWhere.OR = [
        ...(allowedProductIds.length ? [{ productId: { in: allowedProductIds } }] : []),
        ...(allowedMenuItemIds.length ? [{ menuItemId: { in: allowedMenuItemIds } }] : []),
      ];
    }

    // Group by BOTH identities. Grouping on productId alone dropped every
    // menu-driven café line (menuItemId set, productId null) into the discarded
    // null bucket — a Top Items tab that showed nothing on a menu-only catalogue.
    const invGroups = await this.prisma.client.invoiceItem.groupBy({
      by: ['productId', 'menuItemId'],
      where: itemWhere,
      _sum: { quantity: true, total: true },
    });

    type Row = { key: string; productId: string | null; menuItemId: string | null; quantity: Money; total: Money };
    const merged = new Map<string, Row>();
    for (const g of invGroups as any[]) {
      const productId: string | null = g.productId ?? null;
      const menuItemId: string | null = g.menuItemId ?? null;
      // A menu item is the customer-facing identity; fall back to the product
      // for retail lines, and skip free-text lines that have neither.
      const key = menuItemId ?? productId;
      if (!key) continue;
      const cur = merged.get(key) ?? { key, productId, menuItemId, quantity: dec(0), total: dec(0) };
      cur.productId = cur.productId ?? productId;
      cur.menuItemId = cur.menuItemId ?? menuItemId;
      cur.quantity = cur.quantity.plus(dec(g._sum?.quantity ?? 0));
      cur.total = cur.total.plus(dec(g._sum?.total ?? 0));
      merged.set(key, cur);
    }

    const rows = Array.from(merged.values());
    const productIds = rows.map((r) => r.productId).filter(Boolean) as string[];
    const menuItemIds = rows.map((r) => r.menuItemId).filter(Boolean) as string[];
    const [products, menuItems] = await Promise.all([
      productIds.length
        ? this.prisma.client.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true } })
        : Promise.resolve([] as any[]),
      menuItemIds.length
        ? this.prisma.client.menuItem.findMany({ where: { id: { in: menuItemIds } }, select: { id: true, name: true } })
        : Promise.resolve([] as any[]),
    ]);
    const productMap = new Map((products as any[]).map((p) => [p.id, p]));
    const menuItemMap = new Map((menuItems as any[]).map((m) => [m.id, m]));

    return rows
      .map((r) => {
        const p = r.productId ? productMap.get(r.productId) : null;
        const mi = r.menuItemId ? menuItemMap.get(r.menuItemId) : null;
        return {
          // Kept as `productId` for back-compat with the existing table key.
          productId: r.key,
          name: mi?.name ?? p?.name ?? '(deleted item)',
          sku: p?.sku ?? null,
          quantity: Number(r.quantity),
          total: r.total,
        };
      })
      .sort((a, b) => b.total.minus(a.total).toNumber())
      .slice(0, cap)
      .map((r) => ({ ...r, total: r.total.toFixed(2) }));
  }

  /**
   * Sales report — one row per invoice in a date range.
   * Columns: order number, invoice number, sale date, subtotal, discount,
   * total amount, waiter.
   *
   * @param waiterId - optional filter by waiter (cashier) user ID.
   * @param search - optional text search on invoice or order number.
   * @param paymentMethod - optional filter by primary payment mode.
   */
  async salesReport(fromDate: string, toDate: string, waiterId?: string, search?: string, paymentMethod?: string, orderType?: string) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, { waiterId, search, paymentMethod, orderType }),
      include: {
        order: { select: { orderNumber: true, orderType: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const waiterIds = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.waiterId) waiterIds.add(inv.waiterId);
    }

    const waiters = waiterIds.size
      ? await this.prisma.client.user.findMany({
          where: { id: { in: Array.from(waiterIds) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const waiterMap = new Map(waiters.map((w: any) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]));

    return (invoices as any[]).map((inv) => ({
      id: inv.id,
      orderNumber: inv.order?.orderNumber ?? '—',
      orderType: inv.order?.orderType ?? null,
      invoiceNumber: inv.invoiceNumber,
      saleDate: inv.createdAt?.toISOString() ?? '',
      // Kept for older consumers; the UI formats from `saleDate` so the time is
      // rendered in the READER's timezone, not the API host's.
      time: new Date(inv.createdAt).toLocaleTimeString(),
      // Raw invoice subtotal (ex-tax, pre-discount) — matches the Daily/Weekly/
      // Monthly "Net revenue" definition. The previous subtotal+discount sum
      // matched no other report.
      subtotal: dec(inv.subtotal).toFixed(2),
      discount: dec(inv.discountTotal).toFixed(2),
      discountType: inv.discountType ?? 'percentage',
      discountValue: dec(inv.discountValue ?? 0).toFixed(2),
      discountReason: inv.discountReason ?? null,
      tax: dec(inv.taxAmount).toFixed(2),
      totalAmount: dec(inv.totalAmount).toFixed(2),
      amountPaid: dec(inv.amountPaid).toFixed(2),
      // A refunded sale stays in the list (it happened) — this column is what
      // makes "why doesn't gross match the bank?" answerable on the same row.
      amountRefunded: dec(inv.amountRefunded ?? 0).toFixed(2),
      netAmount: dec(inv.totalAmount).minus(dec(inv.amountRefunded ?? 0)).toFixed(2),
      status: inv.status,
      paymentMethod: inv.paymentMode ?? null,
      waiterName: inv.waiterId ? (waiterMap.get(inv.waiterId) ?? null) : null,
    }));
  }

  /**
   * Cashier report — one row per invoice showing cashier sales.
   * Columns: cashier, order #, invoice #, sales amount, payment method, received.
   *
   * @param waiterId - optional filter by cashier user ID.
   * @param search - optional text search on invoice or order number.
   * @param paymentMethod - optional filter by payment mode.
   */
  async cashierReport(fromDate: string, toDate: string, waiterId?: string, search?: string, paymentMethod?: string, orderType?: string) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, { waiterId, search, paymentMethod, orderType }),
      include: {
        order: { select: { orderNumber: true, orderType: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const cashierIds = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.waiterId) cashierIds.add(inv.waiterId);
    }

    const cashiers = cashierIds.size
      ? await this.prisma.client.user.findMany({
          where: { id: { in: Array.from(cashierIds) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const cashierMap = new Map(cashiers.map((c: any) => [c.id, `${c.firstName}${c.lastName ? ' ' + c.lastName : ''}`]));

    return (invoices as any[]).map((inv) => ({
      cashierName: inv.waiterId ? (cashierMap.get(inv.waiterId) ?? null) : null,
      orderNumber: inv.order?.orderNumber ?? '—',
      orderType: inv.order?.orderType ?? null,
      invoiceNumber: inv.invoiceNumber,
      // The row had a clock time but no date, so a multi-day range showed a
      // column of times that could not be told apart. Both now ship.
      saleDate: inv.createdAt?.toISOString() ?? '',
      time: new Date(inv.createdAt).toLocaleTimeString(),
      status: inv.status,
      amountRefunded: dec(inv.amountRefunded ?? 0).toFixed(2),
      salesAmount: dec(inv.totalAmount).toFixed(2),
      discount: dec(inv.discountTotal).toFixed(2),
      discountType: inv.discountType ?? 'percentage',
      discountValue: dec(inv.discountValue ?? 0).toFixed(2),
      discountReason: inv.discountReason ?? null,
      paymentMethod: inv.paymentMode ?? null,
      received: dec(inv.amountPaid).toFixed(2),
    }));
  }

  /**
   * Cashier shift summary — one row per cash session in a date range.
   * Columns: shift (register + opened), cashier, opening cash, sales,
   * expected cash, actual cash, difference.
   *
   * @param cashierId - optional user ID to filter sessions by cashier.
   */
  async cashierShiftSummary(fromDate: string, toDate: string, cashierId?: string, registerId?: string, status?: string) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    const sessions = await this.prisma.client.cashSession.findMany({
      where: {
        organizationId,
        openedAt: { gte: start, lte: end },
        ...(cashierId ? { userId: cashierId } : {}),
        ...(registerId ? { cashRegisterId: registerId } : {}),
        ...(status ? { status: status as any } : {}),
      },
      include: {
        cashRegister: { select: { code: true, name: true } },
        movements: true,
      },
      orderBy: { openedAt: 'desc' },
    });

    // All-tender sales per session. The drawer movements below only know about
    // cash, so a card-heavy shift used to report "Sales" far under what it rang
    // up — the number managers were comparing against the POS terminal.
    const sessionIds = (sessions as any[]).map((s) => s.id);
    const tenderTotals = new Map<string, { total: Money; count: number }>();
    if (sessionIds.length) {
      const invoices = await this.prisma.client.invoice.findMany({
        where: {
          organizationId,
          orderId: { not: null },
          status: { in: [...POS_SALE_STATUSES] },
          cashSessionId: { in: sessionIds },
        },
        select: { cashSessionId: true, totalAmount: true },
      });
      for (const inv of invoices as any[]) {
        if (!inv.cashSessionId) continue;
        const cur = tenderTotals.get(inv.cashSessionId) ?? { total: dec(0), count: 0 };
        cur.total = cur.total.plus(dec(inv.totalAmount));
        cur.count += 1;
        tenderTotals.set(inv.cashSessionId, cur);
      }
    }

    // Resolve cashier names
    const userIds = new Set(sessions.map((s: any) => s.userId).filter(Boolean));
    const users = userIds.size
      ? await this.prisma.client.user.findMany({
          where: { id: { in: Array.from(userIds) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const userMap = new Map(users.map((u: any) => [u.id, `${u.firstName}${u.lastName ? ' ' + u.lastName : ''}`]));

    return (sessions as any[]).map((s) => {
      const registerLabel = s.cashRegister ? `${s.cashRegister.code} - ${s.cashRegister.name}` : s.cashRegisterId;
      const shift = `${registerLabel} · ${new Date(s.openedAt).toLocaleDateString()} ${new Date(s.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      let cashCollected = dec(0);
      let cashRefunds = dec(0);
      let payIns = dec(0);
      let payOuts = dec(0);
      for (const m of s.movements ?? []) {
        const amt = dec(m.amount);
        if (m.movementType === 'sale') cashCollected = cashCollected.plus(amt);
        else if (m.movementType === 'refund') cashRefunds = cashRefunds.plus(amt);
        else if (m.movementType === 'pay_in') payIns = payIns.plus(amt);
        else if (m.movementType === 'pay_out') payOuts = payOuts.plus(amt);
      }

      const openingCash = dec(s.openingFloat);
      const expectedCash = openingCash.plus(cashCollected).minus(cashRefunds).plus(payIns).minus(payOuts);
      const actualCash = s.closingCounted != null ? dec(s.closingCounted) : null;
      const difference = actualCash != null ? actualCash.minus(expectedCash) : null;

      const tender = tenderTotals.get(s.id);

      return {
        shift,
        sessionId: s.id,
        registerName: registerLabel,
        openedAt: s.openedAt?.toISOString() ?? null,
        closedAt: s.closedAt?.toISOString() ?? null,
        status: s.status ?? null,
        cashierName: userMap.get(s.userId) ?? null,
        openingCash: openingCash.toFixed(2),
        // `sales` is cash-into-drawer (kept for back-compat); `totalSales` is
        // every tender. The UI labels them apart so neither can be misread.
        sales: cashCollected.toFixed(2),
        cashSales: cashCollected.toFixed(2),
        totalSales: (tender?.total ?? dec(0)).toFixed(2),
        saleCount: tender?.count ?? 0,
        cashRefunds: cashRefunds.toFixed(2),
        payIns: payIns.toFixed(2),
        payOuts: payOuts.toFixed(2),
        expectedCash: expectedCash.toFixed(2),
        actualCash: actualCash?.toFixed(2) ?? null,
        difference: difference?.toFixed(2) ?? null,
      };
    });
  }

  /**
   * Waiter report — one row per line item grouped by waiter.
   * Columns: waiter, order #, table, item, qty, unit price, discount, total, date.
   *
   * @param waiterId - optional filter by waiter user ID.
   */
  async waiterReport(fromDate: string, toDate: string, waiterId?: string, orderType?: string, search?: string, paymentMethod?: string) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, { waiterId, orderType, search, paymentMethod }),
      include: {
        items: true,
        order: { select: { orderNumber: true, tableId: true, orderType: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Collect IDs for lookup
    const waiterIds = new Set<string>();
    const tableIds = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.waiterId) waiterIds.add(inv.waiterId);
      if (inv.order?.tableId) tableIds.add(inv.order.tableId);
    }

    // Resolve waiter names
    const waiters = waiterIds.size
      ? await this.prisma.client.user.findMany({
          where: { id: { in: Array.from(waiterIds) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const waiterMap = new Map(waiters.map((w: any) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]));

    // Resolve table names
    const tables = tableIds.size
      ? await this.prisma.client.posTable.findMany({ where: { id: { in: Array.from(tableIds) } }, select: { id: true, name: true } })
      : [];
    const tableMap = new Map(tables.map((t: any) => [t.id, t.name]));

    const rows: Array<{
      waiterName: string | null;
      orderNumber: string;
      tableName: string | null;
      item: string;
      quantity: string;
      unitPrice: string;
      discountPercent: string;
      discountType: string;
      discountAmount: string;
      discountReason: string | null;
      total: string;
      date: string;
      time: string;
      orderType: string | null;
    }> = [];

    for (const inv of invoices as any[]) {
      const orderNumber = inv.order?.orderNumber ?? '—';
      const orderType = inv.order?.orderType ?? null;
      const tableName = inv.order?.tableId ? (tableMap.get(inv.order.tableId) ?? null) : null;
      const waiterName = inv.waiterId ? (waiterMap.get(inv.waiterId) ?? null) : null;
      const invoiceTime = new Date(inv.createdAt).toLocaleTimeString();
      for (const it of inv.items ?? []) {
        rows.push({
          waiterName,
          orderNumber,
          orderType,
          tableName,
          item: it.description,
          quantity: dec(it.quantity).toFixed(2),
          unitPrice: dec(it.unitPrice).toFixed(2),
          discountPercent: dec(it.discountPercent).toFixed(2),
          discountType: it.discountType ?? 'percentage',
          discountAmount: dec(it.discountAmount).toFixed(2),
          discountReason: it.discountReason ?? null,
          // Line total incl. tax + line discount — identical definition to the
          // Items Report so per-line figures reconcile across the two tabs.
          total: dec(it.total).toFixed(2),
          date: inv.createdAt?.toISOString() ?? '',
          time: invoiceTime,
        });
      }
    }

    return rows;
  }

  /**
   * Order report — one row per order in a date range.
   * Columns: order number, date, table, waiter, customer, status, total.
   *
   * @param orderType - optional filter: 'dine_in' | 'takeaway' | 'delivery'
   * @param status - optional filter for order status (defaults to all non-cancelled)
   */
  async orderReport(
    fromDate: string,
    toDate: string,
    orderType?: string,
    status?: string,
    waiterId?: string,
    search?: string,
    includeCancelled = false,
  ) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);
    if (orderType && !ORDER_TYPES.has(orderType)) {
      throw new BadRequestException(`Unknown orderType "${orderType}"`);
    }
    const trimmedSearch = search?.trim();

    // Default scope is every non-cancelled order (drafts included — the Order is
    // the operational record). `status` narrows to one state; picking
    // "cancelled" is the only way to see cancelled orders.
    //
    // The `status` filter previously bailed out for 'draft' specifically, so
    // choosing Draft in the UI silently returned every status instead — the
    // one selection that looked like it did nothing.
    if (status && !ACCEPTED_ORDER_STATUSES.includes(status as any)) {
      throw new BadRequestException(`Unknown order status "${status}"`);
    }
    const canonicalStatus = status ? (toCanonicalOrderStatus(status) as any) : null;
    const statusScope = canonicalStatus
      ? { status: canonicalStatus }
      : includeCancelled
        ? {}
        : { status: { not: 'cancelled' } };

    const orders = await this.prisma.client.order.findMany({
      where: {
        organizationId,
        ...statusScope,
        ...(orderType ? { orderType: orderType as any } : {}),
        ...(waiterId ? { waiterId } : {}),
        ...(trimmedSearch ? { orderNumber: { contains: trimmedSearch, mode: 'insensitive' } } : {}),
        createdAt: { gte: start, lte: end },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Resolve table names
    const tableIds = new Set(orders.map((o: any) => o.tableId).filter(Boolean));
    const tables = tableIds.size
      ? await this.prisma.client.posTable.findMany({ where: { id: { in: Array.from(tableIds) } }, select: { id: true, name: true } })
      : [];
    const tableMap = new Map(tables.map((t: any) => [t.id, t.name]));

    // Resolve waiter names
    const waiterIds = new Set(orders.map((o: any) => o.waiterId).filter(Boolean));
    const waiters = waiterIds.size
      ? await this.prisma.client.user.findMany({ where: { id: { in: Array.from(waiterIds) } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const waiterMap = new Map(waiters.map((w: any) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]));

    // Resolve customer (partner) names
    const partnerIds = new Set(orders.map((o: any) => o.partnerId).filter(Boolean));
    const partners = partnerIds.size
      ? await this.prisma.client.partner.findMany({ where: { id: { in: Array.from(partnerIds) } }, select: { id: true, name: true } })
      : [];
    const partnerMap = new Map(partners.map((p: any) => [p.id, p.name]));

    return (orders as any[]).map((o) => ({
      orderNumber: o.orderNumber,
      orderType: o.orderType ?? null,
      time: new Date(o.createdAt).toLocaleTimeString(),
      date: o.createdAt?.toISOString() ?? '',
      tableName: o.tableId ? (tableMap.get(o.tableId) ?? null) : null,
      waiterName: o.waiterId ? (waiterMap.get(o.waiterId) ?? null) : null,
      customerName: o.partnerId ? (partnerMap.get(o.partnerId) ?? null) : null,
      status: o.status,
      totalAmount: dec(o.totalAmount).toFixed(2),
    }));
  }

  /**
   * Sold items detail report — every line item in a date range.
   * Columns: order number, invoice number, sale date, item, unit price,
   * discount, quantity, total amount, waiter.
   *
   * @param categoryId - optional filter by category.
   * @param waiterId - optional filter by waiter user ID.
   */
  async soldItems(
    fromDate: string,
    toDate: string,
    categoryId?: string,
    waiterId?: string,
    orderType?: string,
    search?: string,
    itemSearch?: string,
    paymentMethod?: string,
  ) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);

    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, { waiterId, orderType, search, paymentMethod }),
      include: {
        items: true,
        order: { select: { orderNumber: true, orderType: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const itemNeedle = itemSearch?.trim().toLowerCase() || null;

    // Collect unique waiter IDs
    const waiterIds = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.waiterId) waiterIds.add(inv.waiterId);
    }

    const waiters = waiterIds.size
      ? await this.prisma.client.user.findMany({
          where: { id: { in: Array.from(waiterIds) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const waiterMap = new Map(waiters.map((w: any) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]));

    // Collect all product IDs from invoice items
    const productIds = new Set<string>();
    for (const inv of invoices as any[]) {
      for (const it of inv.items ?? []) {
        if (it.productId) productIds.add(it.productId);
      }
    }

    // Build product → category lookup
    const products = productIds.size
      ? await this.prisma.client.product.findMany({
          where: { id: { in: Array.from(productIds) } },
          include: { category: { select: { name: true } } },
        })
      : [];
    const productMap = new Map(
      products.map((p: any) => [
        p.id,
        {
          name: p.name,
          productCategoryName: p.category?.name ?? null,
          categoryId: p.category?.id ?? null,
        },
      ]),
    );

    // Build menuItem → menuCategory lookup (fallback for menu-driven sales)
    const menuItemIds = new Set<string>();
    for (const inv of invoices as any[]) {
      for (const it of inv.items ?? []) {
        const mid = it.menuItemId;
        if (mid) menuItemIds.add(mid);
      }
    }
    const menuItems = menuItemIds.size
      ? await this.prisma.client.menuItem.findMany({
          where: { id: { in: Array.from(menuItemIds) } },
          include: { category: { select: { id: true, name: true } } },
        })
      : [];
    const menuItemMap = new Map(
      menuItems.map((mi: any) => [
        mi.id,
        { categoryId: mi.category?.id ?? null, categoryName: mi.category?.name ?? null },
      ]),
    );

    // If category filter is active, resolve allowed product IDs (from product)
    // and menu item IDs. A line matches when EITHER its product OR its menu
    // item belongs to the selected category.
    const allowedProductIds = categoryId ? new Set(products.filter((p: any) => (p.categoryId ?? p.category?.id) === categoryId).map((p: any) => p.id)) : null;
    const allowedMenuItemIds = categoryId ? new Set(menuItems.filter((mi: any) => (mi.categoryId ?? mi.category?.id) === categoryId).map((mi: any) => mi.id)) : null;

    const rows: Array<{
      orderNumber: string;
      invoiceNumber: string;
      saleDate: string;
      time: string;
      item: string;
      unitPrice: string;
      discountPercent: string;
      discountType: string;
      discountAmount: string;
      discountReason: string | null;
      quantity: string;
      totalAmount: string;
      waiterName: string | null;
      categoryName: string | null;
      orderType: string | null;
    }> = [];

    for (const inv of invoices as any[]) {
      const orderNumber = inv.order?.orderNumber ?? '—';
      const orderType = inv.order?.orderType ?? null;
      const invoiceTime = new Date(inv.createdAt).toLocaleTimeString();
      for (const it of inv.items ?? []) {
        const prod = it.productId ? productMap.get(it.productId) : null;
        const miCat = it.menuItemId ? menuItemMap.get(it.menuItemId)?.categoryName : null;
        const categoryName = prod?.productCategoryName ?? miCat ?? 'Uncategorised';

        // Apply category filter — keep ONLY items whose product or menu item
        // belongs to the selected category. (The previous logic inverted the
        // test — `has()` → `continue` — so it returned everything EXCEPT the
        // selected category whenever both lookup sets were populated.)
        if (allowedProductIds && allowedMenuItemIds) {
          const byProduct = it.productId && allowedProductIds.has(it.productId);
          const byMenuItem = it.menuItemId && allowedMenuItemIds.has(it.menuItemId);
          if (!byProduct && !byMenuItem) continue;
        } else if (allowedProductIds) {
          if (!(it.productId && allowedProductIds.has(it.productId))) continue;
        } else if (allowedMenuItemIds) {
          if (!(it.menuItemId && allowedMenuItemIds.has(it.menuItemId))) continue;
        }

        // Free-text item search — the line description is what the operator
        // recognises, and it survives a menu item being renamed or deleted.
        if (itemNeedle && !String(it.description ?? '').toLowerCase().includes(itemNeedle)) continue;

        rows.push({
          orderNumber,
          orderType,
          invoiceNumber: inv.invoiceNumber,
          saleDate: inv.createdAt?.toISOString() ?? '',
          time: invoiceTime,
          item: it.description,
          unitPrice: dec(it.unitPrice).toFixed(2),
          discountPercent: dec(it.discountPercent).toFixed(2),
          discountType: it.discountType ?? 'percentage',
          discountAmount: dec(it.discountAmount).toFixed(2),
          discountReason: it.discountReason ?? null,
          quantity: dec(it.quantity).toFixed(2),
          totalAmount: dec(it.total).toFixed(2),
          waiterName: inv.waiterId ? (waiterMap.get(inv.waiterId) ?? null) : null,
          categoryName,
        });
      }
    }

    return rows;
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

    /**
     * Items sold grouped by item group (category) — aggregated quantities and totals.
     * Returns: array of { groupName, totalQuantity, totalAmount, itemCount }
     * 
     * @param fromDate - start date (YYYY-MM-DD)
     * @param toDate - end date (YYYY-MM-DD)
     * @param orderType - optional filter: 'dine_in' | 'takeaway' | 'delivery'
     */
    async itemsByGroup(fromDate: string, toDate: string, orderType?: string, waiterId?: string, categoryId?: string, paymentMethod?: string) {
      const organizationId = this.tenant.organizationId;
      const [start, end] = parseReportRange(fromDate, toDate);

      // Get all POS invoices in range
      const invoices = await this.prisma.client.invoice.findMany({
        where: posSaleWhere(organizationId, start, end, { orderType, waiterId, paymentMethod }),
        include: { items: true },
      });

      // Collect product IDs and menu item IDs
      const productIds = new Set<string>();
      const menuItemIds = new Set<string>();
      for (const inv of invoices as any[]) {
        for (const it of inv.items ?? []) {
          if (it.productId) productIds.add(it.productId);
          if (it.menuItemId) menuItemIds.add(it.menuItemId);
        }
      }

      // Build product → category lookup
      const products = productIds.size
        ? await this.prisma.client.product.findMany({
            where: { id: { in: Array.from(productIds) } },
            include: { category: { select: { id: true, name: true } } },
          })
        : [];
      const productMap = new Map(
        products.map((p: any) => [
          p.id,
          {
            name: p.name,
            categoryId: p.category?.id ?? null,
            categoryName: p.category?.name ?? null,
          },
        ]),
      );

      // Build menuItem → menuCategory lookup
      const menuItems = menuItemIds.size
        ? await this.prisma.client.menuItem.findMany({
            where: { id: { in: Array.from(menuItemIds) } },
            include: { category: { select: { id: true, name: true } } },
          })
        : [];
      const menuItemMap = new Map(
        menuItems.map((mi: any) => [
          mi.id,
          {
            categoryId: mi.category?.id ?? null,
            categoryName: mi.category?.name ?? null,
          },
        ]),
      );

      // Aggregate by category
      const groupMap = new Map<
        string,
        {
          groupName: string;
          groupId: string | null;
          totalQuantity: Money;
          totalAmount: Money;
          itemCount: number;
        }
      >();

      for (const inv of invoices as any[]) {
        for (const it of inv.items ?? []) {
          let groupId: string | null = null;
          let groupName = 'Uncategorised';

          if (it.productId) {
            const prod = productMap.get(it.productId);
            if (prod) {
              groupId = prod.categoryId;
              groupName = prod.categoryName ?? 'Uncategorised';
            }
          } else if (it.menuItemId) {
            const mi = menuItemMap.get(it.menuItemId);
            if (mi) {
              groupId = mi.categoryId;
              groupName = mi.categoryName ?? 'Uncategorised';
            }
          }

          if (categoryId && groupId !== categoryId) continue;

          const key = groupId ?? 'uncategorised';
          const bucket = groupMap.get(key) ?? {
            groupName,
            groupId,
            totalQuantity: dec(0),
            totalAmount: dec(0),
            itemCount: 0,
          };

          bucket.totalQuantity = bucket.totalQuantity.plus(dec(it.quantity));
          bucket.totalAmount = bucket.totalAmount.plus(dec(it.total ?? 0));
          bucket.itemCount += 1;
          groupMap.set(key, bucket);
        }
      }

      // Sort by total amount descending
      return Array.from(groupMap.values())
        .sort((a, b) => b.totalAmount.minus(a.totalAmount).toNumber())
        .map((g) => ({
          groupId: g.groupId,
          groupName: g.groupName,
          totalQuantity: g.totalQuantity.toFixed(2),
          totalAmount: g.totalAmount.toFixed(2),
          itemCount: g.itemCount,
        }));
    }


    /**
     * Item sales report — one row per item, aggregated across the range.
     * Columns: item, quantity sold, unit price, total price.
     *
     * Grouping key is the menu item / product identity (falling back to the
     * line description) so the same dish sold across many orders collapses to
     * a single row. `unitPrice` is the effective average (total ÷ quantity) so
     * the three money columns always reconcile even when lines were discounted
     * or priced differently across the range.
     *
     * The response also carries the *unfiltered* option lists (items, waiters,
     * categories) seen in the date range, so the UI can populate its dropdowns
     * without extra round-trips — and without them collapsing to whatever the
     * current selection already narrowed the result to.
     *
     * @param itemKey - optional filter by grouping key (menu item / product id).
     * @param categoryId - optional filter by category.
     * @param waiterId - optional filter by waiter user ID.
     * @param orderType - optional filter: 'dine_in' | 'takeaway' | 'delivery'
     */
    async itemSales(
      fromDate: string,
      toDate: string,
      itemKey?: string,
      categoryId?: string,
      waiterId?: string,
      orderType?: string,
      paymentMethod?: string,
      itemSearch?: string,
    ) {
      const organizationId = this.tenant.organizationId;
      const [start, end] = parseReportRange(fromDate, toDate);

      // Date range / order type / tender scope the SQL; item, category and
      // waiter are applied in-memory so the option lists stay complete for the
      // range instead of collapsing to whatever is already selected.
      const invoices = await this.prisma.client.invoice.findMany({
        where: posSaleWhere(organizationId, start, end, { orderType, paymentMethod }),
        include: { items: true },
      });
      const itemNeedle = itemSearch?.trim().toLowerCase() || null;

      const productIds = new Set<string>();
      const menuItemIds = new Set<string>();
      const waiterIds = new Set<string>();
      for (const inv of invoices as any[]) {
        if (inv.waiterId) waiterIds.add(inv.waiterId);
        for (const it of inv.items ?? []) {
          if (it.productId) productIds.add(it.productId);
          if (it.menuItemId) menuItemIds.add(it.menuItemId);
        }
      }

      const [products, menuItems, waiters] = await Promise.all([
        productIds.size
          ? this.prisma.client.product.findMany({
              where: { id: { in: Array.from(productIds) } },
              select: { id: true, name: true, categoryId: true, category: { select: { id: true, name: true } } },
            })
          : Promise.resolve([] as any[]),
        menuItemIds.size
          ? this.prisma.client.menuItem.findMany({
              where: { id: { in: Array.from(menuItemIds) } },
              select: { id: true, name: true, categoryId: true, category: { select: { id: true, name: true } } },
            })
          : Promise.resolve([] as any[]),
        waiterIds.size
          ? this.prisma.client.user.findMany({
              where: { id: { in: Array.from(waiterIds) } },
              select: { id: true, firstName: true, lastName: true },
            })
          : Promise.resolve([] as any[]),
      ]);

      const productMap = new Map(
        (products as any[]).map((p) => [p.id, { name: p.name, categoryId: p.category?.id ?? null, categoryName: p.category?.name ?? null }]),
      );
      const menuItemMap = new Map(
        (menuItems as any[]).map((mi) => [mi.id, { name: mi.name, categoryId: mi.category?.id ?? null, categoryName: mi.category?.name ?? null }]),
      );
      const waiterMap = new Map(
        (waiters as any[]).map((w) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]),
      );

      const buckets = new Map<
        string,
        {
          itemKey: string;
          item: string;
          categoryId: string | null;
          categoryName: string;
          quantity: Money;
          totalAmount: Money;
        }
      >();
      // Option lists for the UI — every item / waiter seen in the range,
      // regardless of the currently applied item/category/waiter filter.
      const itemOptions = new Map<string, string>();
      const waiterOptions = new Map<string, string>();
      const categoryOptions = new Map<string, string>();

      for (const inv of invoices as any[]) {
        const invWaiterId: string | null = inv.waiterId ?? null;
        if (invWaiterId) waiterOptions.set(invWaiterId, waiterMap.get(invWaiterId) ?? '—');

        for (const it of inv.items ?? []) {
          const meta = it.menuItemId
            ? menuItemMap.get(it.menuItemId)
            : it.productId
              ? productMap.get(it.productId)
              : null;

          const key = it.menuItemId ?? it.productId ?? `desc:${it.description}`;
          const name = meta?.name ?? it.description;
          const catId: string | null = meta?.categoryId ?? null;
          const catName = meta?.categoryName ?? 'Uncategorised';

          itemOptions.set(key, name);
          if (catId) categoryOptions.set(catId, catName);

          if (itemKey && key !== itemKey) continue;
          if (categoryId && catId !== categoryId) continue;
          if (waiterId && invWaiterId !== waiterId) continue;
          if (itemNeedle && !String(name ?? '').toLowerCase().includes(itemNeedle)) continue;

          const bucket = buckets.get(key) ?? {
            itemKey: key,
            item: name,
            categoryId: catId,
            categoryName: catName,
            quantity: dec(0),
            totalAmount: dec(0),
          };
          bucket.quantity = bucket.quantity.plus(dec(it.quantity));
          bucket.totalAmount = bucket.totalAmount.plus(dec(it.total ?? 0));
          buckets.set(key, bucket);
        }
      }

      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

      return {
        rows: Array.from(buckets.values())
          .sort((a, b) => b.totalAmount.minus(a.totalAmount).toNumber())
          .map((b) => ({
            itemKey: b.itemKey,
            item: b.item,
            categoryId: b.categoryId,
            categoryName: b.categoryName,
            quantity: b.quantity.toFixed(2),
            // Effective average unit price — keeps qty × unitPrice ≈ total.
            unitPrice: b.quantity.isZero() ? dec(0).toFixed(2) : b.totalAmount.div(b.quantity).toFixed(2),
            totalAmount: b.totalAmount.toFixed(2),
          })),
        filters: {
          items: Array.from(itemOptions, ([key, name]) => ({ key, name })).sort(byName),
          waiters: Array.from(waiterOptions, ([id, name]) => ({ id, name })).sort(byName),
          categories: Array.from(categoryOptions, ([id, name]) => ({ id, name })).sort(byName),
        },
      };
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

  /**
   * Insert zero buckets for periods inside the range that saw no sales.
   *
   * A "last 7 days" table that silently omits the closed Monday reads as if
   * Monday never existed; an explicit 0 row is the honest answer and keeps the
   * period column contiguous for charting.
   */
  private withEmptyPeriods<T>(
    grouped: Map<string, T>,
    groupBy: 'day' | 'week' | 'month',
    start: Date,
    end: Date,
    fresh: () => T,
  ): Map<string, T> {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    // Guard against a pathological range producing an unbounded key list.
    for (let guard = 0; cursor.getTime() <= last.getTime() && guard < 3660; guard += 1) {
      const key =
        groupBy === 'day'
          ? localIso(cursor)
          : groupBy === 'month'
            ? localIso(cursor).slice(0, 7)
            : null;
      if (key && !grouped.has(key)) grouped.set(key, fresh());
      cursor.setDate(cursor.getDate() + 1);
    }
    return grouped;
  }

  /**
   * Refunds that happened in the range, narrowed to the same slice of sales the
   * caller is looking at.
   *
   * A refund is its own event, dated when the money went back — so it is always
   * selected by its OWN `createdAt`, even when the original sale predates the
   * range. But when a filter is active (one waiter, card only, takeaway only…)
   * a refund only belongs in the total if its PARENT invoice satisfies that same
   * filter; otherwise the tab nets out money it never showed as revenue.
   */
  private async loadRefundsForScope(
    organizationId: string,
    start: Date,
    end: Date,
    filters: PosSaleFilters,
    inRangeInvoices: Array<{ id: string }>,
  ): Promise<any[]> {
    const refunds = await this.prisma.client.posRefund.findMany({
      where: { organizationId, createdAt: { gte: start, lte: end } },
    });
    const hasFilter = Boolean(
      filters.waiterId || filters.paymentMethod || filters.orderType || filters.search || filters.tableId || filters.cashSessionId,
    );
    if (!hasFilter || refunds.length === 0) return refunds as any[];

    // Parents already known to be in scope need no second look-up; the rest are
    // resolved with the same filter minus the date window.
    const known = new Set(inRangeInvoices.map((i) => i.id));
    const unknown = Array.from(
      new Set((refunds as any[]).map((r) => r.invoiceId).filter((id: string) => id && !known.has(id))),
    );
    const matched = new Set(known);
    if (unknown.length) {
      const where = posSaleWhere(organizationId, start, end, filters);
      delete where.createdAt; // the refund's date is what places it in the range
      const parents = await this.prisma.client.invoice.findMany({
        where: { ...where, id: { in: unknown } },
        select: { id: true },
      });
      for (const p of parents as any[]) matched.add(p.id);
    }
    return (refunds as any[]).filter((r) => matched.has(r.invoiceId));
  }

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
