import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';

const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
const num = (v: unknown) => (v == null ? 0 : Number(v));

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
  unitCost: string;
  onHandQty: number;
  totalValue: string;
  accountCode: string;
  accountName: string;
}

/**
 * Accounting-side inventory valuation and the inventory-to-GL tie-out.
 *
 * Self-contained on Prisma (the accounting module cannot import inventory — the
 * dependency runs the other way). Two views of stock value:
 *   - current (asOf today or later): Σ StockItem.quantity × running average
 *     (product cost price when the average is not positive) — the same basis the
 *     engine capitalises and relieves at;
 *   - historical (asOf in the past): rebuilt from the append-only ledger —
 *     quantity = Σ quantityChange, value = Σ signed movement value — up to asOf.
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

  /** Accounts that hold inventory value: the stock_valuation mapping plus any account a stock-in rule debits. */
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
    const ruleKeys = rules.filter((r) => r.accountSource === 'account_mapping' && r.accountMappingKey).map((r) => r.accountMappingKey!);
    if (ruleKeys.length) {
      const extra = await this.prisma.raw.accountMapping.findMany({
        where: { organizationId, key: { in: ruleKeys } },
        select: { accountId: true },
      });
      for (const m of extra) ids.add(m.accountId);
    }
    for (const r of rules) if (r.literalAccountId) ids.add(r.literalAccountId);
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
      : await this.prisma.raw.$queryRawUnsafe(
          `SELECT s."productId" AS product_id,
                  SUM(s."quantity") AS qty,
                  SUM(s."quantity" * CASE WHEN s."runningAverageCost" > 0 THEN s."runningAverageCost" ELSE COALESCE(p."costPrice", 0) END) AS value
             FROM "StockItem" s
             JOIN "Product" p ON p.id = s."productId"
            WHERE s."organizationId" = $1
            GROUP BY s."productId"`,
          organizationId,
        );

    const nonZero = rows.filter((r) => num(r.qty) !== 0 || num(r.value) !== 0);
    const products = await this.prisma.raw.product.findMany({
      where: { organizationId, id: { in: nonZero.map((r) => r.product_id) } },
      select: { id: true, name: true, sku: true, code: true, category: { select: { name: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const items: ValuationItem[] = nonZero
      .map((r) => {
        const p = byId.get(r.product_id);
        const qty = num(r.qty);
        const value = num(r.value);
        return {
          productId: r.product_id,
          productName: p?.name ?? r.product_id,
          sku: p?.sku ?? p?.code ?? '',
          categoryName: p?.category?.name ?? 'Uncategorized',
          unitCost: (qty !== 0 ? value / qty : 0).toFixed(4),
          onHandQty: round(qty, 6),
          totalValue: value.toFixed(2),
          accountCode: account?.code ?? '',
          accountName: account?.name ?? '',
        };
      })
      .sort((a, b) => a.productName.localeCompare(b.productName));

    return {
      asOf: date.toISOString(),
      basis: historical ? 'ledger' : 'current_cost',
      items,
      summary: {
        totalItems: items.length,
        totalValue: items.reduce((s, i) => s + Number(i.totalValue), 0).toFixed(2),
        totalQty: round(items.reduce((s, i) => s + i.onHandQty, 0), 6),
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
    const subledgerValue = Number(val.summary.totalValue);

    if (accountIds.length === 0) {
      return {
        asOf: date.toISOString(),
        accounts: [],
        subledgerValue,
        glBalance: 0,
        variance: round(subledgerValue),
        withinTolerance: Math.abs(subledgerValue) <= tolerance,
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

    const glBalance = glBySource.reduce((s, r) => s + num(r.amount), 0);
    const sources = new Set<string>([...glBySource, ...ledgerBySource].map((r) => r.source ?? '(none)'));
    const bySource = [...sources]
      .map((source) => {
        const gl = num(glBySource.find((r) => (r.source ?? '(none)') === source)?.amount);
        const ledger = num(ledgerBySource.find((r) => (r.source ?? '(none)') === source)?.amount);
        return { source, ledgerValue: round(ledger), glValue: round(gl), difference: round(ledger - gl) };
      })
      .filter((r) => r.ledgerValue !== 0 || r.glValue !== 0)
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

    const variance = round(subledgerValue - glBalance);
    return {
      asOf: date.toISOString(),
      accounts,
      subledgerValue: round(subledgerValue),
      subledgerBasis: val.basis,
      glBalance: round(glBalance),
      variance,
      tolerance,
      withinTolerance: Math.abs(variance) <= tolerance,
      bySource,
      unpostedMovements: unposted
        .map((u) => ({ source: u.source ?? '(none)', moveType: u.move_type, rows: num(u.rows), value: round(num(u.value)) }))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    };
  }
}
