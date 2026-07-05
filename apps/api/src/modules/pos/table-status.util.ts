/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Order statuses that "hold" a dine-in table (an order in one of these states,
 * with at least one active item, keeps the table OCCUPIED). `served` is the
 * billed-but-unpaid state — the customer has the bill but hasn't paid, so the
 * table stays held until the invoice settles and the order goes `closed`.
 * `closed` / `cancelled` release the table.
 */
export const TABLE_HELD_ORDER_STATUSES = [
  'draft',
  'open',
  'preparing',
  'ready',
  'served',
] as const;

/**
 * Single source of truth for dine-in table status.
 *
 * A table is OCCUPIED iff it currently has ≥1 active (non-cancelled) order item
 * on an un-settled (held) order; otherwise AVAILABLE. Status is DERIVED from the
 * items, never set imperatively — so it can never drift no matter which
 * operation (create / save / add / delete / move / merge / split / settle)
 * touched the items.
 *
 * `reserved` and `out_of_service` are admin/booking overrides and are never
 * auto-flipped.
 *
 * MUST be called on the same `tx` as the order/item mutation that preceded it,
 * so the recompute commits or rolls back atomically with that change.
 *
 * @param tx       a Prisma client or interactive-transaction client
 * @param tableId  the table to recompute (no-op when null/undefined)
 * @returns the resulting status, or `null` when there is no table to update
 */
export async function recomputeTableStatus(
  tx: any,
  tableId?: string | null,
): Promise<'available' | 'occupied' | 'reserved' | 'out_of_service' | null> {
  if (!tableId) return null;

  const table = await tx.posTable.findFirst({ where: { id: tableId } });
  if (!table) return null;
  // Overrides win — a reserved/out-of-service table is not driven by item count.
  if (table.status === 'out_of_service' || table.status === 'reserved') {
    return table.status;
  }

  const activeItems = await tx.orderItem.count({
    where: {
      cancelled: false,
      order: {
        tableId,
        status: { in: TABLE_HELD_ORDER_STATUSES as unknown as string[] },
      },
    },
  });

  const next = activeItems > 0 ? 'occupied' : 'available';
  if (table.status !== next) {
    await tx.posTable.update({ where: { id: tableId }, data: { status: next as any } });
  }
  return next;
}
