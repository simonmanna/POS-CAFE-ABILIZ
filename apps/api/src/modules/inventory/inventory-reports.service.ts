import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { InventoryQueryService } from './inventory-query.service';

/**
 * Advanced inventory reports (the /inventory/reports page).
 *
 * Ground rules every report here follows:
 *  - Date filters are LOCAL calendar days: "To 2026-09-14" covers the whole of
 *    local 14 Sep. `new Date('YYYY-MM-DD')` is UTC midnight and silently shifts
 *    the window by the server's offset, which is what the old report did.
 *  - `InventoryLedger.totalValue` is UNSIGNED (|qty| × unitCost). Direction comes
 *    from the sign of `quantityChange`, so inbound and outbound value are always
 *    reported separately — never summed into one meaningless "movement value".
 *  - Closing/opening balances ignore the move-type filter: a balance is the true
 *    stock position, the type filter only narrows the in/out columns.
 *  - A category filter includes its sub-categories.
 */

export interface ReportScopeQuery {
  start?: string;
  end?: string;
  locationId?: string;
  productId?: string;
  categoryId?: string;
  search?: string;
  /** Comma-separated StockMoveType list. */
  moveTypes?: string;
}

export const MOVE_TYPE_GROUPS: Record<string, string> = {
  receipt: 'received',
  return_in: 'received',
  production_output: 'received',
  opening_balance: 'received',
  issue: 'consumed',
  production_consume: 'consumed',
  adjustment_in: 'adjusted',
  adjustment_out: 'adjusted',
  transfer_in: 'transferred',
  transfer_out: 'transferred',
  waste: 'lost',
  expiry_write_off: 'lost',
  internal_use: 'lost',
  promo_sample: 'lost',
  return_to_supplier: 'returned',
};

const VALID_MOVE_TYPES = new Set(Object.keys(MOVE_TYPE_GROUPS));
const STOCK_STATUSES = new Set(['all', 'in_stock', 'low', 'out', 'negative', 'below_par']);

