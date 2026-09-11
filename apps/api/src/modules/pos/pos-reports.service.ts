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
 * Moved to `@erp/shared` so HR's per-employee sales analytics can use the
 * identical list — `hr` and `pos` are both verticals and may not import each
 * other. Re-exported here so every existing import site keeps working.
 */
import { POS_SALE_STATUSES } from '@erp/shared';

export { POS_SALE_STATUSES };

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
    // A-031: bucket by the BUSINESS date (issueDate) — an offline sale keeps
    // its original day even when it syncs later. createdAt would mis-date it
    // to the sync day and disagree with the GL (postingDate == issueDate).
    issueDate: { gte: start, lte: end },
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

/**
 * A POS sale line's category, resolved once and used identically by every item
 * report (display AND filtering).
 *
 * `key` is the TYPED filter key. `MenuCategory` and `ProductCategory` are two
 * disjoint trees; collapsing them into one bare-id keyspace let a filter match
 * across trees and split one logical category into two dropdown entries. Until
 * a common `SalesCategory` dimension exists, the key carries its tree.
 */
export type SaleCategory = {
  key: string | null;
  id: string | null;
  name: string;
  source: 'snapshot' | 'menu' | 'product' | 'legacy_bridge' | null;
};

/** The line shape the resolver needs — an OrderItem or an InvoiceItem row. */
export type SaleCategoryLine = {
  productId?: string | null;
  menuItemId?: string | null;
  /** Phase 2 snapshot columns. Absent today; read first once they exist. */
  salesCategoryId?: string | null;
  salesCategoryName?: string | null;
  salesCategorySource?: string | null;
};

const UNCATEGORISED: SaleCategory = { key: null, id: null, name: 'Uncategorised', source: null };
/**
 * The product carries no ProductCategory and its `MenuProduct` recipes lead to
 * MORE THAN ONE MenuCategory, so no honest answer exists. Reported as its own
 * bucket rather than silently picking the first row, so the Phase 4 backfill
 * gets a worklist instead of a guess baked into history.
 */
const LEGACY_UNRESOLVED: SaleCategory = { key: null, id: null, name: 'Legacy unresolved', source: null };

