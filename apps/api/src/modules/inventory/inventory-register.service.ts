import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { parseLocalDay, type ReportScopeQuery } from './inventory-reports.service';

/**
 * Movement registers with analytics — Stock In, Stock Out, Damages, Adjustments
 * and Stock Transfers on /inventory/reports.
 *
 * Source of truth is the InventoryLedger (every POSTED movement, whatever door
 * it came through — POS, GRN, direct stock in/out, documents, recipes). Each
 * line is enriched from its source document (waste category, adjustment reason,
 * stock-out category, transfer route, responsible / approver).
 *
 * Kinds:
 *   stock_in     receipt, return_in, production_output, opening_balance
 *   stock_out    issue, production_consume, internal_use, promo_sample,
 *                return_to_supplier  (damaged/expired stock-outs go to damages)
 *   damages      waste, expiry_write_off, + adjustments and stock-outs whose
 *                reason is damaged / expired / theft
 *   adjustments  adjustment_in, adjustment_out (signed: gain +, loss −)
 *   transfers    transfer_out lines, paired with their transfer_in for the route
 */

export const REGISTER_KINDS = ['stock_in', 'stock_out', 'damages', 'adjustments', 'transfers'] as const;
export type RegisterKind = (typeof REGISTER_KINDS)[number];

const KIND_TYPES: Record<RegisterKind, string[]> = {
  stock_in: ['receipt', 'return_in', 'production_output', 'opening_balance'],
  stock_out: ['issue', 'production_consume', 'internal_use', 'promo_sample', 'return_to_supplier'],
  damages: ['waste', 'expiry_write_off', 'adjustment_out', 'internal_use', 'promo_sample', 'issue'],
  adjustments: ['adjustment_in', 'adjustment_out'],
  transfers: ['transfer_out', 'transfer_in'],
};

const DAMAGE_REASONS = new Set(['damaged', 'expired', 'theft']);

const SOURCE_LABELS: Record<string, string> = {
  pos_invoice: 'POS sale',
  pos_refund: 'POS refund',
  menu_recipe: 'Recipe consumption',
  goods_receipt: 'Purchase receipt (GRN)',
  direct_stock_in: 'Direct stock in',
  direct_stock_out: 'Direct stock out',
  stock_out: 'Stock-out document',
  waste: 'Waste / damage record',
  stock_adjust: 'Stock adjustment',
  stock_adjustment: 'Stock adjustment',
  stock_transfer: 'Stock transfer',
  repair_part_issue: 'Repair part issue',
  production: 'Production',
  opening_backfill: 'Opening balance (backfill)',
  manual: 'Manual / unreferenced',
  opening_balance: 'Opening balance',
};

