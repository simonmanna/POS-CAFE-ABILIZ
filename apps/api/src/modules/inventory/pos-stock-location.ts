import type { PrismaService } from '../../kernel/prisma/prisma.service';

/**
 * Resolve the location POS sells stock from. Reads the `pos.stockLocationId`
 * org setting; when unset (or the configured location is inactive/missing),
 * falls back to the first active `warehouse` — behaviour-identical to the
 * legacy hardcoded lookup this replaces. Pass the active `tx` when inside a
 * transaction so the read joins it.
 *
 * This is the single source of truth for "where the till looks for stock", so
 * finished goods from production (which default their output here) and every POS
 * stock read agree even when an operator points POS at a bakery/front-counter
 * location instead of the main warehouse.
 */
export async function resolvePosStockLocation(
  prisma: PrismaService,
  organizationId: string,
  tx?: any,
  preferredLocationId?: string | null,
): Promise<{ id: string; [k: string]: unknown } | null> {
  const setting = await prisma.raw.setting
    .findFirst({
      where: { organizationId, key: 'pos.stockLocationId', scopeType: 'organization' },
      select: { value: true },
    })
    .catch(() => null);
  const configured = setting?.value ? String(setting.value) : '';
  const db = tx ?? prisma.client;
  if (preferredLocationId) {
    const registerLocation = await db.inventoryLocation.findFirst({
      where: { organizationId, id: preferredLocationId, isActive: true, deletedAt: null },
    });
    if (registerLocation) return registerLocation;
    return null;
  }
  if (configured) {
    const loc = await db.inventoryLocation.findFirst({
      where: { organizationId, id: configured, isActive: true },
    });
    if (loc) return loc;
  }
  const candidates = await db.inventoryLocation.findMany({
    where: { organizationId, type: 'warehouse', isActive: true, deletedAt: null },
    orderBy: { code: 'asc' }, take: 2,
  });
  // Never guess between multiple stores: a wrong deduction is worse than a
  // visible posting exception that configuration can repair.
  return candidates.length === 1 ? candidates[0] : null;
}
