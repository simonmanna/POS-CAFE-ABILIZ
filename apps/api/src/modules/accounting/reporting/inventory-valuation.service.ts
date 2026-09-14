import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';

const D = (v: unknown) => new Prisma.Decimal(v == null ? 0 : String(v));
const ZERO = new Prisma.Decimal(0);
/** Money for the API surface: rounded half-up in Decimal, emitted as a number. */
const money = (v: Prisma.Decimal, dp = 2) => Number(v.toDecimalPlaces(dp, Prisma.Decimal.ROUND_HALF_UP).toFixed(dp));

/** Movement types that relocate value inside inventory and never hit the GL on their own. */
const GL_NEUTRAL_TYPES = ['transfer_in', 'transfer_out'];

/** JE sourceType used by the GL-gap catch-up script (scripts/backfill-inventory-gl-gaps.ts). */
export const GL_GAP_BACKFILL_SOURCE = 'inventory_gl_gap_backfill';

/**
 * A valued ledger row counts as "unposted" when no non-draft journal entry that
 * touches an inventory account references it (by document id or ledger code),
 * and no GL-gap catch-up entry for its source already covered it. Parameters:
 * $1 org, $4 inventory account ids. Row alias `l`.
 */
const UNPOSTED_PREDICATE = `NOT EXISTS (
            SELECT 1 FROM "JournalEntry" e
              JOIN "JournalLine" jl ON jl."journalEntryId" = e.id
             WHERE e."organizationId" = l."organizationId" AND e.status <> 'draft'
               AND jl."accountId" = ANY($4::text[])
               AND (
                 e."sourceId" = l."referenceId" OR e."sourceId" = l."ledgerCode"
                 OR (e."sourceType" = '${GL_GAP_BACKFILL_SOURCE}'
                     AND e."sourceId" = COALESCE(l."referenceType", '(none)')
                     AND l."createdAt" <= e."createdAt")
               )
          )`;

export interface ValuationItem {
  productId: string;
  productName: string;
  sku: string;
  categoryName: string;
  costingMethod: string;
  unitCost: string;
  onHandQty: number;
  totalValue: string;
  /** Unrounded value, so totals are summed before rounding. */
  exactValue: string;
  accountCode: string;
  accountName: string;
}

/**
 * Accounting-side inventory valuation and the inventory-to-GL tie-out.
 *
 * Self-contained on Prisma (the accounting module cannot import inventory — the
 * dependency runs the other way). Two views of stock value:
 *   - current (asOf today or later): costing-method-correct remaining value —
 *       AVCO      quant × running average (cost price when not positive);
 *       STANDARD  quant × standard cost price;
 *       FIFO / batch-tracked  Σ remaining active lot qty × lot unit cost, plus
 *                 any quant not covered by lots (oversell overflow) at average;
 *       serial-tracked  Σ in-stock serial unit costs, plus un-serialised units
 *                 at the average;
 *   - historical (asOf in the past): rebuilt from the append-only ledger —
 *     quantity = Σ quantityChange, value = Σ signed movement value — up to asOf.
 * All arithmetic stays in Decimal; values are rounded only at the API surface.
 */