/** Local start/end instant of a YYYY-MM-DD day (offset-agnostic). */
export function parseLocalDay(value: string | undefined, edge: 'start' | 'end'): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${value}`);
  return edge === 'start'
    ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
    : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const n = (v: Prisma.Decimal | number | string | null | undefined) => Number(v ?? 0);
const round = (v: number, dp = 6) => Math.round(v * 10 ** dp) / 10 ** dp;

@Injectable()
export class InventoryReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly queries: InventoryQueryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Shared scope helpers
  // ---------------------------------------------------------------------------

  private range(q: ReportScopeQuery) {
    let start = parseLocalDay(q.start, 'start');
    let end = parseLocalDay(q.end, 'end');
    if (start && end && start > end) {
      // A reversed range is a UI slip — report the same days the other way round.
      const s = localIso(end);
      const e = localIso(start);
      start = parseLocalDay(s, 'start');
      end = parseLocalDay(e, 'end');
    }
    return { start, end };
  }

  private moveTypes(q: ReportScopeQuery): string[] | undefined {
    if (!q.moveTypes) return undefined;
    const list = q.moveTypes.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((t) => !VALID_MOVE_TYPES.has(t));
    if (bad.length) throw new BadRequestException(`Unknown move type(s): ${bad.join(', ')}`);
    return list.length ? list : undefined;
  }

  /** Category id plus every descendant id. */
  private async categoryTree(categoryId: string): Promise<string[]> {
    const all = await this.prisma.client.productCategory.findMany({
      where: { organizationId: this.tenant.organizationId },
      select: { id: true, parentId: true },
    });
    const children = new Map<string, string[]>();
    for (const c of all) {
      if (!c.parentId) continue;
      children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id]);
    }
    const out: string[] = [];
    const stack = [categoryId];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.includes(id)) continue;
      out.push(id);
      stack.push(...(children.get(id) ?? []));
    }
    return out;
  }

  /** Product-level `where` for category / search / single product filters. */
  private async productWhere(q: ReportScopeQuery): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = { organizationId: this.tenant.organizationId };
    if (q.productId) where.id = q.productId;
    if (q.categoryId) where.categoryId = { in: await this.categoryTree(q.categoryId) };
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { barcode: { contains: search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** Product ids in scope, or undefined when no product-level filter is set. */
  private async scopedProductIds(q: ReportScopeQuery): Promise<string[] | undefined> {
    if (!q.productId && !q.categoryId && !q.search?.trim()) return undefined;
    const rows = await this.prisma.client.product.findMany({ where: await this.productWhere(q), select: { id: true } });
    return rows.map((r) => r.id);
  }

  private productMeta(ids: string[]) {
    return ids.length
      ? this.prisma.client.product.findMany({
          where: { id: { in: ids } },
          select: {
            id: true, code: true, name: true, sku: true, costPrice: true, minQuantity: true,
            uom: { select: { code: true } },
            category: { select: { id: true, name: true } },
          },
        })
      : Promise.resolve([]);
  }

  // ---------------------------------------------------------------------------
  // 1. Item movement summary (stock card summary)
  // ---------------------------------------------------------------------------

  async itemMovements(q: ReportScopeQuery & { includeIdle?: string; excludeTransfers?: string }) {
    const organizationId = this.tenant.organizationId;
    const { start, end } = this.range(q);
    const types = this.moveTypes(q);
    const productIds = await this.scopedProductIds(q);
    const excludeTransfers = q.excludeTransfers === 'true';
    const endsToday = !end || end.getTime() >= parseLocalDay(localIso(new Date()), 'start')!.getTime();

    const base: Prisma.InventoryLedgerWhereInput = { organizationId };
    if (q.locationId) base.locationId = q.locationId;
    if (productIds) base.productId = { in: productIds };

    const windowWhere: Prisma.InventoryLedgerWhereInput = { ...base };
    if (start || end) windowWhere.createdAt = { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) };
    const typeFilter = [
      ...(types ? [{ type: { in: types as any } }] : []),
      ...(excludeTransfers ? [{ type: { notIn: ['transfer_in', 'transfer_out'] as any } }] : []),
    ];
    if (typeFilter.length) windowWhere.AND = typeFilter;

    const [typed, openingG, closingG] = await Promise.all([
      this.prisma.client.inventoryLedger.groupBy({
        by: ['productId', 'type'],
        where: windowWhere,
        _sum: { quantityChange: true, totalValue: true },
        _count: { _all: true },
      }),
      start
        ? this.prisma.client.inventoryLedger.groupBy({
            by: ['productId'],
            where: { ...base, createdAt: { lt: start } },
            _sum: { quantityChange: true },
          })
        : Promise.resolve([] as any[]),
      this.prisma.client.inventoryLedger.groupBy({
        by: ['productId'],
        where: { ...base, ...(end ? { createdAt: { lte: end } } : {}) },
        _sum: { quantityChange: true },
      }),
    ]);

    let universe = new Set<string>([
      ...typed.map((g) => g.productId),
      ...openingG.filter((g: any) => n(g._sum.quantityChange) !== 0).map((g: any) => g.productId as string),
      ...closingG.filter((g) => n(g._sum.quantityChange) !== 0).map((g) => g.productId),
    ]);
    if (q.includeIdle === 'true') {
      const idle = await this.prisma.client.product.findMany({
        where: { ...(await this.productWhere(q)), trackInventory: true },
        select: { id: true },
      });
      idle.forEach((p) => universe.add(p.id));
    }
    // With a type filter, only items that actually had such a movement matter.
    if (types) universe = new Set(typed.map((g) => g.productId));

    const ids = [...universe];
    const [products, stockItems] = await Promise.all([
      this.productMeta(ids),
      ids.length
        ? this.prisma.client.stockItem.findMany({
            where: { organizationId, productId: { in: ids }, ...(q.locationId ? { locationId: q.locationId } : {}) },
            select: { productId: true, quantity: true, runningAverageCost: true },
          })
        : Promise.resolve([]),
    ]);

    const openingById = new Map(openingG.map((g: any) => [g.productId as string, n(g._sum.quantityChange)]));
    const closingById = new Map(closingG.map((g) => [g.productId, n(g._sum.quantityChange)]));

    // Weighted average cost over the scoped locations (positive quants only).
    const costAgg = new Map<string, { qty: number; value: number }>();
    const onHandById = new Map<string, number>();
    for (const si of stockItems) {
      const qty = n(si.quantity);
      onHandById.set(si.productId, (onHandById.get(si.productId) ?? 0) + qty);
      if (qty <= 0) continue;
      const a = costAgg.get(si.productId) ?? { qty: 0, value: 0 };
      a.qty += qty;
      a.value += qty * n(si.runningAverageCost);
      costAgg.set(si.productId, a);
    }

    type Agg = { qtyIn: number; qtyOut: number; valueIn: number; valueOut: number; count: number; byType: Record<string, number> };
    const aggById = new Map<string, Agg>();
    for (const g of typed) {
      const a = aggById.get(g.productId) ?? { qtyIn: 0, qtyOut: 0, valueIn: 0, valueOut: 0, count: 0, byType: {} };
      const qty = n(g._sum.quantityChange);
      const val = n(g._sum.totalValue);
      if (qty >= 0) { a.qtyIn += qty; a.valueIn += val; } else { a.qtyOut += -qty; a.valueOut += val; }
      a.count += g._count._all;
      a.byType[g.type] = round((a.byType[g.type] ?? 0) + qty);
      aggById.set(g.productId, a);
    }

    const rows = products.map((p) => {
      const a = aggById.get(p.id) ?? { qtyIn: 0, qtyOut: 0, valueIn: 0, valueOut: 0, count: 0, byType: {} };
      const c = costAgg.get(p.id);
      const avgCost = c && c.qty > 0 ? c.value / c.qty : n(p.costPrice);
      const openingQty = round(openingById.get(p.id) ?? 0);
      const closingQty = round(closingById.get(p.id) ?? 0);
      const groups: Record<string, number> = {};
      for (const [t, qty] of Object.entries(a.byType)) {
        const grp = MOVE_TYPE_GROUPS[t] ?? 'other';
        groups[grp] = round((groups[grp] ?? 0) + qty);
      }
      return {
        productId: p.id,
        code: p.code,
        name: p.name,
        sku: p.sku,
        categoryId: p.category?.id ?? null,
        category: p.category?.name ?? null,
        uom: p.uom?.code ?? null,
        openingQty,
        qtyIn: round(a.qtyIn),
        qtyOut: round(a.qtyOut),
        netQty: round(a.qtyIn - a.qtyOut),
        closingQty,
        // Kept for older clients: `balance` == closing position.
        balance: closingQty,
        valueIn: round(a.valueIn, 2),
        valueOut: round(a.valueOut, 2),
        avgCost: round(avgCost, 4),
        closingValue: round(closingQty * avgCost, 2),
        movements: a.count,
        byType: a.byType,
        byGroup: groups,
        minQuantity: p.minQuantity != null ? n(p.minQuantity) : null,
        // Cached on-hand today. When the window runs to today the ledger closing
        // must equal it; a difference means a movement bypassed the ledger.
        currentOnHand: round(onHandById.get(p.id) ?? 0),
        ledgerDrift: endsToday ? round((onHandById.get(p.id) ?? 0) - closingQty) : null,
      };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const totals = rows.reduce(
      (t, r) => {
        t.openingQty += r.openingQty; t.qtyIn += r.qtyIn; t.qtyOut += r.qtyOut; t.netQty += r.netQty;
        t.closingQty += r.closingQty; t.valueIn += r.valueIn; t.valueOut += r.valueOut;
        t.closingValue += r.closingValue; t.movements += r.movements;
        return t;
      },
      { items: rows.length, openingQty: 0, qtyIn: 0, qtyOut: 0, netQty: 0, closingQty: 0, valueIn: 0, valueOut: 0, closingValue: 0, movements: 0, driftItems: 0 },
    );
    totals.driftItems = rows.filter((r) => r.ledgerDrift != null && Math.abs(r.ledgerDrift) > 0.000001).length;
    for (const k of ['openingQty', 'qtyIn', 'qtyOut', 'netQty', 'closingQty'] as const) totals[k] = round(totals[k]);
    for (const k of ['valueIn', 'valueOut', 'closingValue'] as const) totals[k] = round(totals[k], 2);

    return {
      data: rows,
      totals,
      meta: { start: start ? localIso(start) : null, end: end ? localIso(end) : null, total: rows.length },
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Stock valuation (current on-hand)
  // ---------------------------------------------------------------------------

  async valuation(q: ReportScopeQuery & { status?: string; includeZero?: string }) {
    const organizationId = this.tenant.organizationId;
    const status = q.status || 'all';
    if (!STOCK_STATUSES.has(status)) throw new BadRequestException(`Unknown status: ${status}`);

    const products = await this.prisma.client.product.findMany({
      // Products flagged trackInventory=false can still hold quants (sold before
      // the flag flipped) — they carry real value, so anything with stock counts.
      where: {
        AND: [
          await this.productWhere(q),
          { OR: [{ trackInventory: true }, { stockItems: { some: q.locationId ? { locationId: q.locationId } : {} } }] },
        ],
      },
      select: {
        id: true, code: true, name: true, sku: true, costPrice: true, salesPrice: true,
        minQuantity: true, reorderQty: true, isActive: true,
        uom: { select: { code: true } },
        category: { select: { id: true, name: true } },
        stockItems: {
          where: q.locationId ? { locationId: q.locationId } : {},
          select: {
            quantity: true, runningAverageCost: true, updatedAt: true,
            location: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const rows = products.map((p) => {
      let qty = 0; let value = 0; let posQty = 0; let posValue = 0;
      let lastMovedAt: Date | null = null;
      const byLoc = new Map<string, { locationId: string; code: string; name: string; quantity: number; value: number }>();
      for (const si of p.stockItems) {
        const sq = n(si.quantity);
        const cost = n(si.runningAverageCost) || n(p.costPrice);
        qty += sq;
        value += sq * cost;
        if (sq > 0) { posQty += sq; posValue += sq * cost; }
        if (!lastMovedAt || si.updatedAt > lastMovedAt) lastMovedAt = si.updatedAt;
        const l = byLoc.get(si.location.id) ?? { locationId: si.location.id, code: si.location.code, name: si.location.name, quantity: 0, value: 0 };
        l.quantity = round(l.quantity + sq);
        l.value = round(l.value + sq * cost, 2);
        byLoc.set(si.location.id, l);
      }
      const avgCost = posQty > 0 ? posValue / posQty : n(p.costPrice);
      const min = n(p.minQuantity);
      const stockStatus = qty < 0 ? 'negative' : qty === 0 ? 'out' : min > 0 && qty <= min ? 'low' : 'in_stock';
      const salesPrice = n(p.salesPrice);
      return {
        productId: p.id,
        code: p.code,
        name: p.name,
        sku: p.sku,
        isActive: p.isActive,
        categoryId: p.category?.id ?? null,
        category: p.category?.name ?? null,
        uom: p.uom?.code ?? null,
        quantity: round(qty),
        avgCost: round(avgCost, 4),
        value: round(value, 2),
        salesPrice,
        retailValue: round(qty * salesPrice, 2),
        minQuantity: min || null,
        reorderQty: p.reorderQty != null ? n(p.reorderQty) : null,
        stockStatus,
        lastMovedAt,
        locations: [...byLoc.values()].filter((l) => l.quantity !== 0),
      };
    });

    const filtered = rows.filter((r) => {
      if (status === 'all') return q.includeZero === 'true' || r.quantity !== 0;
      if (status === 'below_par') return r.minQuantity != null && r.quantity <= r.minQuantity;
      return r.stockStatus === status;
    });

    const totalValue = filtered.reduce((s, r) => s + r.value, 0);
    const byCategory = new Map<string, { category: string; items: number; quantity: number; value: number }>();
    for (const r of filtered) {
      const key = r.category ?? 'Uncategorised';
      const c = byCategory.get(key) ?? { category: key, items: 0, quantity: 0, value: 0 };
      c.items += 1; c.quantity = round(c.quantity + r.quantity); c.value = round(c.value + r.value, 2);
      byCategory.set(key, c);
    }

    return {
      data: filtered,
      totals: {
        items: filtered.length,
        quantity: round(filtered.reduce((s, r) => s + r.quantity, 0)),
        value: round(totalValue, 2),
        retailValue: round(filtered.reduce((s, r) => s + r.retailValue, 0), 2),
        inStock: rows.filter((r) => r.stockStatus === 'in_stock').length,
        low: rows.filter((r) => r.stockStatus === 'low').length,
        out: rows.filter((r) => r.stockStatus === 'out').length,
        negative: rows.filter((r) => r.stockStatus === 'negative').length,
      },
      byCategory: [...byCategory.values()]
        .map((c) => ({ ...c, share: totalValue ? round((c.value / totalValue) * 100, 1) : 0 }))
        .sort((a, b) => b.value - a.value),
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Movement analysis (by type, daily trend, top items)
  // ---------------------------------------------------------------------------

  async movementAnalysis(q: ReportScopeQuery) {
    const organizationId = this.tenant.organizationId;
    const { start, end } = this.range(q);
    const types = this.moveTypes(q);
    const productIds = await this.scopedProductIds(q);

    // Default to the last 30 days — the trend is unreadable over all history.
    const effEnd = end ?? parseLocalDay(localIso(new Date()), 'end')!;
    const effStart = start ?? (() => {
      const d = new Date(effEnd); d.setDate(d.getDate() - 29); return parseLocalDay(localIso(d), 'start')!;
    })();
    if (effEnd.getTime() - effStart.getTime() > 400 * 86_400_000) {
      throw new BadRequestException('Movement analysis is limited to a 400-day window');
    }

    const where: Prisma.InventoryLedgerWhereInput = {
      organizationId,
      createdAt: { gte: effStart, lte: effEnd },
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(productIds ? { productId: { in: productIds } } : {}),
      ...(types ? { type: { in: types as any } } : {}),
    };

    const [byTypeG, byProductTypeG, lines] = await Promise.all([
      this.prisma.client.inventoryLedger.groupBy({
        by: ['type'],
        where,
        _sum: { quantityChange: true, totalValue: true },
        _count: { _all: true },
      }),
      this.prisma.client.inventoryLedger.groupBy({
        by: ['productId', 'type'],
        where,
        _sum: { quantityChange: true, totalValue: true },
      }),
      this.prisma.client.inventoryLedger.findMany({
        where,
        select: { createdAt: true, quantityChange: true, totalValue: true },
      }),
    ]);

    const byType = byTypeG
      .map((g) => ({
        type: g.type,
        group: MOVE_TYPE_GROUPS[g.type] ?? 'other',
        movements: g._count._all,
        quantity: round(n(g._sum.quantityChange)),
        value: round(n(g._sum.totalValue), 2),
        direction: n(g._sum.quantityChange) >= 0 ? 'in' : 'out',
      }))
      .sort((a, b) => b.value - a.value);

    // Daily trend, bucketed by LOCAL day, every day in the window present.
    const days = new Map<string, { date: string; valueIn: number; valueOut: number; qtyIn: number; qtyOut: number; movements: number }>();
    for (let d = new Date(effStart); d <= effEnd; d.setDate(d.getDate() + 1)) {
      const k = localIso(d);
      days.set(k, { date: k, valueIn: 0, valueOut: 0, qtyIn: 0, qtyOut: 0, movements: 0 });
    }
    for (const l of lines) {
      const b = days.get(localIso(l.createdAt));
      if (!b) continue;
      const qty = n(l.quantityChange);
      const val = n(l.totalValue);
      if (qty >= 0) { b.qtyIn += qty; b.valueIn += val; } else { b.qtyOut += -qty; b.valueOut += val; }
      b.movements += 1;
    }
    const trend = [...days.values()].map((d) => ({
      ...d, valueIn: round(d.valueIn, 2), valueOut: round(d.valueOut, 2), qtyIn: round(d.qtyIn), qtyOut: round(d.qtyOut),
    }));

    const perProduct = new Map<string, { consumed: number; lost: number; received: number; consumedQty: number; lostQty: number }>();
    for (const g of byProductTypeG) {
      const grp = MOVE_TYPE_GROUPS[g.type];
      const p = perProduct.get(g.productId) ?? { consumed: 0, lost: 0, received: 0, consumedQty: 0, lostQty: 0 };
      const val = n(g._sum.totalValue);
      const qty = Math.abs(n(g._sum.quantityChange));
      if (grp === 'consumed') { p.consumed += val; p.consumedQty += qty; }
      if (grp === 'lost') { p.lost += val; p.lostQty += qty; }
      if (grp === 'received') p.received += val;
      perProduct.set(g.productId, p);
    }
    const meta = new Map((await this.productMeta([...perProduct.keys()])).map((p) => [p.id, p]));
    const top = (key: 'consumed' | 'lost' | 'received', qtyKey?: 'consumedQty' | 'lostQty') =>
      [...perProduct.entries()]
        .filter(([, v]) => v[key] > 0)
        .sort((a, b) => b[1][key] - a[1][key])
        .slice(0, 10)
        .map(([id, v]) => ({
          productId: id,
          code: meta.get(id)?.code ?? null,
          name: meta.get(id)?.name ?? id,
          uom: meta.get(id)?.uom?.code ?? null,
          value: round(v[key], 2),
          quantity: qtyKey ? round(v[qtyKey]) : null,
        }));

    const sum = (dir: 'in' | 'out') => byType.filter((t) => t.direction === dir);
    const lost = byType.filter((t) => t.group === 'lost');
    const consumed = byType.filter((t) => t.group === 'consumed');
    return {
      range: { start: localIso(effStart), end: localIso(effEnd) },
      summary: {
        movements: byType.reduce((s, t) => s + t.movements, 0),
        valueIn: round(sum('in').reduce((s, t) => s + t.value, 0), 2),
        valueOut: round(sum('out').reduce((s, t) => s + t.value, 0), 2),
        consumedValue: round(consumed.reduce((s, t) => s + t.value, 0), 2),
        lostValue: round(lost.reduce((s, t) => s + t.value, 0), 2),
        lossRatePct: (() => {
          const c = consumed.reduce((s, t) => s + t.value, 0);
          const l = lost.reduce((s, t) => s + t.value, 0);
          // Undefined (not 100%) when consumption carried no cost — e.g. sales issued at zero cost.
          return c > 0 ? round((l / (c + l)) * 100, 1) : null;
        })(),
      },
      byType,
      trend,
      topConsumed: top('consumed', 'consumedQty'),
      topLost: top('lost', 'lostQty'),
      topReceived: top('received'),
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Exceptions — reorder / expiring / negative, with category & search scope
  // ---------------------------------------------------------------------------

  async reorder(q: ReportScopeQuery) {
    const [rows, ids] = await Promise.all([
      this.queries.getReorderSuggestions({ locationId: q.locationId }),
      this.scopedProductIds(q),
    ]);
    const scoped = ids ? rows.filter((r) => ids.includes(r.productId)) : rows;
    const meta = new Map((await this.productMeta(scoped.map((r) => r.productId))).map((p) => [p.id, p]));
    return scoped
      .map((r) => {
        const p = meta.get(r.productId);
        const unitCost = n(p?.costPrice);
        return {
          ...r,
          shortfall: round(Math.max(0, r.par - r.onHand)),
          category: p?.category?.name ?? null,
          uom: p?.uom?.code ?? null,
          unitCost,
          estimatedCost: round(r.suggestedOrderQty * unitCost, 2),
        };
      })
      .sort((a, b) => b.shortfall - a.shortfall);
  }

  async expiring(q: ReportScopeQuery & { days?: string }) {
    const [rows, ids] = await Promise.all([
      this.queries.getExpiringBatches({ days: q.days, locationId: q.locationId }),
      this.scopedProductIds(q),
    ]);
    return (ids ? rows.filter((r) => ids.includes(r.productId)) : rows).map((b: any) => ({
      id: b.id,
      batchNumber: b.batchNumber,
      productId: b.productId,
      code: b.product?.code ?? null,
      name: b.product?.name ?? null,
      uom: b.product?.uom?.code ?? null,
      location: b.location?.name ?? null,
      quantity: n(b.quantity),
      unitCost: n(b.unitCost),
      value: round(n(b.quantity) * n(b.unitCost), 2),
      expiryDate: b.expiryDate,
      daysToExpiry: b.daysToExpiry,
      expired: b.expired,
    }));
  }

  async negativeStock(q: ReportScopeQuery) {
    const [res, ids] = await Promise.all([
      this.queries.getNegativeStock({ locationId: q.locationId }),
      this.scopedProductIds(q),
    ]);
    if (!ids) return res;
    const rows = res.rows.filter((r) => ids.includes(r.productId));
    return {
      summary: {
        cells: rows.length,
        clean: rows.length === 0,
        totalValuationExposure: rows.reduce((s, r) => s.plus(r.valuationExposure), new Prisma.Decimal(0)).toString(),
        zeroCostBasisCells: rows.filter((r) => r.zeroCostBasis).length,
      },
      rows,
    };
  }

  // ---------------------------------------------------------------------------
  // 7. Stock health — aging, turnover, slow-moving and dead stock (INV-P2-04)
  // ---------------------------------------------------------------------------

  /**
   * One row per quant with stock on hand:
   *  - aging buckets: on-hand is attributed to the most recent inbound movements
   *    (receipts, returns, production output, transfers in, opening balances)
   *    at that location — FIFO consumption leaves the newest layers on the shelf —
   *    and bucketed by the age of those layers;
   *  - turnover over [start, end] (default: last 90 days): consumed qty (sales,
   *    recipe/production consumption) ÷ average on-hand, plus days of cover;
   *  - status: dead (no consumption for `deadDays`, default 180), slow (none for
   *    `slowDays`, default 90) or active.
   * Computed in SQL bounded by org + location + product scope (capped at 5,000
   * quants); the inbound window is served by the (org, product, location,
   * createdAt) ledger index.
   */
  async stockHealth(q: ReportScopeQuery & { slowDays?: string; deadDays?: string; status?: string }) {
    const org = this.tenant.organizationId;
    const now = new Date();
    const slowDays = Math.max(1, Math.min(3650, Number(q.slowDays ?? 90) || 90));
    const deadDays = Math.max(slowDays, Math.min(3650, Number(q.deadDays ?? 180) || 180));
    const range = this.range(q);
    const end = range.end ?? now;
    const start = range.start ?? new Date(end.getTime() - 90 * 86_400_000);
    const periodDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
    const ids = await this.scopedProductIds(q);
    if (ids && ids.length === 0) return { summary: this.emptyHealthSummary(slowDays, deadDays, start, end), rows: [] };

    const params: unknown[] = [org, start, end];
    let scope = '';
    if (q.locationId) {
      params.push(q.locationId);
      scope += ` AND si."locationId" = $${params.length}`;
    }
    if (ids) {
      params.push(ids);
      scope += ` AND si."productId" = ANY($${params.length}::text[])`;
    }

    const rows: any[] = await this.prisma.raw.$queryRawUnsafe(
      `
      WITH quant AS (
        SELECT si."productId", si."variantId", si."variantKey", si."locationId", si.quantity AS on_hand, si."runningAverageCost" AS avg_cost
          FROM "StockItem" si
          JOIN "InventoryLocation" loc ON loc.id = si."locationId"
         WHERE si."organizationId" = $1 AND si.quantity > 0 AND loc.type <> 'transit' ${scope}
      ),
      inbound AS (
        SELECT l."productId", COALESCE(l."variantId", '') AS vkey, l."locationId", l."createdAt", l."quantityChange" AS q,
               SUM(l."quantityChange") OVER (
                 PARTITION BY l."productId", COALESCE(l."variantId", ''), l."locationId"
                 ORDER BY l."createdAt" DESC, l.id DESC
               ) AS cum
          FROM "InventoryLedger" l
          JOIN quant qt ON qt."productId" = l."productId" AND qt."variantKey" = COALESCE(l."variantId", '') AND qt."locationId" = l."locationId"
         WHERE l."organizationId" = $1 AND l."quantityChange" > 0
           AND l.type IN ('receipt', 'return_in', 'production_output', 'transfer_in', 'opening_balance', 'adjustment_in', 'reversal_in')
      ),
      layers AS (
        SELECT i."productId", i.vkey, i."locationId",
               GREATEST(LEAST(i.q, qt.on_hand - (i.cum - i.q)), 0) AS layer_qty,
               EXTRACT(EPOCH FROM (now() - i."createdAt")) / 86400 AS age_days
          FROM inbound i
          JOIN quant qt ON qt."productId" = i."productId" AND qt."variantKey" = i.vkey AND qt."locationId" = i."locationId"
         WHERE i.cum - i.q < qt.on_hand
      ),
      aging AS (
        SELECT "productId", vkey, "locationId",
               SUM(layer_qty) FILTER (WHERE age_days <= 30)                    AS b0_30,
               SUM(layer_qty) FILTER (WHERE age_days > 30 AND age_days <= 60)  AS b31_60,
               SUM(layer_qty) FILTER (WHERE age_days > 60 AND age_days <= 90)  AS b61_90,
               SUM(layer_qty) FILTER (WHERE age_days > 90 AND age_days <= 180) AS b91_180,
               SUM(layer_qty) FILTER (WHERE age_days > 180)                    AS b180_plus,
               SUM(layer_qty * age_days) / NULLIF(SUM(layer_qty), 0)           AS weighted_age
          FROM layers GROUP BY "productId", vkey, "locationId"
      ),
      moves AS (
        SELECT l."productId", COALESCE(l."variantId", '') AS vkey, l."locationId",
               MAX(l."createdAt") FILTER (WHERE l."quantityChange" < 0 AND l.type IN ('issue', 'production_consume')) AS last_consumed_at,
               MAX(l."createdAt") FILTER (WHERE l."quantityChange" > 0 AND l.type IN ('receipt', 'return_in', 'production_output', 'transfer_in', 'opening_balance')) AS last_inbound_at,
               COALESCE(SUM(-l."quantityChange") FILTER (WHERE l."quantityChange" < 0 AND l.type IN ('issue', 'production_consume') AND l."createdAt" BETWEEN $2 AND $3), 0) AS consumed_qty,
               COALESCE(SUM(l."totalValue") FILTER (WHERE l."quantityChange" < 0 AND l.type IN ('issue', 'production_consume') AND l."createdAt" BETWEEN $2 AND $3), 0) AS consumed_value,
               COALESCE(SUM(l."quantityChange") FILTER (WHERE l."createdAt" > $2), 0) AS net_since_start,
               COALESCE(SUM(l."quantityChange") FILTER (WHERE l."createdAt" > $3), 0) AS net_since_end
          FROM "InventoryLedger" l
          JOIN quant qt ON qt."productId" = l."productId" AND qt."variantKey" = COALESCE(l."variantId", '') AND qt."locationId" = l."locationId"
         WHERE l."organizationId" = $1
         GROUP BY l."productId", COALESCE(l."variantId", ''), l."locationId"
      ),
      lots AS (
        SELECT b."productId", COALESCE(b."variantId", '') AS vkey, b."locationId", SUM(b.quantity * COALESCE(b."unitCost", 0)) AS lot_value
          FROM "InventoryBatch" b
          JOIN quant qt ON qt."productId" = b."productId" AND qt."variantKey" = COALESCE(b."variantId", '') AND qt."locationId" = b."locationId"
         WHERE b."organizationId" = $1 AND b."isActive" = true AND b.quantity > 0
         GROUP BY b."productId", COALESCE(b."variantId", ''), b."locationId"
      )
      SELECT qt."productId", qt."variantId", qt."locationId", loc.name AS location_name,
             p.code, p.name, p."batchTracking", p."costingMethod", p."costPrice", u.code AS uom, c.name AS category,
             qt.on_hand, qt.avg_cost, lots.lot_value,
             a.b0_30, a.b31_60, a.b61_90, a.b91_180, a.b180_plus, a.weighted_age,
             m.last_consumed_at, m.last_inbound_at, m.consumed_qty, m.consumed_value, m.net_since_start, m.net_since_end
        FROM quant qt
        JOIN "Product" p ON p.id = qt."productId"
        JOIN "InventoryLocation" loc ON loc.id = qt."locationId"
        LEFT JOIN "UnitOfMeasure" u ON u.id = p."uomId"
        LEFT JOIN "ProductCategory" c ON c.id = p."categoryId"
        LEFT JOIN aging a ON a."productId" = qt."productId" AND a.vkey = qt."variantKey" AND a."locationId" = qt."locationId"
        LEFT JOIN moves m ON m."productId" = qt."productId" AND m.vkey = qt."variantKey" AND m."locationId" = qt."locationId"
        LEFT JOIN lots ON lots."productId" = qt."productId" AND lots.vkey = qt."variantKey" AND lots."locationId" = qt."locationId"
       ORDER BY p.name ASC, loc.name ASC
       LIMIT 5000
      `,
      ...params,
    );

    const dayMs = 86_400_000;
    const out = rows.map((r) => {
      const onHand = n(r.on_hand);
      const unit =
        r.batchTracking || r.costingMethod === 'FIFO'
          ? onHand > 0 ? n(r.lot_value) / onHand : 0
          : r.costingMethod === 'STANDARD' ? n(r.costPrice) : n(r.avg_cost);
      const value = round(onHand * unit, 2);
      const consumedQty = n(r.consumed_qty);
      const closingQty = onHand - n(r.net_since_end);
      const openingQty = onHand - n(r.net_since_start);
      const avgQty = (Math.max(openingQty, 0) + Math.max(closingQty, 0)) / 2;
      const lastConsumed: Date | null = r.last_consumed_at ? new Date(r.last_consumed_at) : null;
      const daysSinceConsumed = lastConsumed ? Math.floor((now.getTime() - lastConsumed.getTime()) / dayMs) : null;
      const status =
        daysSinceConsumed == null || daysSinceConsumed > deadDays ? 'dead' : daysSinceConsumed > slowDays ? 'slow' : 'active';
      const dailyUse = consumedQty / periodDays;
      const attributed = n(r.b0_30) + n(r.b31_60) + n(r.b61_90) + n(r.b91_180) + n(r.b180_plus);
      // On-hand no inbound movement explains (e.g. legacy seeded stock) is shown as oldest.
      const unattributed = Math.max(0, onHand - attributed);
      return {
        productId: r.productId,
        variantId: r.variantId,
        locationId: r.locationId,
        location: r.location_name,
        code: r.code,
        name: r.name,
        category: r.category,
        uom: r.uom,
        onHand: round(onHand),
        unitCost: round(unit),
        value,
        aging: {
          d0_30: round(n(r.b0_30)),
          d31_60: round(n(r.b31_60)),
          d61_90: round(n(r.b61_90)),
          d91_180: round(n(r.b91_180)),
          d180_plus: round(n(r.b180_plus) + unattributed),
        },
        weightedAgeDays: r.weighted_age == null ? null : Math.round(n(r.weighted_age)),
        lastConsumedAt: lastConsumed,
        lastInboundAt: r.last_inbound_at,
        daysSinceConsumed,
        consumedQty: round(consumedQty),
        consumedValue: round(n(r.consumed_value), 2),
        turnover: avgQty > 0 ? round(consumedQty / avgQty, 2) : null,
        daysOfCover: dailyUse > 0 ? Math.round(onHand / dailyUse) : null,
        status,
      };
    });
    const filtered = q.status && q.status !== 'all' ? out.filter((r) => r.status === q.status) : out;
    const sum = (list: typeof out) => round(list.reduce((s, r) => s + r.value, 0), 2);
    return {
      summary: {
        ...this.emptyHealthSummary(slowDays, deadDays, start, end),
        quants: out.length,
        totalValue: sum(out),
        activeValue: sum(out.filter((r) => r.status === 'active')),
        slowValue: sum(out.filter((r) => r.status === 'slow')),
        deadValue: sum(out.filter((r) => r.status === 'dead')),
        slowCount: out.filter((r) => r.status === 'slow').length,
        deadCount: out.filter((r) => r.status === 'dead').length,
        truncated: rows.length >= 5000,
      },
      rows: filtered,
    };
  }

  private emptyHealthSummary(slowDays: number, deadDays: number, start: Date, end: Date) {
    return {
      slowDays,
      deadDays,
      start: localIso(start),
      end: localIso(end),
      quants: 0,
      totalValue: 0,
      activeValue: 0,
      slowValue: 0,
      deadValue: 0,
      slowCount: 0,
      deadCount: 0,
      truncated: false,
    };
  }
}
