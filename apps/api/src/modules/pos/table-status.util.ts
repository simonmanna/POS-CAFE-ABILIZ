/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Order statuses that "hold" a dine-in table (an order in one of these states,
 * with at least one active item, keeps the table OCCUPIED). `completed` is the
 * billed-but-unpaid state — the customer has the bill but hasn't paid, so the
 * table stays held until the invoice settles and the order goes `closed`.
 * `closed` / `cancelled` release the table.
 *
 * The legacy tail (`open`/`preparing`/`ready`/`served`) is retained ONLY for the
 * Android wire-compat window: a device that pushed an order while running an old
 * APK can still have written a legacy status, and such a table must not silently
 * read as available. Drop the tail together with the enum values in the cleanup
 * migration.
 *
 * This is the single source of truth — import it rather than re-listing the
 * statuses inline.
 */
export const TABLE_HELD_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'in_progress',
  'completed',
  // legacy, compat window only
  'open',
  'preparing',
  'ready',
  'served',
] as const;

/**
 * Prisma `where` for an order that is still open on the floor: a held status,
 * not yet billed, with at least one live item. The Orders panel, the floor map
 * and the shift-close gate all use this one predicate, so they never disagree
 * about how many orders are open.
 */
export function heldOrderWhere(organizationId: string) {
  return {
    organizationId,
    status: { in: TABLE_HELD_ORDER_STATUSES as unknown as string[] },
    invoiceId: null,
    items: { some: { cancelled: false } },
  } as any;
}

/**
 * Floor-close lock. Every write that puts live items on an order takes it
 * SHARED (writers never block each other); a shift close takes it EXCLUSIVE
 * before counting open orders. So no order can gain items between the close's
 * open-order check and its commit. Transaction-scoped: released on commit.
 */
export async function lockFloorShared(tx: any, organizationId: string): Promise<void> {
  // Unit-test doubles have no raw SQL; a real client always does.
  if (typeof tx?.$queryRawUnsafe !== 'function') return;
  await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1))::text`, `pos-floor-close:${organizationId}`);
}

export async function lockFloorExclusive(tx: any, organizationId: string): Promise<void> {
  if (typeof tx?.$queryRawUnsafe !== 'function') return;
  await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`, `pos-floor-close:${organizationId}`);
}

/** True when `status` keeps a dine-in table held. Accepts legacy values. */
export function isTableHeldOrderStatus(status: string | null | undefined): boolean {
  return !!status && (TABLE_HELD_ORDER_STATUSES as readonly string[]).includes(status);
}

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
  opts: { dirtyOnRelease?: boolean } = {},
): Promise<'available' | 'occupied' | 'reserved' | 'out_of_service' | 'cleaning' | null> {
  if (!tableId) return null;

  const table = await tx.posTable.findFirst({ where: { id: tableId } });
  if (!table) return null;
  // Overrides win — these statuses are not driven by item count.
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

  // Audit#2 N-09 — `cleaning` used to short-circuit above, alongside the manual
  // overrides, so the moment a table went dirty its status stopped being derived
  // at all. Seat a new party on a cleaning table and it kept reading "cleaning"
  // while holding a live order; have the busser mark it clean and it read
  // "available" while holding one, and the host then met a 409 on a table the
  // floor map showed as free.
  //
  // Cleaning is not an override — it is a state a table LEAVES when work
  // arrives. Live items win; an empty dirty table stays dirty until someone
  // clears it.
  if (table.status === 'cleaning' && activeItems === 0) return 'cleaning';

  let next: 'available' | 'occupied' | 'cleaning' = activeItems > 0 ? 'occupied' : 'available';
  // Audit F-06 — a settled table needs bussing before the next party sits down.
  // The cleaning flip used to live in PosTablesService.closeTableOrder, which
  // runs AFTER the payment transaction has already recomputed the table to
  // 'available' — so its `existing.status === 'occupied'` guard could never be
  // true and the whole cleaning workflow was dead code. The transition is only
  // observable here, inside the same transaction that releases the table, so
  // this is where settlement asks for it.
  if (opts.dirtyOnRelease && next === 'available' && table.status === 'occupied') {
    next = 'cleaning';
  }
  if (table.status !== next) {
    await tx.posTable.update({ where: { id: tableId }, data: { status: next as any } });
  }
  return next;
}