@Injectable()
export class InventoryValuationReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  private parseAsOf(asOf?: string): { date: Date; historical: boolean } {
    if (!asOf) return { date: new Date(), historical: false };
    // A bare date means "end of that day".
    const date = asOf.length <= 10 ? new Date(`${asOf}T23:59:59.999`) : new Date(asOf);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`Invalid asOf: ${asOf}`);
    return { date, historical: date.getTime() < Date.now() - 60_000 };
  }

  /**
   * Accounts that hold inventory value: the stock_valuation/inventory mappings,
   * every account a STOCK_IN debit rule can resolve to (mapping, literal, any
   * product/category-scoped rule), and every category/product inventory-account
   * override (what category_field / product_field rules resolve to).
   */
  async inventoryAccountIds(): Promise<string[]> {
    const organizationId = this.tenant.organizationId;
    const ids = new Set<string>();
    const mappings = await this.prisma.raw.accountMapping.findMany({
      where: { organizationId, key: { in: ['stock_valuation', 'inventory'] } },
      select: { key: true, accountId: true },
    });
    for (const m of mappings) ids.add(m.accountId);
    const rules = await this.prisma.raw.inventoryPostingRule.findMany({
      where: { organizationId, isActive: true, movementType: 'STOCK_IN', debitOrCredit: 'debit' },
      select: { accountSource: true, literalAccountId: true, accountMappingKey: true },
    });
    const ruleKeys = rules.filter((r) => r.accountMappingKey).map((r) => r.accountMappingKey!);
    if (ruleKeys.length) {
      const extra = await this.prisma.raw.accountMapping.findMany({
        where: { organizationId, key: { in: ruleKeys } },
        select: { accountId: true },
      });
      for (const m of extra) ids.add(m.accountId);
    }
    for (const r of rules) if (r.literalAccountId) ids.add(r.literalAccountId);
    const [cats, prods] = await Promise.all([
      this.prisma.raw.productCategory.findMany({
        where: { organizationId, inventoryAccountId: { not: null } },
        select: { inventoryAccountId: true },
      }),
      this.prisma.raw.product.findMany({
        where: { organizationId, inventoryAccountOverrideId: { not: null } },
        select: { inventoryAccountOverrideId: true },
      }),
    ]);
    for (const c of cats) if (c.inventoryAccountId) ids.add(c.inventoryAccountId);
    for (const p of prods) if (p.inventoryAccountOverrideId) ids.add(p.inventoryAccountOverrideId);
    return [...ids];
  }

  /**
   * Valued, non-transfer ledger rows with no inventory journal entry, created at
   * or before `before`. Used by the GL-gap catch-up script.
   */
  async unpostedLedgerRows(before: Date) {
    const organizationId = this.tenant.organizationId;
    const accountIds = await this.inventoryAccountIds();
    if (accountIds.length === 0) return { accountIds, rows: [] as any[] };
    const rows: Array<{ id: string; ledger_code: string; source: string | null; move_type: string; product_id: string; signed_value: any; created_at: Date }> =
      await this.prisma.raw.$queryRawUnsafe(
        `SELECT l.id, l."ledgerCode" AS ledger_code, l."referenceType" AS source, l."type"::text AS move_type,
                l."productId" AS product_id, l."createdAt" AS created_at,
                CASE WHEN l."quantityChange" >= 0 THEN l."totalValue" ELSE -l."totalValue" END AS signed_value
           FROM "InventoryLedger" l
          WHERE l."organizationId" = $1 AND l."createdAt" <= $2 AND l."totalValue" > 0
            AND l."type"::text <> ALL($3::text[])
            AND ${UNPOSTED_PREDICATE}
          ORDER BY l."createdAt"`,
        organizationId,
        before,
        GL_NEUTRAL_TYPES,
        accountIds,
      );
    return { accountIds, rows };
  }

  /**
   * Current remaining value per product, by costing method (see class doc). One
   * statement so quants, lots and serials come from one snapshot.
   */
  private currentValueByProduct(organizationId: string): Promise<Array<{ product_id: string; qty: any; value: any }>> {
    return this.prisma.raw.$queryRawUnsafe(
      `WITH quant AS (
         SELECT s."productId", s."variantKey", s."locationId", s."quantity" AS qty,
                CASE WHEN s."runningAverageCost" > 0 THEN s."runningAverageCost" ELSE COALESCE(p."costPrice", 0) END AS avg_cost,
                COALESCE(p."costPrice", 0) AS std_cost,
                p."costingMethod"::text AS method, p."batchTracking" AS lots, p."serialTracking" AS serials
           FROM "StockItem" s JOIN "Product" p ON p.id = s."productId"
          WHERE s."organizationId" = $1
       ),
       lot AS (
         SELECT b."productId", COALESCE(b."variantId", '') AS "variantKey", b."locationId",
                SUM(b."quantity") AS qty, SUM(b."quantity" * COALESCE(b."unitCost", 0)) AS value
           FROM "InventoryBatch" b
          WHERE b."organizationId" = $1 AND b."isActive" = true AND b."quantity" > 0
          GROUP BY 1, 2, 3
       ),
       ser AS (
         SELECT sr."productId", COALESCE(sr."variantId", '') AS "variantKey", sr."locationId",
                COUNT(*)::numeric AS qty, SUM(COALESCE(sr."unitCost", p."costPrice", 0)) AS value
           FROM "InventorySerial" sr JOIN "Product" p ON p.id = sr."productId"
          WHERE sr."organizationId" = $1 AND sr.status = 'in_stock'
          GROUP BY 1, 2, 3
       )
       SELECT q."productId" AS product_id,
              SUM(q.qty) AS qty,
              SUM(CASE
                    WHEN q.serials THEN COALESCE(se.value, 0) + (q.qty - COALESCE(se.qty, 0)) * q.avg_cost
                    WHEN q.method = 'FIFO' OR q.lots THEN COALESCE(l.value, 0) + (q.qty - COALESCE(l.qty, 0)) * q.avg_cost
                    WHEN q.method = 'STANDARD' THEN q.qty * q.std_cost
                    ELSE q.qty * q.avg_cost
                  END) AS value
         FROM quant q
         LEFT JOIN lot l ON l."productId" = q."productId" AND l."locationId" = q."locationId" AND l."variantKey" = q."variantKey"
         LEFT JOIN ser se ON se."productId" = q."productId" AND se."locationId" = q."locationId" AND se."variantKey" = q."variantKey"
        GROUP BY q."productId"`,
      organizationId,
    );
  }

  async valuation(asOf?: string) {
    const organizationId = this.tenant.organizationId;
    const { date, historical } = this.parseAsOf(asOf);
    const accountIds = await this.inventoryAccountIds();
    const account = accountIds.length
      ? await this.prisma.raw.account.findFirst({ where: { id: accountIds[0] }, select: { code: true, name: true } })
      : null;

    const rows: Array<{ product_id: string; qty: any; value: any }> = historical
      ? await this.prisma.raw.$queryRawUnsafe(
          `SELECT l."productId" AS product_id,
                  SUM(l."quantityChange") AS qty,
                  SUM(CASE WHEN l."quantityChange" >= 0 THEN l."totalValue" ELSE -l."totalValue" END) AS value
             FROM "InventoryLedger" l
            WHERE l."organizationId" = $1 AND l."createdAt" <= $2
            GROUP BY l."productId"`,
          organizationId,
          date,
        )
      : await this.currentValueByProduct(organizationId);

    const nonZero = rows.filter((r) => !D(r.qty).isZero() || !D(r.value).isZero());
    const products = await this.prisma.raw.product.findMany({
      where: { organizationId, id: { in: nonZero.map((r) => r.product_id) } },
      select: { id: true, name: true, sku: true, code: true, costingMethod: true, category: { select: { name: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const items: ValuationItem[] = nonZero
      .map((r) => {
        const p = byId.get(r.product_id);
        const qty = D(r.qty);
        const value = D(r.value);
        return {
          productId: r.product_id,
          productName: p?.name ?? r.product_id,
          sku: p?.sku ?? p?.code ?? '',
          categoryName: p?.category?.name ?? 'Uncategorized',
          costingMethod: String(p?.costingMethod ?? ''),
          unitCost: (qty.isZero() ? ZERO : value.dividedBy(qty)).toFixed(4),
          onHandQty: Number(qty.toDecimalPlaces(6)),
          totalValue: value.toFixed(2),
          exactValue: value.toString(),
          accountCode: account?.code ?? '',
          accountName: account?.name ?? '',
        };
      })
      .sort((a, b) => a.productName.localeCompare(b.productName));

    const total = items.reduce((s, i) => s.plus(D(i.exactValue)), ZERO);
    return {
      asOf: date.toISOString(),
      basis: historical ? 'ledger' : 'current_cost_by_method',
      items,
      summary: {
        totalItems: items.length,
        totalValue: total.toFixed(2),
        exactTotalValue: total.toString(),
        totalQty: Number(items.reduce((s, i) => s.plus(D(i.onHandQty)), ZERO).toDecimalPlaces(6)),
      },
      groupedBy: 'product',
    };
  }

  /**
   * Inventory sub-ledger vs the inventory control account(s). Explains any
   * variance by source: GL movement per JE sourceType next to ledger value per
   * referenceType, plus valued ledger movements with no journal entry at all
   * (the signature of a GL-bypassing path).
   */
  async glTieOut(asOf?: string, tolerance = 1) {
    const organizationId = this.tenant.organizationId;
    const { date } = this.parseAsOf(asOf);
    const accountIds = await this.inventoryAccountIds();
    const val = await this.valuation(asOf);
    const subledger = D(val.summary.exactTotalValue);
    const tol = D(tolerance);

    if (accountIds.length === 0) {
      return {
        asOf: date.toISOString(),
        accounts: [],
        subledgerValue: money(subledger),
        glBalance: 0,
        variance: money(subledger),
        withinTolerance: subledger.abs().lte(tol),
        tolerance,
        bySource: [],
        unpostedMovements: [],
        warning: 'No stock_valuation account mapping — cannot tie inventory to the GL.',
      };
    }

    const accounts = await this.prisma.raw.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, code: true, name: true },
    });

    const glBySource: Array<{ source: string | null; amount: any }> = await this.prisma.raw.$queryRawUnsafe(
      `SELECT e."sourceType" AS source, SUM(jl."debit" - jl."credit") AS amount
         FROM "JournalLine" jl
         JOIN "JournalEntry" e ON e.id = jl."journalEntryId"
        WHERE e."organizationId" = $1 AND e.status <> 'draft' AND e."postingDate" <= $2
          AND jl."accountId" = ANY($3::text[])
        GROUP BY e."sourceType"`,
      organizationId,
      date,
      accountIds,
    );
    const ledgerBySource: Array<{ source: string | null; amount: any }> = await this.prisma.raw.$queryRawUnsafe(
      `SELECT l."referenceType" AS source,
              SUM(CASE WHEN l."quantityChange" >= 0 THEN l."totalValue" ELSE -l."totalValue" END) AS amount
         FROM "InventoryLedger" l
        WHERE l."organizationId" = $1 AND l."createdAt" <= $2
        GROUP BY l."referenceType"`,
      organizationId,
      date,
    );
    const unposted: Array<{ source: string | null; move_type: string; rows: any; value: any }> = await this.prisma.raw.$queryRawUnsafe(
      `SELECT l."referenceType" AS source, l."type"::text AS move_type, COUNT(*) AS rows,
              SUM(CASE WHEN l."quantityChange" >= 0 THEN l."totalValue" ELSE -l."totalValue" END) AS value
         FROM "InventoryLedger" l
        WHERE l."organizationId" = $1 AND l."createdAt" <= $2 AND l."totalValue" > 0
          AND l."type"::text <> ALL($3::text[])
          AND ${UNPOSTED_PREDICATE}
        GROUP BY l."referenceType", l."type"`,
      organizationId,
      date,
      GL_NEUTRAL_TYPES,
      accountIds,
    );

    const glBalance = glBySource.reduce((s, r) => s.plus(D(r.amount)), ZERO);
    // Ledger value (Σ signed movement value) vs method-correct remaining value:
    // non-zero when layer costs and movement values diverge (e.g. overflow
    // issues valued at the average) — shown so a variance is not blamed on GL.
    const ledgerTotal = ledgerBySource.reduce((s, r) => s.plus(D(r.amount)), ZERO);
    const sources = new Set<string>([...glBySource, ...ledgerBySource].map((r) => r.source ?? '(none)'));
    const bySource = [...sources]
      .map((source) => {
        const gl = D(glBySource.find((r) => (r.source ?? '(none)') === source)?.amount);
        const ledger = D(ledgerBySource.find((r) => (r.source ?? '(none)') === source)?.amount);
        return { source, ledgerValue: money(ledger), glValue: money(gl), difference: money(ledger.minus(gl)), _abs: ledger.minus(gl).abs() };
      })
      .filter((r) => r.ledgerValue !== 0 || r.glValue !== 0)
      .sort((a, b) => b._abs.comparedTo(a._abs))
      .map(({ _abs, ...r }) => r);

    const variance = subledger.minus(glBalance);
    return {
      asOf: date.toISOString(),
      accounts,
      subledgerValue: money(subledger),
      subledgerBasis: val.basis,
      ledgerMovementValue: money(ledgerTotal),
      valuationVsLedger: money(subledger.minus(ledgerTotal)),
      glBalance: money(glBalance),
      variance: money(variance),
      tolerance,
      withinTolerance: variance.abs().lte(tol),
      bySource,
      unpostedMovements: unposted
        .map((u) => ({ source: u.source ?? '(none)', moveType: u.move_type, rows: Number(u.rows), value: money(D(u.value)), _abs: D(u.value).abs() }))
        .sort((a, b) => b._abs.comparedTo(a._abs))
        .map(({ _abs, ...r }) => r),
    };
  }
}