const TYPE_LABELS: Record<string, string> = {
  receipt: 'Receipt', return_in: 'Customer return', production_output: 'Production output',
  opening_balance: 'Opening balance', issue: 'Issue / sale', production_consume: 'Production consume',
  internal_use: 'Internal use', promo_sample: 'Promo / sample', return_to_supplier: 'Return to supplier',
  waste: 'Waste', expiry_write_off: 'Expiry write-off', adjustment_in: 'Adjustment in',
  adjustment_out: 'Adjustment out', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const n = (v: Prisma.Decimal | number | string | null | undefined) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface RegisterQuery extends ReportScopeQuery {
  staffId?: string;
  source?: string;
  reason?: string;
  direction?: string; // adjustments: gain | loss
}

interface Line {
  id: string;
  date: Date;
  ledgerCode: string;
  docRef: string | null;
  source: string;
  sourceLabel: string;
  type: string;
  typeLabel: string;
  productId: string;
  code: string;
  name: string;
  categoryId: string | null;
  category: string;
  uom: string | null;
  locationId: string;
  location: string;
  toLocationId: string | null;
  toLocation: string | null;
  /** Absolute for in/out/damages/transfers; signed (+gain / −loss) for adjustments. */
  qty: number;
  unitCost: number;
  /** Absolute for in/out/damages/transfers; signed for adjustments. */
  value: number;
  reason: string;
  responsibleId: string | null;
  responsible: string | null;
  approvedBy: string | null;
  performedBy: string | null;
  notes: string | null;
}

@Injectable()
export class InventoryRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async register(kindRaw: string, q: RegisterQuery) {
    const kind = kindRaw as RegisterKind;
    if (!REGISTER_KINDS.includes(kind)) throw new BadRequestException(`Unknown report: ${kindRaw}`);

    // Window — default this month; bounded so trend buckets stay readable.
    const today = new Date();
    let end = parseLocalDay(q.end, 'end') ?? parseLocalDay(localIso(today), 'end')!;
    // "All time": from the first ledger movement, capped at the 2-year window.
    let start = parseLocalDay(q.start, 'start');
    if (!start) {
      const first = await this.prisma.client.inventoryLedger.findFirst({
        where: { organizationId: this.tenant.organizationId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const floor = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 730);
      start = parseLocalDay(localIso(first && first.createdAt > floor ? first.createdAt : floor), 'start')!;
    }
    if (start > end) [start, end] = [parseLocalDay(localIso(end), 'start')!, parseLocalDay(localIso(start), 'end')!];
    const spanMs = end.getTime() - start.getTime();
    if (spanMs > 732 * 86_400_000) throw new BadRequestException('Registers are limited to a 2-year window');

    // Previous period of equal length, for period-over-period comparison.
    const prevEnd = new Date(start.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - spanMs);

    const [current, previous] = await Promise.all([
      this.loadLines(kind, q, start, end),
      this.loadLines(kind, q, prevStart, prevEnd, true),
    ]);

    // Facets are taken before the source/reason/staff filters so the dropdowns
    // always list every option available in the window.
    const facets = {
      sources: [...new Set(current.map((l) => l.source))].map((s) => ({ value: s, label: SOURCE_LABELS[s] ?? humanize(s) })),
      reasons: [...new Set(current.map((l) => l.reason))].sort(),
      staff: [...new Map(current.filter((l) => l.responsibleId).map((l) => [l.responsibleId!, l.responsible ?? l.responsibleId!])).entries()]
        .map(([value, label]) => ({ value, label })),
    };

    const rows = this.applyLineFilters(current, q);
    const prevRows = this.applyLineFilters(previous, q);

    return {
      kind,
      range: { start: localIso(start), end: localIso(end), days: Math.ceil(spanMs / 86_400_000) },
      previousRange: { start: localIso(prevStart), end: localIso(prevEnd) },
      summary: this.summary(kind, rows, prevRows, Math.ceil(spanMs / 86_400_000)),
      trend: this.trend(kind, rows, start, end),
      byProduct: this.group(rows, (l) => l.productId, (l) => ({ code: l.code, name: l.name, uom: l.uom, category: l.category }), true),
      byCategory: this.group(rows, (l) => l.category),
      byLocation: this.group(rows, (l) => (kind === 'transfers' ? `${l.location} → ${l.toLocation ?? '?'}` : l.location)),
      bySource: this.group(rows, (l) => l.sourceLabel),
      byReason: this.group(rows, (l) => l.reason),
      byType: this.group(rows, (l) => l.typeLabel),
      byStaff: this.group(rows, (l) => l.responsible ?? l.performedBy ?? 'Unassigned'),
      byWeekday: WEEKDAYS.map((d, i) => {
        const hit = rows.filter((l) => l.date.getDay() === i);
        return { key: d, lines: hit.length, qty: r6(hit.reduce((s, l) => s + Math.abs(l.qty), 0)), value: r2(hit.reduce((s, l) => s + Math.abs(l.value), 0)) };
      }),
      byHour: Array.from({ length: 24 }, (_, h) => {
        const hit = rows.filter((l) => l.date.getHours() === h);
        return { key: String(h).padStart(2, '0'), lines: hit.length, value: r2(hit.reduce((s, l) => s + Math.abs(l.value), 0)) };
      }),
      facets,
      rows: rows
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 5000)
        .map((l) => ({ ...l, qty: r6(l.qty), value: r2(l.value), unitCost: r2(l.unitCost) })),
      truncated: rows.length > 5000,
    };
  }

  // ---------------------------------------------------------------------------

  private applyLineFilters(lines: Line[], q: RegisterQuery) {
    return lines.filter((l) =>
      (!q.source || l.source === q.source)
      && (!q.reason || l.reason === q.reason)
      && (!q.staffId || l.responsibleId === q.staffId)
      && (!q.direction || (q.direction === 'gain' ? l.qty > 0 : l.qty < 0)),
    );
  }

  private async loadLines(kind: RegisterKind, q: RegisterQuery, start: Date, end: Date, light = false): Promise<Line[]> {
    const organizationId = this.tenant.organizationId;

    // Product scope (category incl. sub-categories, search, single item).
    let productIds: string[] | undefined;
    if (q.productId || q.categoryId || q.search?.trim()) {
      const where: Prisma.ProductWhereInput = { organizationId };
      if (q.productId) where.id = q.productId;
      if (q.categoryId) where.categoryId = { in: await this.categoryTree(q.categoryId) };
      const s = q.search?.trim();
      if (s) {
        where.OR = ['code', 'name', 'sku', 'barcode'].map((f) => ({ [f]: { contains: s, mode: 'insensitive' } }));
      }
      productIds = (await this.prisma.client.product.findMany({ where, select: { id: true } })).map((p) => p.id);
      if (productIds.length === 0) return [];
    }

    const where: Prisma.InventoryLedgerWhereInput = {
      organizationId,
      createdAt: { gte: start, lte: end },
      type: { in: KIND_TYPES[kind] as any },
      ...(productIds ? { productId: { in: productIds } } : {}),
    };
    // Transfers match the location on either leg — resolved after pairing.
    if (q.locationId && kind !== 'transfers') where.locationId = q.locationId;

    const ledger = await this.prisma.client.inventoryLedger.findMany({
      where,
      select: {
        id: true, createdAt: true, ledgerCode: true, type: true, productId: true, locationId: true,
        quantityChange: true, unitCost: true, totalValue: true, referenceType: true, referenceId: true,
        notes: true, performedBy: true, responsibleById: true, approvedById: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (ledger.length === 0) return [];

    // ---- Source documents ---------------------------------------------------
    const refs = (type: string) => [...new Set(ledger.filter((l) => l.referenceType === type && l.referenceId).map((l) => l.referenceId!))];
    const adjCodes = [...new Set(ledger.map((l) => /^(ADJ-[\w-]+)/.exec(l.notes ?? '')?.[1]).filter(Boolean) as string[])];
    const [wastes, stockOuts, adjustments, transfers] = await Promise.all([
      refs('waste').length
        ? this.prisma.client.wasteRecord.findMany({ where: { organizationId, wasteCode: { in: refs('waste') } }, select: { wasteCode: true, category: true, responsibleById: true, approvedById: true, notes: true } })
        : [],
      refs('stock_out').length
        ? this.prisma.client.stockOut.findMany({ where: { organizationId, outCode: { in: refs('stock_out') } }, select: { outCode: true, category: true, reason: true, responsibleById: true, approvedById: true } })
        : [],
      adjCodes.length
        ? this.prisma.client.stockAdjustment.findMany({ where: { organizationId, adjCode: { in: adjCodes } }, select: { adjCode: true, reason: true, responsibleById: true, approvedById: true } })
        : [],
      refs('stock_transfer').length
        ? this.prisma.client.stockTransfer.findMany({ where: { organizationId, transferCode: { in: refs('stock_transfer') } }, select: { transferCode: true, fromLocId: true, toLocId: true, responsibleById: true, approvedById: true } })
        : [],
    ]);
    const wasteBy = new Map(wastes.map((w) => [w.wasteCode, w]));
    const outBy = new Map(stockOuts.map((o) => [o.outCode, o]));
    const adjBy = new Map(adjustments.map((a) => [a.adjCode, a]));
    const trfBy = new Map(transfers.map((t) => [t.transferCode, t]));

    // ---- Lookups --------------------------------------------------------------
    const userIds = new Set<string>();
    for (const l of ledger) [l.performedBy, l.responsibleById, l.approvedById].forEach((u) => u && userIds.add(u));
    for (const d of [...wastes, ...stockOuts, ...adjustments, ...transfers]) [d.responsibleById, d.approvedById].forEach((u) => u && userIds.add(u));
    const allLocIds = new Set(ledger.map((l) => l.locationId));
    transfers.forEach((t) => { allLocIds.add(t.fromLocId); allLocIds.add(t.toLocId); });

    const [products, locations, users] = await Promise.all([
      this.prisma.client.product.findMany({
        where: { id: { in: [...new Set(ledger.map((l) => l.productId))] } },
        select: { id: true, code: true, name: true, uom: { select: { code: true } }, category: { select: { id: true, name: true } } },
      }),
      this.prisma.client.inventoryLocation.findMany({ where: { id: { in: [...allLocIds] } }, select: { id: true, name: true } }),
      light || userIds.size === 0
        ? Promise.resolve([])
        : this.prisma.client.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const prodBy = new Map(products.map((p) => [p.id, p]));
    const locBy = new Map(locations.map((l) => [l.id, l.name]));
    const userBy = new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ')]));
    const person = (id: string | null | undefined) => (id ? (userBy.get(id) ?? null) : null);

    // Transfer pairing: transfer_in leg per (reference, product).
    const inLeg = new Map<string, string>();
    for (const l of ledger) {
      if (l.type === 'transfer_in') inLeg.set(`${l.referenceId ?? l.ledgerCode}|${l.productId}`, l.locationId);
    }

    const lines: Line[] = [];
    for (const l of ledger) {
      if (kind === 'transfers' && l.type !== 'transfer_out') continue;
      const p = prodBy.get(l.productId);
      const signedQty = n(l.quantityChange);
      const absValue = n(l.totalValue);
      const source = l.referenceType ?? (/^ADJ-/.test(l.notes ?? '') ? 'stock_adjust' : l.type === 'opening_balance' ? 'opening_balance' : 'manual');

      // Reason + document-level people, by source.
      let reason = TYPE_LABELS[l.type] ?? humanize(l.type);
      let docRef: string | null = l.referenceId;
      let responsibleId = l.responsibleById;
      let approvedId = l.approvedById;
      let toLocationId: string | null = null;

      const adjCode = /^(ADJ-[\w-]+)(?:\s*·\s*(\w+))?/.exec(l.notes ?? '');
      if (l.referenceType === 'waste' && l.referenceId && wasteBy.has(l.referenceId)) {
        const w = wasteBy.get(l.referenceId)!;
        reason = l.type === 'expiry_write_off' ? 'Expired' : humanize(w.category);
        responsibleId ??= w.responsibleById; approvedId ??= w.approvedById;
      } else if (l.referenceType === 'stock_out' && l.referenceId && outBy.has(l.referenceId)) {
        const o = outBy.get(l.referenceId)!;
        reason = humanize(o.category);
        responsibleId ??= o.responsibleById; approvedId ??= o.approvedById;
      } else if (adjCode) {
        docRef = adjCode[1];
        const a = adjBy.get(adjCode[1]);
        reason = humanize(a?.reason ?? adjCode[2] ?? 'other');
        responsibleId ??= a?.responsibleById ?? null; approvedId ??= a?.approvedById ?? null;
      } else if (l.referenceType === 'stock_transfer' && l.referenceId && trfBy.has(l.referenceId)) {
        const t = trfBy.get(l.referenceId)!;
        toLocationId = t.toLocId;
        responsibleId ??= t.responsibleById; approvedId ??= t.approvedById;
        reason = 'Transfer';
      } else if (l.type === 'waste') {
        reason = 'Waste';
      }
      if (kind === 'transfers') {
        toLocationId ??= inLeg.get(`${l.referenceId ?? l.ledgerCode}|${l.productId}`) ?? null;
        if (q.locationId && l.locationId !== q.locationId && toLocationId !== q.locationId) continue;
      }

      // Kind-specific membership for the mixed buckets.
      const reasonKey = reason.toLowerCase();
      const isDamage = l.type === 'waste' || l.type === 'expiry_write_off' || DAMAGE_REASONS.has(reasonKey);
      if (kind === 'damages' && !isDamage) continue;
      if (kind === 'stock_out' && isDamage) continue;
      // Damaged/expired/theft ADJUSTMENTS stay under Adjustments too (shown in both).

      lines.push({
        id: l.id,
        date: l.createdAt,
        ledgerCode: l.ledgerCode,
        docRef,
        source,
        sourceLabel: SOURCE_LABELS[source] ?? humanize(source),
        type: l.type,
        typeLabel: TYPE_LABELS[l.type] ?? humanize(l.type),
        productId: l.productId,
        code: p?.code ?? '',
        name: p?.name ?? l.productId,
        categoryId: p?.category?.id ?? null,
        category: p?.category?.name ?? 'Uncategorised',
        uom: p?.uom?.code ?? null,
        locationId: l.locationId,
        location: locBy.get(l.locationId) ?? '—',
        toLocationId,
        toLocation: toLocationId ? (locBy.get(toLocationId) ?? '—') : null,
        qty: kind === 'adjustments' ? signedQty : Math.abs(signedQty),
        unitCost: n(l.unitCost),
        value: kind === 'adjustments' ? Math.sign(signedQty) * absValue : absValue,
        reason,
        responsibleId: responsibleId ?? null,
        responsible: person(responsibleId),
        approvedBy: person(approvedId),
        performedBy: person(l.performedBy),
        notes: l.notes,
      });
    }
    return lines;
  }

  private summary(kind: RegisterKind, rows: Line[], prev: Line[], days: number) {
    const tot = (ls: Line[]) => ({
      lines: ls.length,
      qty: r6(ls.reduce((s, l) => s + (kind === 'adjustments' ? l.qty : Math.abs(l.qty)), 0)),
      value: r2(ls.reduce((s, l) => s + (kind === 'adjustments' ? l.value : Math.abs(l.value)), 0)),
    });
    const cur = tot(rows);
    const pv = tot(prev);
    const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : null) : r2(((a - b) / Math.abs(b)) * 100));
    const gains = rows.filter((l) => l.qty > 0);
    const losses = rows.filter((l) => l.qty < 0);
    const byDoc = new Set(rows.map((l) => l.docRef ?? l.ledgerCode));
    const productValues = new Map<string, number>();
    rows.forEach((l) => productValues.set(l.name, (productValues.get(l.name) ?? 0) + Math.abs(l.value)));
    const top = [...productValues.entries()].sort((a, b) => b[1] - a[1])[0];
    const grossValue = rows.reduce((s, l) => s + Math.abs(l.value), 0);
    // Pareto: share of items making up 80% of value.
    const sortedVals = [...productValues.values()].sort((a, b) => b - a);
    let acc = 0; let pareto = 0;
    for (const v of sortedVals) { if (acc >= grossValue * 0.8) break; acc += v; pareto++; }

    return {
      ...cur,
      documents: byDoc.size,
      items: new Set(rows.map((l) => l.productId)).size,
      locations: new Set(rows.map((l) => l.locationId)).size,
      grossValue: r2(grossValue),
      avgValuePerDay: r2(grossValue / Math.max(1, days)),
      avgValuePerLine: rows.length ? r2(grossValue / rows.length) : 0,
      previous: pv,
      changePct: { lines: pct(cur.lines, pv.lines), qty: pct(cur.qty, pv.qty), value: pct(cur.value, pv.value) },
      topItem: top ? { name: top[0], value: r2(top[1]), sharePct: grossValue ? r2((top[1] / grossValue) * 100) : 0 } : null,
      paretoItems: pareto,
      unassignedLines: rows.filter((l) => !l.responsibleId).length,
      unapprovedLines: rows.filter((l) => !l.approvedBy).length,
      ...(kind === 'adjustments'
        ? {
            gainQty: r6(gains.reduce((s, l) => s + l.qty, 0)),
            gainValue: r2(gains.reduce((s, l) => s + l.value, 0)),
            lossQty: r6(losses.reduce((s, l) => s - l.qty, 0)),
            lossValue: r2(losses.reduce((s, l) => s - l.value, 0)),
          }
        : {}),
    };
  }

  private trend(kind: RegisterKind, rows: Line[], start: Date, end: Date) {
    const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
    // > 92 days → weekly buckets (Monday), > 400 → monthly.
    const bucket = days > 400 ? 'month' : days > 92 ? 'week' : 'day';
    const keyOf = (d: Date) => {
      if (bucket === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (bucket === 'week') {
        const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
        return localIso(m);
      }
      return localIso(d);
    };
    const map = new Map<string, { key: string; lines: number; qty: number; value: number; gain: number; loss: number }>();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const k = keyOf(d);
      if (!map.has(k)) map.set(k, { key: k, lines: 0, qty: 0, value: 0, gain: 0, loss: 0 });
    }
    for (const l of rows) {
      const b = map.get(keyOf(l.date));
      if (!b) continue;
      b.lines += 1;
      b.qty += Math.abs(l.qty);
      b.value += Math.abs(l.value);
      if (kind === 'adjustments') { if (l.value >= 0) b.gain += l.value; else b.loss += -l.value; }
    }
    return {
      bucket,
      points: [...map.values()].map((b) => ({ ...b, qty: r6(b.qty), value: r2(b.value), gain: r2(b.gain), loss: r2(b.loss) })),
    };
  }

  private group(rows: Line[], keyFn: (l: Line) => string, extra?: (l: Line) => Record<string, unknown>, withAvgCost = false) {
    const total = rows.reduce((s, l) => s + Math.abs(l.value), 0);
    const map = new Map<string, { key: string; lines: number; qty: number; value: number; netValue: number; docs: Set<string>; extra?: Record<string, unknown> }>();
    for (const l of rows) {
      const k = keyFn(l);
      const g = map.get(k) ?? { key: k, lines: 0, qty: 0, value: 0, netValue: 0, docs: new Set<string>(), extra: extra?.(l) };
      g.lines += 1;
      g.qty += l.qty;
      g.value += Math.abs(l.value);
      g.netValue += l.value;
      g.docs.add(l.docRef ?? l.ledgerCode);
      map.set(k, g);
    }
    return [...map.values()]
      .map((g) => ({
        key: g.key,
        ...(g.extra ?? {}),
        lines: g.lines,
        documents: g.docs.size,
        qty: r6(g.qty),
        value: r2(g.value),
        netValue: r2(g.netValue),
        sharePct: total ? r2((g.value / total) * 100) : 0,
        ...(withAvgCost ? { avgUnitCost: g.qty ? r2(Math.abs(g.netValue / g.qty)) : 0 } : {}),
      }))
      .sort((a, b) => b.value - a.value);
  }

  private async categoryTree(categoryId: string): Promise<string[]> {
    const all = await this.prisma.client.productCategory.findMany({
      where: { organizationId: this.tenant.organizationId },
      select: { id: true, parentId: true },
    });
    const out = new Set<string>([categoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of all) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true; }
    }
    return [...out];
  }
}
