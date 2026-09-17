import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../../kernel/prisma/prisma.service';
import type { StockService } from '../../inventory/stock.service';
import { resolvePosStockLocation } from '../../inventory/pos-stock-location';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logger = new Logger('KitchenWaste');

export interface KitchenWasteLine {
  orderItemId: string;
  /** Quantity the kitchen had already started and that is now lost. */
  quantity: number;
}

/**
 * Food the kitchen had already been sent and that leaves an unpaid order
 * (order cancel or line void) never reaches a sale, so its ingredients were
 * never issued. Record them as `waste` stock moves — Dr waste/adjustment
 * expense, Cr inventory — with the reason and approving manager, so stock on
 * hand matches the kitchen and the loss is visible in the waste report.
 *
 * Runs after the cancellation commits. A waste posting failure is logged and
 * never undoes the cancellation; each line is keyed on its order item and the
 * remaining quantity, so a replay does not double-issue.
 */
export async function recordKitchenWaste(
  deps: { prisma: PrismaService; stock?: StockService },
  organizationId: string,
  orderId: string,
  lines: KitchenWasteLine[],
  context: { reason: string; approvedById?: string | null },
): Promise<void> {
  if (!deps.stock || !lines.length) return;
  const db: any = deps.prisma.client;
  const order = await db.order.findFirst({ where: { id: orderId, organizationId }, select: { orderNumber: true, cashSessionId: true } });
  const session = order?.cashSessionId
    ? await db.cashSession.findFirst({ where: { id: order.cashSessionId, organizationId }, select: { registerLocationId: true } })
    : null;
  const location = await resolvePosStockLocation(deps.prisma, organizationId, undefined, session?.registerLocationId ?? null);
  if (!location) {
    logger.warn(`[waste] no stock location for order ${orderId}; kitchen waste not recorded`);
    return;
  }

  for (const line of lines) {
    if (!(line.quantity > 0)) continue;
    const item = await db.orderItem.findFirst({
      where: { id: line.orderItemId, organizationId },
      select: { id: true, description: true, menuItemId: true, productId: true, variantId: true, quantity: true, voidedQty: true },
    });
    if (!item) continue;
    const sourceId = `${item.id}:${Number(item.voidedQty ?? 0) || line.quantity}`;
    const already = await db.inventoryLedger.count({ where: { organizationId, referenceType: 'pos_kitchen_waste', referenceId: sourceId } });
    if (already) continue;

    const components: Array<{ productId: string; quantity: number; uomId?: string }> = [];
    if (item.menuItemId) {
      const menuItem = await db.menuItem.findFirst({ where: { id: item.menuItemId, organizationId }, select: { isInventoryTracked: true } });
      if (menuItem?.isInventoryTracked === false) continue;
      let multiplier = 1;
      if (item.variantId) {
        const variant = await db.menuItemVariant.findFirst({ where: { id: item.variantId }, select: { qtyMultiplier: true } });
        const m = Number(variant?.qtyMultiplier ?? 1);
        if (Number.isFinite(m) && m > 0) multiplier = m;
      }
      const recipe = await db.menuProduct.findMany({ where: { menuItemId: item.menuItemId, organizationId } });
      for (const r of recipe) components.push({ productId: r.productId, quantity: Number(r.quantity) * line.quantity * multiplier, uomId: r.uomId ?? undefined });
    } else if (item.productId) {
      const product = await db.product.findFirst({ where: { id: item.productId, organizationId }, select: { trackInventory: true } });
      if (product?.trackInventory) components.push({ productId: item.productId, quantity: line.quantity });
    }

    for (const c of components) {
      if (!(c.quantity > 0)) continue;
      try {
        await deps.stock.issue({
          productId: c.productId,
          locationId: location.id,
          quantity: c.quantity,
          uomId: c.uomId,
          moveType: 'waste',
          sourceType: 'pos_kitchen_waste',
          sourceId,
          reference: `Kitchen waste ${order?.orderNumber ?? orderId}`,
          notes: `${item.description} ×${line.quantity} cancelled after kitchen: ${context.reason}`,
          approvedById: context.approvedById ?? null,
        } as any);
      } catch (e: any) {
        logger.warn(`[waste] ${item.description} on ${order?.orderNumber ?? orderId}: ${String(e?.message ?? e)}`);
      }
    }
  }
}
