import { Prisma } from '@prisma/client';
import {
  ADJUSTMENT_SOURCE_TYPES,
  CASH_MOVEMENT_CATEGORIES,
  CATEGORY_OF_SOURCE,
  INTERNAL_SOURCE_TYPES,
  KNOWN_SOURCE_TYPES,
} from './money-activity.taxonomy';

/**
 * SQL building blocks shared by every money query, so the feed, overview,
 * settlements and the movement report classify an entry identically.
 *
 * `je` must be the JournalEntry alias in the surrounding query.
 */

/**
 * `sourceType` refined by the Payment behind a generic `payment` entry: POS
 * tenders carry a `cashSessionId`, so a POS sale is not reported as an
 * invoice receipt, a till refund not as a receipt, and an outbound payment
 * not as a customer receipt.
 */
export const EFFECTIVE_SOURCE_TYPE = Prisma.sql`(CASE WHEN je."sourceType" = 'payment' THEN COALESCE((
    SELECT CASE
      WHEN p."cashSessionId" IS NOT NULL AND p.direction::text = 'inbound' THEN 'pos_payment'
      WHEN p."cashSessionId" IS NOT NULL THEN 'pos_payment_refund'
      WHEN p.direction::text = 'outbound' THEN 'payment_outbound'
      ELSE 'payment' END
    FROM "Payment" p WHERE p.id = je."sourceId"
  ), 'payment') ELSE je."sourceType" END)`;

/** Effective source types that are POS takings (sales, not refunds). */
export const POS_SALE_SOURCE_TYPES = CASH_MOVEMENT_CATEGORIES.find((c) => c.key === 'pos_sales')?.sourceTypes ?? [];

/** `(<effective source> IN categories)` — `other` matches NULL and anything unmapped. */
export function categorySql(categories: string[]): Prisma.Sql {
  const keys = new Set(categories);
  const sourceTypes = KNOWN_SOURCE_TYPES.filter((st) => keys.has(CATEGORY_OF_SOURCE.get(st)!));
  const clauses: Prisma.Sql[] = [];
  if (sourceTypes.length) clauses.push(Prisma.sql`${EFFECTIVE_SOURCE_TYPE} IN (${Prisma.join(sourceTypes)})`);
  if (keys.has('other')) {
    clauses.push(Prisma.sql`(je."sourceType" IS NULL OR ${EFFECTIVE_SOURCE_TYPE} NOT IN (${Prisma.join(KNOWN_SOURCE_TYPES)}))`);
  }
  return clauses.length ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})` : Prisma.sql`FALSE`;
}

/**
 * Direction for a per-entry aggregate `x(eff, d, c)` — mirrors
 * `classifyMoneyEntry` so SQL filters and row classification agree.
 */
export const DIRECTION_SQL = Prisma.sql`(CASE
  WHEN x.eff IN (${Prisma.join([...ADJUSTMENT_SOURCE_TYPES])}) THEN 'adjustment'
  WHEN x.eff IN (${Prisma.join([...INTERNAL_SOURCE_TYPES])}) AND LEAST(x.d, x.c) > 0 THEN 'internal'
  WHEN x.d > x.c THEN 'in'
  WHEN x.c > x.d THEN 'out'
  ELSE 'internal' END)`;