@Injectable()
export class PosReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /**
   * Build the ONE category rule shared by every POS item report.
   *
   * A sale line can carry a `menuItemId`, a `productId`, or (on rows written
   * before `resolveSkus` stopped stamping an incidental productId onto menu
   * lines) both. Each report used to re-infer the answer with its own
   * precedence, so the same range produced different category totals in
   * Items, Items by Group and Item Sales. This is that precedence, once:
   *
   *   1. the invoice's own snapshot, when present (Phase 2 — no-op today)
   *   2. menuItemId -> MenuItem.category      (MenuCategory)
   *   3. productId  -> Product.category       (ProductCategory)
   *   4. productId  -> MenuProduct -> MenuItem.category, ONLY when unambiguous
   *   5. Uncategorised / Legacy unresolved
   *
   * It falls through on a NULL CATEGORY, not merely on a missing id — a menu
   * item that has no MenuCategory still defers to the product beneath it,
   * which the old `if (menuItemId) ... else if (productId)` shape could not do.
   *
   * Step 4 is a LEGACY path only. `MenuProduct` is a recipe (one product
   * belongs to many menu items), so it can never say which menu item was
   * sold; it is consulted solely to classify historical product-only cafe
   * rows, and only when every recipe it appears in agrees on one category.
   */
  private async saleCategoryResolver(lines: SaleCategoryLine[]): Promise<{
    resolve: (line: SaleCategoryLine) => SaleCategory;
    productName: (id: string) => string | null;
    menuItemName: (id: string) => string | null;
  }> {
    const productIds = new Set<string>();
    const menuItemIds = new Set<string>();
    for (const l of lines) {
      if (l.productId) productIds.add(l.productId);
      if (l.menuItemId) menuItemIds.add(l.menuItemId);
    }

    // `id` MUST be selected on the row itself, not only on the relation — the
    // previous shape selected just `category { id, name }`, so `p.id` was
    // undefined and every downstream `productId: { in: [...] }` matched nothing.
    const [products, menuItems] = await Promise.all([
      productIds.size
        ? this.prisma.client.product.findMany({
            where: { id: { in: Array.from(productIds) } },
            select: { id: true, name: true, category: { select: { id: true, name: true } } },
          })
        : Promise.resolve([] as any[]),
      menuItemIds.size
        ? this.prisma.client.menuItem.findMany({
            where: { id: { in: Array.from(menuItemIds) } },
            select: { id: true, name: true, category: { select: { id: true, name: true } } },
          })
        : Promise.resolve([] as any[]),
    ]);

    const productMap = new Map(
      (products as any[]).map((p) => [
        p.id as string,
        {
          name: p.name as string,
          categoryId: (p.category?.id ?? null) as string | null,
          categoryName: (p.category?.name ?? null) as string | null,
        },
      ]),
    );
    const menuItemMap = new Map(
      (menuItems as any[]).map((m) => [
        m.id as string,
        {
          name: m.name as string,
          categoryId: (m.category?.id ?? null) as string | null,
          categoryName: (m.category?.name ?? null) as string | null,
        },
      ]),
    );

    const bridge = await this.legacyBridge(
      Array.from(productMap.entries())
        .filter(([, v]) => !v.categoryId)
        .map(([id]) => id),
    );

    const resolve = (line: SaleCategoryLine): SaleCategory => {
      // 1. Snapshot wins outright — it is what the sale actually was.
      if (line.salesCategoryId || line.salesCategoryName) {
        const tree = line.salesCategorySource === 'product' ? 'product' : 'menu';
        return {
          key: line.salesCategoryId ? tree + ':' + line.salesCategoryId : null,
          id: line.salesCategoryId ?? null,
          name: line.salesCategoryName ?? 'Uncategorised',
          source: 'snapshot',
        };
      }
      // 2. Menu identity.
      const mi = line.menuItemId ? menuItemMap.get(line.menuItemId) : null;
      if (mi?.categoryId) {
        return { key: 'menu:' + mi.categoryId, id: mi.categoryId, name: mi.categoryName ?? 'Uncategorised', source: 'menu' };
      }
      // 3. Product identity.
      const prod = line.productId ? productMap.get(line.productId) : null;
      if (prod?.categoryId) {
        return { key: 'product:' + prod.categoryId, id: prod.categoryId, name: prod.categoryName ?? 'Uncategorised', source: 'product' };
      }
      // 4. Legacy recipe bridge, unambiguous only.
      if (line.productId) {
        const b = bridge.get(line.productId);
        if (b === 'ambiguous') return LEGACY_UNRESOLVED;
        if (b) return { key: 'menu:' + b.id, id: b.id, name: b.name, source: 'legacy_bridge' };
      }
      return UNCATEGORISED;
    };

    return {
      resolve,
      productName: (id: string) => productMap.get(id)?.name ?? null,
      menuItemName: (id: string) => menuItemMap.get(id)?.name ?? null,
    };
  }

  /**
   * `productId -> MenuCategory` for products that have no ProductCategory of
   * their own, but ONLY where every menu item the product appears in resolves
   * to the same category. A product used by menu items in different categories
   * yields `'ambiguous'`; the caller reports it as Legacy unresolved rather
   * than taking whatever row the database happened to return first (the old
   * `distinct: ['productId']` with no `orderBy`).
   */
  private async legacyBridge(
    productIds: string[],
  ): Promise<Map<string, { id: string; name: string } | 'ambiguous'>> {
    const out = new Map<string, { id: string; name: string } | 'ambiguous'>();
    if (!productIds.length) return out;
    const rows = await this.prisma.client.menuProduct.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, menuItem: { select: { category: { select: { id: true, name: true } } } } },
    });
    const seen = new Map<string, Map<string, string>>();
    for (const r of rows as any[]) {
      const cat = r.menuItem?.category;
      if (!cat?.id) continue;
      if (!seen.has(r.productId)) seen.set(r.productId, new Map());
      seen.get(r.productId)!.set(cat.id, cat.name);
    }
    for (const [productId, cats] of seen) {
      if (cats.size !== 1) {
        out.set(productId, 'ambiguous');
        continue;
      }
      const entry = cats.entries().next().value as [string, string];
      out.set(productId, { id: entry[0], name: entry[1] });
    }
    return out;
  }

  /**
   * Products that the legacy recipe bridge assigns to `menuCategoryId` — i.e.
   * they carry no ProductCategory of their own and every menu item they appear
   * in resolves to that one category. The SQL counterpart of step 4 of
   * `saleCategoryResolver`, for reports that must filter in the database.
   */
  private async bridgedProductIds(menuCategoryId: string): Promise<string[]> {
    const rows = await this.prisma.client.menuProduct.findMany({
      where: { menuItem: { categoryId: menuCategoryId } },
      select: { productId: true },
    });
    const candidates = Array.from(new Set((rows as any[]).map((r) => r.productId as string)));
    if (!candidates.length) return [];
    // Only products with NO ProductCategory fall through to the bridge at all.
    const uncategorised = await this.prisma.client.product.findMany({
      where: { id: { in: candidates }, categoryId: null },
      select: { id: true },
    });
    const bridge = await this.legacyBridge((uncategorised as any[]).map((p) => p.id as string));
    const out: string[] = [];
    for (const [productId, resolved] of bridge) {
      if (resolved !== 'ambiguous' && resolved.id === menuCategoryId) out.push(productId);
    }
    return out;
  }

  /**
   * Does a resolved category match the filter the UI sent?
   *
   * Accepts the typed key (`menu:<id>` / `product:<id>`) and, for links and
   * saved views created before typing, a bare category id.
   */
  private matchesCategory(cat: SaleCategory, filter: string): boolean {
    return cat.key === filter || cat.id === filter;
  }

  /** Split a typed filter key into its tree and raw id. */
  private parseCategoryFilter(filter: string): { tree: 'menu' | 'product' | null; id: string } {
    const i = filter.indexOf(':');
    if (i < 0) return { tree: null, id: filter };
    const tree = filter.slice(0, i);
    return { tree: tree === 'menu' || tree === 'product' ? tree : null, id: filter.slice(i + 1) };
  }

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
    const paymentModes = new Set<string>();
    const lines: SaleCategoryLine[] = [];
    for (const inv of invoices as any[]) {
      if (inv.waiterId) waiterIds.add(inv.waiterId);
      if (inv.paymentMode) paymentModes.add(inv.paymentMode);
      for (const it of inv.items ?? []) lines.push(it);
    }

    const [waiters, cat] = await Promise.all([
      waiterIds.size
        ? this.prisma.client.user.findMany({
            where: { id: { in: Array.from(waiterIds) } },
            select: { id: true, firstName: true, lastName: true },
          })
        : Promise.resolve([] as any[]),
      this.saleCategoryResolver(lines),
    ]);

    // The dropdown is built by running the SAME resolver the reports run, over
    // the SAME lines. Anything else lets a manager pick a category no report
    // will ever attribute a line to (or hides one that every report shows).
    const categories = new Map<string, string>();
    for (const line of lines) {
      const c = cat.resolve(line);
      if (c.key) categories.set(c.key, c.name);
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
      select: { totalAmount: true, issueDate: true, createdAt: true },
    });

    const buckets = new Array(24).fill(0).map((_, hour) => ({ hour, count: 0, total: dec(0) }));
    for (const d of invoices as any[]) {
      // A-031: business hour. The `?? createdAt` fallback is not cosmetic — a
      // row with a null issueDate produced `new Date(null).getHours()` = NaN,
      // and `buckets[NaN].count += 1` threw, taking the whole report down.
      // Every other method in this file already reads `issueDate ?? createdAt`.
      const hour = new Date(d.issueDate ?? d.createdAt).getHours();
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
      select: { id: true, subtotal: true, totalAmount: true, discountTotal: true, taxAmount: true, status: true, createdAt: true, issueDate: true },
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
      const key = periodKey(new Date(r.issueDate ?? r.createdAt)); // A-031: business date
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
      //
      // Unlike the in-memory reports this one filters in SQL (the groupBy has
      // to stay in the database), so the resolver's precedence is reproduced
      // here as id allow-lists — including the legacy recipe bridge, without
      // which a bridged item was displayed by every other tab but invisible
      // to a category-filtered Top Items.
      const { tree, id } = this.parseCategoryFilter(categoryId);
      const [catsProducts, catsMenuItems] = await Promise.all([
        tree === 'menu'
          ? Promise.resolve([] as any[])
          : this.prisma.client.product.findMany({ where: { organizationId, categoryId: id }, select: { id: true } }),
        tree === 'product'
          ? Promise.resolve([] as any[])
          : this.prisma.client.menuItem.findMany({ where: { organizationId, categoryId: id }, select: { id: true } }),
      ]);
      const allowedProductIds = (catsProducts as any[]).map((p) => p.id);
      const allowedMenuItemIds = (catsMenuItems as any[]).map((m) => m.id);
      if (tree !== 'product') allowedProductIds.push(...(await this.bridgedProductIds(id)));
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
      _sum: { quantity: true, total: true, refundedQty: true },
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
      // A-031: NET of refunds — refundedQty is persisted per line by the refund
      // operation, so returned goods no longer inflate top-item figures.
      const refunded = dec(g._sum?.refundedQty ?? 0);
      cur.quantity = cur.quantity.plus(dec(g._sum?.quantity ?? 0)).minus(refunded);
      const unitAvg = dec(g._sum?.quantity ?? 0).gt(0)
        ? dec(g._sum?.total ?? 0).dividedBy(dec(g._sum?.quantity ?? 0))
        : dec(0);
      cur.total = cur.total.plus(dec(g._sum?.total ?? 0)).minus(unitAvg.times(refunded));
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
      saleDate: (inv.issueDate ?? inv.createdAt)?.toISOString() ?? '',
      // Kept for older consumers; the UI formats from `saleDate` so the time is
      // rendered in the READER's timezone, not the API host's.
      time: new Date(inv.issueDate ?? inv.createdAt).toLocaleTimeString(),
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
      saleDate: (inv.issueDate ?? inv.createdAt)?.toISOString() ?? '',
      time: new Date(inv.issueDate ?? inv.createdAt).toLocaleTimeString(),
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
      let adjustments = dec(0);
      for (const m of s.movements ?? []) {
        const amt = dec(m.amount);
        if (m.movementType === 'sale') cashCollected = cashCollected.plus(amt);
        else if (m.movementType === 'refund') cashRefunds = cashRefunds.plus(amt);
        else if (m.movementType === 'pay_in') payIns = payIns.plus(amt);
        else if (m.movementType === 'pay_out') payOuts = payOuts.plus(amt);
        // A-006: adjustments are part of the drawer. computeExpected and the
        // close-time reconciliation both include them — omitting them here made
        // this report disagree with the frozen Z on any shift that had one.
        else if (m.movementType === 'adjustment') adjustments = adjustments.plus(amt);
      }

      const openingCash = dec(s.openingFloat);
      // A-006: same formula as CashSessionService.computeExpected —
      // opening + sales + pay_in + adjustment − pay_out − refunds.
      const expectedCash = openingCash.plus(cashCollected).minus(cashRefunds).plus(payIns).minus(payOuts).plus(adjustments);
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
        adjustments: adjustments.toFixed(2),
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
      const invoiceTime = new Date(inv.issueDate ?? inv.createdAt).toLocaleTimeString();
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
          date: (inv.issueDate ?? inv.createdAt)?.toISOString() ?? '',
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
      // Per-item punchers too — a line's server need not be the order's waiter.
      for (const it of inv.items ?? []) if (it.punchedById) waiterIds.add(it.punchedById);
    }

    const waiters = waiterIds.size
      ? await this.prisma.client.user.findMany({
          where: { id: { in: Array.from(waiterIds) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const waiterMap = new Map(waiters.map((w: any) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]));

    // One category rule for every item report — see `saleCategoryResolver`.
    const cat = await this.saleCategoryResolver(
      (invoices as any[]).flatMap((inv) => (inv.items ?? []) as SaleCategoryLine[]),
    );

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
      servedBy: string | null;
      categoryName: string | null;
      orderType: string | null;
    }> = [];

    for (const inv of invoices as any[]) {
      const orderNumber = inv.order?.orderNumber ?? '—';
      const orderType = inv.order?.orderType ?? null;
      const invoiceTime = new Date(inv.issueDate ?? inv.createdAt).toLocaleTimeString();
      for (const it of inv.items ?? []) {
        // This report used to check the PRODUCT first, so a menu line whose
        // incidentally-stamped product had no ProductCategory printed
        // "Uncategorised" while Items by Group showed the real MenuCategory.
        const c = cat.resolve(it);
        const categoryName = c.name;

        // Filtering runs off the SAME resolved value that is displayed, so a
        // category the report shows is always a category the report can narrow
        // to — including one reached through the legacy recipe bridge.
        if (categoryId && !this.matchesCategory(c, categoryId)) continue;

        // Free-text item search — the line description is what the operator
        // recognises, and it survives a menu item being renamed or deleted.
        if (itemNeedle && !String(it.description ?? '').toLowerCase().includes(itemNeedle)) continue;

        rows.push({
          orderNumber,
          orderType,
          invoiceNumber: inv.invoiceNumber,
          saleDate: (inv.issueDate ?? inv.createdAt)?.toISOString() ?? '',
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
          // Who punched THIS line. An order can be taken by several waiters in
          // turn, so the order-level waiter is the wrong answer per item; it is
          // only the fallback for lines billed before per-item stamping existed.
          servedBy: it.punchedByName
            ?? (it.punchedById ? (waiterMap.get(it.punchedById) ?? null) : null)
            ?? (inv.waiterId ? (waiterMap.get(inv.waiterId) ?? null) : null),
          categoryName,
        });
      }
    }

    return rows;
  }

  /**
   * Who sold what, per ITEM — the report the order-level waiter reports could
   * never answer.
   *
   * `Invoice.waiterId` names the person who OWNS the order; on a busy floor a
   * table is rung up by whoever is nearest, so the order owner is not reliably
   * the person who punched any given line. This report reads
   * `InvoiceItem.punchedById` — stamped when the line was first created and
   * never rewritten by a later editor — and groups it by day or by shift (the
   * cash session), which is how a supervisor actually reconciles a service.
   *
   * Lines billed before per-item stamping existed fall back to the order's
   * waiter, so a range that spans the change still totals to the same money.
   *
   * @param groupBy 'day' (business date) | 'shift' (cash session) | 'none'
   */
  async itemsByServer(
    fromDate: string,
    toDate: string,
    groupBy: 'day' | 'shift' | 'none' = 'day',
    filters: PosSaleFilters & { categoryId?: string; itemSearch?: string } = {},
  ) {
    const organizationId = this.tenant.organizationId;
    const [start, end] = parseReportRange(fromDate, toDate);
    if (!['day', 'shift', 'none'].includes(groupBy)) {
      throw new BadRequestException(`Unknown groupBy "${groupBy}"`);
    }

    const { categoryId, itemSearch, ...saleFilters } = filters;
    const invoices = await this.prisma.client.invoice.findMany({
      where: posSaleWhere(organizationId, start, end, saleFilters),
      include: { items: true, order: { select: { orderType: true } } },
      orderBy: { issueDate: 'asc' },
    });

    // Names + shift labels for everything the rows will reference.
    const staffIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const inv of invoices as any[]) {
      if (inv.waiterId) staffIds.add(inv.waiterId);
      if (inv.cashSessionId) sessionIds.add(inv.cashSessionId);
      for (const it of inv.items ?? []) if (it.punchedById) staffIds.add(it.punchedById);
    }
    const [staff, sessions] = await Promise.all([
      staffIds.size
        ? this.prisma.client.user.findMany({ where: { id: { in: Array.from(staffIds) } }, select: { id: true, firstName: true, lastName: true } })
        : Promise.resolve([]),
      groupBy === 'shift' && sessionIds.size
        ? this.prisma.client.cashSession.findMany({ where: { id: { in: Array.from(sessionIds) } }, select: { id: true, openedAt: true, closedAt: true, cashRegisterId: true } })
        : Promise.resolve([]),
    ]);
    const staffName = new Map((staff as any[]).map((u) => [u.id, `${u.firstName}${u.lastName ? ' ' + u.lastName : ''}`.trim()]));
    const sessionLabel = new Map(
      (sessions as any[]).map((c) => [
        c.id,
        `${localIso(new Date(c.openedAt))} ${new Date(c.openedAt).toLocaleTimeString()}${c.closedAt ? '' : ' (open)'}`,
      ]),
    );

    const cat = await this.saleCategoryResolver(
      (invoices as any[]).flatMap((inv) => (inv.items ?? []) as SaleCategoryLine[]),
    );
    const needle = itemSearch?.trim().toLowerCase() || null;

    type Row = {
      periodKey: string; periodLabel: string;
      serverId: string | null; serverName: string;
      item: string; categoryName: string | null;
      quantity: Money; gross: Money; discount: Money; net: Money;
      orderIds: Set<string>;
    };
    const rows = new Map<string, Row>();
    // Per-server roll-up so the caller can render a summary strip without
    // re-aggregating the (much longer) item rows client-side and drifting.
    const servers = new Map<string, { serverId: string | null; serverName: string; quantity: Money; gross: Money; items: Set<string>; orderIds: Set<string> }>();

    for (const inv of invoices as any[]) {
      const when = new Date(inv.issueDate ?? inv.createdAt);
      const periodKey = groupBy === 'none' ? 'all' : groupBy === 'day' ? localIso(when) : (inv.cashSessionId ?? 'no-shift');
      const periodLabel = groupBy === 'none'
        ? 'All'
        : groupBy === 'day'
          ? localIso(when)
          : (inv.cashSessionId ? (sessionLabel.get(inv.cashSessionId) ?? inv.cashSessionId) : 'No shift');

      for (const it of inv.items ?? []) {
        const c = cat.resolve(it);
        if (categoryId && !this.matchesCategory(c, categoryId)) continue;
        if (needle && !String(it.description ?? '').toLowerCase().includes(needle)) continue;

        const serverId: string | null = it.punchedById ?? inv.waiterId ?? null;
        const serverName = it.punchedByName
          ?? (serverId ? (staffName.get(serverId) ?? null) : null)
          ?? 'Unattributed';

        const gross = dec(it.unitPrice).times(dec(it.quantity));
        const discount = it.discountType === 'fixed_amount'
          ? dec(it.discountAmount ?? 0)
          : gross.times(dec(it.discountPercent ?? 0)).div(100);

        const key = `${periodKey}|${serverId ?? '-'}|${it.description}`;
        const cur = rows.get(key) ?? {
          periodKey, periodLabel, serverId, serverName,
          item: it.description, categoryName: c.name,
          quantity: dec(0), gross: dec(0), discount: dec(0), net: dec(0),
          orderIds: new Set<string>(),
        };
        cur.quantity = cur.quantity.plus(dec(it.quantity));
        cur.gross = cur.gross.plus(gross);
        cur.discount = cur.discount.plus(discount);
        cur.net = cur.net.plus(dec(it.total));
        cur.orderIds.add(inv.id);
        rows.set(key, cur);

        const sKey = serverId ?? '-';
        const sCur = servers.get(sKey) ?? { serverId, serverName, quantity: dec(0), gross: dec(0), items: new Set<string>(), orderIds: new Set<string>() };
        sCur.quantity = sCur.quantity.plus(dec(it.quantity));
        sCur.gross = sCur.gross.plus(dec(it.total));
        sCur.items.add(it.description);
        sCur.orderIds.add(inv.id);
        servers.set(sKey, sCur);
      }
    }

    const out = Array.from(rows.values())
      .sort((a, b) =>
        a.periodKey.localeCompare(b.periodKey) ||
        a.serverName.localeCompare(b.serverName) ||
        Number(b.net.minus(a.net)))
      .map((r) => ({
        periodKey: r.periodKey,
        periodLabel: r.periodLabel,
        serverId: r.serverId,
        serverName: r.serverName,
        item: r.item,
        categoryName: r.categoryName,
        quantity: r.quantity.toFixed(2),
        grossAmount: r.gross.toFixed(2),
        discountAmount: r.discount.toFixed(2),
        totalAmount: r.net.toFixed(2),
        orderCount: r.orderIds.size,
      }));

    return {
      groupBy,
      rows: out,
      servers: Array.from(servers.values())
        .sort((a, b) => Number(b.gross.minus(a.gross)))
        .map((v) => ({
          serverId: v.serverId,
          serverName: v.serverName,
          quantity: v.quantity.toFixed(2),
          totalAmount: v.gross.toFixed(2),
          distinctItems: v.items.size,
          orderCount: v.orderIds.size,
        })),
    };
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

      // One category rule for every item report — see `saleCategoryResolver`.
      const cat = await this.saleCategoryResolver(
        (invoices as any[]).flatMap((inv) => (inv.items ?? []) as SaleCategoryLine[]),
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
          const c = cat.resolve(it);
          const groupId = c.key;
          const groupName = c.name;

          if (categoryId && !this.matchesCategory(c, categoryId)) continue;

          // Bucket on the TYPED key so a MenuCategory and a ProductCategory can
          // never collide, and so "Uncategorised" and "Legacy unresolved" stay
          // separate lines instead of one misleading total.
          const key = c.key ?? c.name;
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

      const waiterIds = new Set<string>();
      for (const inv of invoices as any[]) {
        if (inv.waiterId) waiterIds.add(inv.waiterId);
      }

      // One category rule for every item report — see `saleCategoryResolver`.
      const [waiters, cat] = await Promise.all([
        waiterIds.size
          ? this.prisma.client.user.findMany({
              where: { id: { in: Array.from(waiterIds) } },
              select: { id: true, firstName: true, lastName: true },
            })
          : Promise.resolve([] as any[]),
        this.saleCategoryResolver((invoices as any[]).flatMap((inv) => (inv.items ?? []) as SaleCategoryLine[])),
      ]);

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
          // The grouping key is the sale IDENTITY: a menu item and a product
          // are different things even when one is made from the other, so they
          // stay separate rows rather than being merged on a guess.
          const key = it.menuItemId ?? it.productId ?? `desc:${it.description}`;
          const name =
            (it.menuItemId ? cat.menuItemName(it.menuItemId) : it.productId ? cat.productName(it.productId) : null) ??
            it.description;

          // The bridge is no longer gated on `!it.menuItemId` — the resolver
          // falls through on a NULL CATEGORY, so a menu item with no
          // MenuCategory still reaches the product and the legacy bridge.
          const c = cat.resolve(it);
          const catId = c.key;
          const catName = c.name;

          itemOptions.set(key, name);
          if (catId) categoryOptions.set(catId, catName);

          if (itemKey && key !== itemKey) continue;
          if (categoryId && !this.matchesCategory(c, categoryId)) continue;
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
