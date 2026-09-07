/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { currentPermissions } from '../pricing-policy';
import type { PosOverridesService } from '../pos-overrides.service';

/**
 * Audit #2 N-02 — ONE rule for "may these items leave this order?".
 *
 * The A-016 remediation put the fired-item guard inside `writeItems`, which
 * closed the door a cart edit goes through. It did not close the other doors
 * that reach the same business outcome:
 *
 *   voidItem ................. guarded (pos:void + reason + manager PIN)
 *   writeItems ............... guarded (removal / qty-cut refused)
 *   cancelOrder .............. NOT guarded  ← same outcome, no authority
 *   saveTabItems(lines: []) .. NOT guarded  ← short-circuits before writeItems
 *   transferItems (drain) .... NOT guarded  ← hard-deleted the rows
 *
 * So voiding ONE fired line demanded a manager, while voiding ALL of them by
 * clearing the cart was free: fire → serve → clear → pocket the cash.
 *
 * The governing principle: **if two operations produce the same financial or
 * business outcome, they must not have weaker authorization because they use a
 * different endpoint.** Every path that can drop or reduce a line the kitchen
 * has already committed food to calls into this module.
 */

/** A line the kitchen has already been told to cook. */
export interface FiredLine {
  id: string;
  description: string;
  quantity: number;
  kitchenPrintedQty: number;
}

/** Minimum surface the policy needs from its calling service. */
export interface OrderMutationCtx {
  prisma: any;
  tenant: { userId?: string | null; organizationId: string };
  overrides: PosOverridesService;
}

/** Placeholder reasons that are not a real operator explanation. */
const NON_REASONS = new Set(['', 'order emptied', 'cleared', 'n/a', 'na', '-', 'none', 'test']);

/** True when `reason` is a reason a manager could actually review later. */
export function isMeaningfulReason(reason?: string | null): boolean {
  const r = (reason ?? '').trim();
  return r.length >= 3 && !NON_REASONS.has(r.toLowerCase());
}

/** Active lines on this order that the kitchen has already been sent. */
export async function firedLinesOn(tx: any, orderId: string): Promise<FiredLine[]> {
  const rows = await tx.orderItem.findMany({
    where: { orderId, cancelled: false },
    select: { id: true, description: true, quantity: true, kitchenPrintedQty: true },
    orderBy: { lineNumber: 'asc' },
  });
  return (rows as any[])
    .filter((r) => Number(r.kitchenPrintedQty ?? 0) > 0)
    .map((r) => ({
      id: r.id,
      description: r.description,
      quantity: Number(r.quantity),
      kitchenPrintedQty: Number(r.kitchenPrintedQty ?? 0),
    }));
}

/**
 * The `writeItems` rule, extracted so it reads the same everywhere: a line the
 * kitchen already has may not be removed, and its quantity may not be cut below
 * what was fired. Both must go through `voidItem`.
 */
export function assertNoFiredItemLoss(
  removed: Array<{ description: string; kitchenPrintedQty?: any }>,
  cut: Array<{ description: string }>,
): void {
  const firedRemoved = removed.filter((r) => Number(r.kitchenPrintedQty ?? 0) > 0);
  if (!firedRemoved.length && !cut.length) return;
  const names = [...firedRemoved, ...cut].map((r) => r.description).join(', ');
  throw new ConflictException(
    `Already sent to the kitchen: ${names}. Void the item (reason + manager PIN) instead of removing it.`,
  );
}

export interface CancellationApproval {
  reason?: string | null;
  overrideById?: string;
  overridePin?: string;
}

/**
 * Gate a whole-order cancellation (or any operation that drops every remaining
 * line at once) with exactly the authority `voidItem` demands per line.
 *
 * An order the kitchen never saw cancels freely — nothing has been consumed and
 * demanding a manager for every mis-tap pushes cashiers onto workarounds. The
 * moment food has been committed, the same three things are required as for a
 * single-line void: the `pos:void` right (read LIVE, not from the possibly
 * 12h-stale POS token — A-030), a reason a manager can review, and a
 * transaction-bound manager approval.
 *
 * Returns the fired lines so the caller can name them in its audit row.
 */
export async function assertOrderCancellationAllowed(
  ctx: OrderMutationCtx,
  tx: any,
  orderId: string,
  approval: CancellationApproval = {},
): Promise<FiredLine[]> {
  const fired = await firedLinesOn(tx, orderId);
  if (!fired.length) return fired;

  const names = fired.map((f) => f.description).join(', ');
  const permissions = await currentPermissions(ctx as any, ctx.tenant.userId);
  if (!permissions.includes('pos:void')) {
    throw new ForbiddenException(
      `This order has items the kitchen has already cooked (${names}). Cancelling it requires the void permission.`,
    );
  }
  if (!isMeaningfulReason(approval.reason)) {
    throw new BadRequestException(
      `This order has items the kitchen has already cooked (${names}). Give a reason for cancelling it.`,
    );
  }
  if (!approval.overrideById) {
    throw new ForbiddenException(
      `This order has items the kitchen has already cooked (${names}). A manager approval and PIN are required to cancel it.`,
    );
  }
  await ctx.overrides.verifyOperationApproval(approval.overrideById, approval.overridePin, 'void');
  return fired;
}
