/**
 * POS — Menu management service.
 *
 * Customers never order Products directly — they order MenuItems. This service
 * owns the CRUD for `MenuItem`, `MenuProduct` (ingredient links), and
 * `MenuCategory`. The POS terminal's "menu" panel calls `listAvailable()`;
 * the digital-menu public catalog re-uses the same data.
 *
 * Per spec section #1:
 *   - MenuItems are built from one or more Products via MenuProduct.
 *   - Each MenuItem has a basePrice, image, preparationTime, availability flag.
 *   - Categories form a self-referencing tree (parentId).
 *
 * Image handling (P11):
 *   - File IDs are stored permanently in `MenuItem.image` / `MenuCategory.image`.
 *   - Fresh signed download URLs are minted on every read so images never
 *     expire in the UI even though the underlying signed URL TTL is 15 min.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { FilesService } from '../../kernel/files/files.service';
import type { PaginatedResult, PaginationQuery } from '@erp/shared';
import { AuditService } from '../../kernel/audit/audit.service';

export interface MenuItemBundle {
  product: {
    id: string;
    name: string;
    unitPrice: number;
    sku: string | null;
    productType: string;
  };
  variants: Array<{
    id: string;
    name: string;
    price: number;
    sortOrder: number;
  }>;
  accompanimentGroups: Array<{
    id: string;
    name: string;
    isRequired: boolean;
    minSelect: number;
    maxSelect: number;
    sortOrder: number;
    options: Array<{
      id: string;
      name: string;
      priceImpact: number;
      isDefault: boolean;
      sortOrder: number;
    }>;
  }>;
  groups: Array<{
    id: string;
    name: string;
    groupType: 'ADD_ON' | 'MODIFIER';
    minSelect: number;
    maxSelect: number;
    sortOrder: number;
    modifiers: Array<{
      id: string;
      name: string;
      priceDelta: number;
      isDefault: boolean;
      sortOrder: number;
    }>;
  }>;
}

@Injectable()
export class PosMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  /** Convert a stored value to a fresh signed download URL.
   *
   *  Accepted formats in `image` column:
   *   - A file ID (UUID) → mint a new signed URL via FilesService.
   *   - A full signed URL `/api/v1/files/{id}/download?token=…&expires=…` →
   *     extract the ID and mint a fresh URL (expired tokens no longer block
   *     the image in the UI).
   *   - An absolute URL (http/https) → return as-is.
   *   - null/empty → null.
   */
  private resolveImage(image: string | null | undefined): string | null {
    if (!image) return null;
    if (image.startsWith('http')) return image;
    // Extract file ID from a stored URL, or accept a bare UUID directly
    const idMatch = image.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (!idMatch) return image; // not a recognised format — pass through
    try {
      return this.files.signDownload(idMatch[1]).url;
    } catch {
      return null;
    }
  }

  // ───────────────────────── Categories ─────────────────────────

  listCategories() {
    return this.prisma.client.menuCategory.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(input: {
    name: string;
    parentId?: string;
    image?: string;
    icon?: string;
    displayOrder?: number;
  }) {
    return this.prisma.client.$transaction(async (tx) => {
      const created = await tx.menuCategory.create({ data: {
        organizationId: this.tenant.organizationId,
        name: input.name,
        parentId: input.parentId,
        image: input.image,
        icon: input.icon,
        displayOrder: input.displayOrder ?? 0,
        createdBy: this.tenant.userId ?? null,
        updatedBy: this.tenant.userId ?? null,
      } });
      await this.audit.recordInTx(tx, { entity: 'MenuCategory', entityId: created.id, action: 'create', newValues: created });
      return created;
    });
  }

  async updateCategory(id: string, data: { name?: string; displayOrder?: number; image?: string; icon?: string }) {
    const existing = await this.prisma.client.menuCategory.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException(`MenuCategory ${id} not found`);
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.menuCategory.update({ where: { id }, data: { ...data, updatedBy: this.tenant.userId ?? null } });
      await this.audit.recordInTx(tx, { entity: 'MenuCategory', entityId: id, action: 'update', oldValues: existing, newValues: updated });
      return updated;
    });
  }

  async deleteCategory(id: string) {
    const existing = await this.prisma.client.menuCategory.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException(`MenuCategory ${id} not found`);
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.menuCategory.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, updatedBy: this.tenant.userId ?? null } });
      await this.audit.recordInTx(tx, { entity: 'MenuCategory', entityId: id, action: 'delete', oldValues: existing, newValues: updated });
      return updated;
    });
  }

  async restoreCategory(id: string) {
    const existing = await this.prisma.client.menuCategory.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!existing) throw new NotFoundException(`Deleted MenuCategory ${id} not found`);
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.menuCategory.update({ where: { id }, data: { deletedAt: null, isActive: true, updatedBy: this.tenant.userId ?? null } });
      await this.audit.recordInTx(tx, { entity: 'MenuCategory', entityId: id, action: 'restore' as any, oldValues: existing, newValues: updated });
      return updated;
    });
  }

  listDeletedCategories() {
    return this.prisma.client.menuCategory.findMany({
      where: { deletedAt: { not: null } },
      orderBy: [{ deletedAt: 'desc' }],
    });
  }

  // ─────────────────────────── Items ────────────────────────────

  /** The POS terminal calls this on load. Returns the menu grouped by category,
     *  filtered to available items only. Ingredient links are included so the
     *  KDS can show "uses: Espresso, Milk" and the cashier can show stock hint. */
    async listAvailable() {
      const cats = await this.prisma.client.menuCategory.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      });
      const items = await this.prisma.client.menuItem.findMany({
        where: { isAvailable: true, deletedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      });
      return {
        categories: cats.map((c) => ({ ...c, image: this.resolveImage(c.image) })),
        items: items.map((it) => ({ ...it, image: this.resolveImage(it.image) })),
      };
    }

    async listAll(query: PaginationQuery & { categoryId?: string }): Promise<PaginatedResult<any> & { meta: PaginatedResult<any>['meta'] & { availableCount: number; avgPrice: number | null; categoryCounts: Record<string, number> } }> {
        const page = Math.max(1, Number(query.page ?? 1));
        const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
        const where: any = { deletedAt: null };
        if (query.search) {
          where.OR = [
            { name: { contains: query.search, mode: 'insensitive' } },
            { code: { contains: query.search, mode: 'insensitive' } },
            { description: { contains: query.search, mode: 'insensitive' } },
          ];
        }
        const categoryCountWhere = { ...where };
        if (query.categoryId) where.categoryId = query.categoryId;
        const orderBy = query.sortBy
          ? { [query.sortBy]: query.sortOrder ?? 'asc' as const }
          : [{ displayOrder: 'asc' as const }, { name: 'asc' as const }];
        const [data, total, stats, availableCount, categoryGroups] = await Promise.all([
          this.prisma.client.menuItem.findMany({
            where, orderBy, skip: (page - 1) * pageSize, take: pageSize,
            include: {
              category: true,
              ingredients: { include: { product: { select: { id: true, code: true, name: true, station: true } } } },
            },
          }),
          this.prisma.client.menuItem.count({ where }),
          this.prisma.client.menuItem.aggregate({ where, _count: { _all: true }, _avg: { basePrice: true } }),
          this.prisma.client.menuItem.count({ where: { ...where, isAvailable: true } }),
          this.prisma.client.menuItem.groupBy({ by: ['categoryId'], where: categoryCountWhere, _count: { _all: true } }),
        ]);
        const categoryCounts = Object.fromEntries((categoryGroups as any[]).filter((row) => row.categoryId).map((row) => [row.categoryId, row._count._all]));
        return {
          data: data.map((it) => ({ ...it, image: this.resolveImage(it.image) })),
          meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), availableCount, avgPrice: stats._avg.basePrice == null ? null : Number(stats._avg.basePrice), categoryCounts },
        };
      }

      async getOne(id: string) {
        const item = await this.prisma.client.menuItem.findFirst({
          where: { id, deletedAt: null },
          include: { ingredients: { include: { product: true } }, category: true },
        });
        if (!item) throw new NotFoundException(`MenuItem ${id} not found`);
        return { ...item, image: this.resolveImage(item.image) };
      }

  async create(input: {
    code?: string;
    name: string;
    description?: string;
    categoryId?: string;
    basePrice?: number;
    isInventoryTracked?: boolean;
    image?: string;
    preparationTime?: number;
    /// Optional KitchenStation.code. Set = this item is prepared at that station
    /// and routes straight to its KDS screen when ordered.
    stationCode?: string | null;
    isAvailable?: boolean;
    displayOrder?: number;
    ingredients?: { productId: string; quantity?: number }[];
  }) {
    const tracked = input.isInventoryTracked !== false;
    const ingredients = this.validateIngredients(input.ingredients ?? [], tracked);
    const stationCode = await this.normalizeStationCode(input.stationCode);
    return this.prisma.client.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: {
          organizationId: this.tenant.organizationId,
          code: input.code,
          name: input.name,
          description: input.description,
          categoryId: input.categoryId,
          basePrice: input.basePrice ?? null,
          isInventoryTracked: tracked,
          image: input.image,
          preparationTime: input.preparationTime ?? null,
          stationCode,
          isAvailable: input.isAvailable ?? true,
          displayOrder: input.displayOrder ?? 0,
        },
      });
      for (const ing of ingredients) {
        await tx.menuProduct.create({
          data: {
            organizationId: this.tenant.organizationId,
            menuItemId: item.id,
            productId: ing.productId,
            quantity: ing.quantity ?? 1,
          },
        });
      }
      const created = await tx.menuItem.findUniqueOrThrow({
        where: { id: item.id },
        include: { ingredients: { include: { product: true } }, category: true },
      });
      await this.audit.recordInTx(tx, { entity: 'MenuItem', entityId: item.id, action: 'create', newValues: created });
      return created;
    });
  }

  async update(id: string, patch: Partial<{
    code: string;
    name: string;
    description: string;
    categoryId: string | null;
    basePrice: number | null;
    isInventoryTracked: boolean;
    image: string | null;
    preparationTime: number | null;
    stationCode: string | null;
    isAvailable: boolean;
    displayOrder: number;
    ingredients: { productId: string; quantity?: number }[];
    expectedUpdatedAt: string;
  }>) {
    const { ingredients, isInventoryTracked, expectedUpdatedAt, ...data } = patch;
    if ('stationCode' in data) data.stationCode = await this.normalizeStationCode(data.stationCode);
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM "MenuItem" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', id, this.tenant.organizationId);
      const existing = await tx.menuItem.findFirst({ where: { id, deletedAt: null }, include: { ingredients: true } });
      if (!existing) throw new NotFoundException(`MenuItem ${id} not found`);
      if (expectedUpdatedAt && existing.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
        throw new ConflictException('This menu item was changed by another user. Refresh it and apply your changes again.');
      }
      const tracked = isInventoryTracked ?? existing.isInventoryTracked;
      const normalizedIngredients = ingredients === undefined
        ? existing.ingredients.map((ing) => ({ productId: ing.productId, quantity: Number(ing.quantity) }))
        : this.validateIngredients(ingredients, tracked);
      if (tracked && normalizedIngredients.length === 0) throw new BadRequestException('Inventory-tracked menu items require at least one recipe ingredient');
      if (data && Object.keys(data).length > 0) {
        await tx.menuItem.update({ where: { id }, data: { ...data, ...(isInventoryTracked !== undefined ? { isInventoryTracked: tracked } : {}) } });
      }
      if (ingredients) {
        await tx.menuProduct.deleteMany({ where: { menuItemId: id } });
        for (const ing of normalizedIngredients) {
          await tx.menuProduct.create({
            data: {
              organizationId: this.tenant.organizationId,
              menuItemId: id,
              productId: ing.productId,
              quantity: ing.quantity ?? 1,
            },
          });
        }
      }
      const updated = await tx.menuItem.findUniqueOrThrow({
        where: { id },
        include: { ingredients: { include: { product: true } }, category: true },
      });
      await this.audit.recordInTx(tx, { entity: 'MenuItem', entityId: id, action: 'update', oldValues: existing, newValues: updated });
      return updated;
    });
  }

  private validateIngredients(
    ingredients: Array<{ productId: string; quantity?: number }>,
    tracked: boolean,
  ): Array<{ productId: string; quantity: number }> {
    if (tracked && ingredients.length === 0) throw new BadRequestException('Inventory-tracked menu items require at least one recipe ingredient');
    const seen = new Set<string>();
    return ingredients.map((ingredient) => {
      const quantity = ingredient.quantity ?? 1;
      if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('Recipe ingredient quantities must be greater than zero');
      if (seen.has(ingredient.productId)) throw new BadRequestException('A product can appear only once in a menu recipe');
      seen.add(ingredient.productId);
      return { productId: ingredient.productId, quantity };
    });
  }

  /**
   * Validate the optional prep-station override. Empty string / null clears it
   * (the station is then derived from the recipe, as before). A non-empty code
   * must match a live `KitchenStation` for the org, so a typo can never route an
   * order to a screen nobody is watching.
   *
   * KitchenStation is tenant-isolated by a policy that reads `app.org_id`, which
   * is only set inside `$transaction` — hence the wrapper.
   */
  private async normalizeStationCode(code: string | null | undefined): Promise<string | null> {
    if (code === undefined) return null;
    const trimmed = (code ?? '').trim();
    if (!trimmed) return null;
    const station = (await this.prisma.client.$transaction((tx: any) =>
      tx.kitchenStation.findFirst({ where: { code: trimmed, deletedAt: null }, select: { code: true, isActive: true } }),
    )) as { code: string; isActive: boolean } | null;
    if (!station) throw new BadRequestException(`Unknown kitchen station "${trimmed}"`);
    if (!station.isActive) throw new BadRequestException(`Kitchen station "${trimmed}" is inactive`);
    return station.code;
  }

  async setAvailability(id: string, isAvailable: boolean) {
    return this.auditItemMutation(id, 'update', { isAvailable });
  }
  /** Soft disable — just sets isAvailable=false (keeps history intact). */
    async disable(id: string) {
      return this.auditItemMutation(id, 'update', { isAvailable: false });
    }

    /** Soft delete — sets deletedAt and isAvailable=false. */
    async deleteItem(id: string) {
      const existing = await this.prisma.client.menuItem.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException(`MenuItem ${id} not found`);
      return this.auditItemMutation(id, 'delete', { deletedAt: new Date(), isAvailable: false });
    }

    /** Restore a soft-deleted menu item. */
    async restoreItem(id: string) {
      const existing = await this.prisma.client.menuItem.findFirst({ where: { id, deletedAt: { not: null } } });
      if (!existing) throw new NotFoundException(`Deleted MenuItem ${id} not found`);
      return this.auditItemMutation(id, 'restore' as any, { deletedAt: null, isAvailable: true }, true);
    }

    /** List all soft-deleted menu items. */
    listDeletedItems() {
      return this.prisma.client.menuItem.findMany({
        where: { deletedAt: { not: null } },
        orderBy: [{ deletedAt: 'desc' }],
      });
    }

    private async auditItemMutation(id: string, action: any, data: Record<string, unknown>, includeDeleted = false) {
      return this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.menuItem.findFirst({ where: { id, ...(includeDeleted ? {} : { deletedAt: null }) } });
        if (!existing) throw new NotFoundException(`MenuItem ${id} not found`);
        const updated = await tx.menuItem.update({ where: { id }, data });
        await this.audit.recordInTx(tx, { entity: 'MenuItem', entityId: id, action, oldValues: existing, newValues: updated });
        return updated;
      });
    }

    /* ====================== Full bundle (POS terminal) ====================== */

  /**
   * Returns the complete configuration for a menu item: variants, accompaniment
   * groups, and modifier groups (add-ons + modifiers). The POS terminal uses
   * this single response to drive the full 4-step order flow.
   */
  async getFullBundle(menuItemId: string): Promise<MenuItemBundle | null> {
    const orgId = this.tenant.organizationId;
    const item = await this.prisma.client.menuItem.findFirst({
      where: { id: menuItemId, organizationId: orgId },
    });
    if (!item) return null;

    // Variants
    const variants = await this.prisma.client.menuItemVariant.findMany({
      where: { organizationId: orgId, menuItemId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    // Accompaniment groups + options (via join table)
    const accLinks = await this.prisma.client.menuItemAccompanimentGroup.findMany({
      where: { menuItemId, menuItem: { organizationId: orgId } },
      orderBy: { sortOrder: 'asc' },
      include: {
        accompanimentGroup: {
          include: { options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    const accGroups = (accLinks as any[])
      .filter((l: any) => l.accompanimentGroup && l.accompanimentGroup.isActive)
      .map((l: any) => l.accompanimentGroup);

    // Modifier groups + modifiers
    const links = await this.prisma.client.menuItemModifierGroup.findMany({
      where: { menuItemId, organizationId: orgId },
      orderBy: { sortOrder: 'asc' },
      include: {
        modifierGroup: {
          include: { modifiers: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
        },
      },
    });

    const groups = (links as any[])
      .filter((l: any) => l.modifierGroup && l.modifierGroup.isActive)
      .map((l: any) => ({
        id: l.modifierGroup.id,
        name: l.modifierGroup.name,
        groupType: (l.modifierGroup.groupType ?? 'ADD_ON') as 'ADD_ON' | 'MODIFIER',
        minSelect: l.modifierGroup.minSelect,
        maxSelect: l.modifierGroup.maxSelect,
        sortOrder: l.sortOrder,
        modifiers: l.modifierGroup.modifiers.map((m: any) => ({
          id: m.id,
          name: m.name,
          priceDelta: Number(m.priceDelta),
          isDefault: m.isDefault,
          sortOrder: m.sortOrder,
        })),
      }));

    return {
      product: {
        id: (item as any).id,
        name: (item as any).name,
        unitPrice: Number((item as any).basePrice ?? 0),
        sku: (item as any).code ?? null,
        productType: 'menu',
      },
      variants: (variants as any[]).map((v) => ({
        id: v.id,
        name: v.name,
        price: Number(v.price),
        sortOrder: v.sortOrder,
      })),
      accompanimentGroups: (accGroups as any[]).map((g) => ({
        id: g.id,
        name: g.name,
        isRequired: g.isRequired,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        sortOrder: g.sortOrder,
        options: g.options.map((o: any) => ({
          id: o.id,
          name: o.name,
          priceImpact: Number(o.priceImpact),
          isDefault: o.isDefault,
          sortOrder: o.sortOrder,
        })),
      })),
      groups,
    };
  }
}
