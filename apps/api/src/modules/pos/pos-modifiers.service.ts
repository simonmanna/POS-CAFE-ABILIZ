/**
 * POS P4 — Modifiers + Combos service.
 *
 * Exposes CRUD for ModifierGroup / Modifier / Combo / ComboItem, plus the
 * "get everything a product needs" helper used by the terminal AddOns
 * dialog and the menu grid (combo button).
 *
 * Modifiers are an M-N between Product and ModifierGroup. When a cashier
 * taps a product, the terminal fetches the groups + modifiers via
 * `getProductBundle(productId)` and opens the AddOns dialog if the product
 * has any required groups.
 *
 * Combos are sold as a single line item on the receipt (price fixed), but
 * at checkout time pos.service expands them into one DocumentLine per
 * ComboItem so inventory still decrements per-component.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

export interface ModifierGroupWithModifiers {
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
}

export interface ProductBundle {
  product: { id: string; name: string; unitPrice: number; sku: string | null; productType: string };
  groups: ModifierGroupWithModifiers[];
}

export interface ComboWithItems {
  id: string;
  name: string;
  price: number;
  description: string | null;
  imageUrl: string | null;
  items: Array<{ productId: string; productName: string; quantity: number }>;
}

@Injectable()
export class PosModifiersService {
  private readonly logger = new Logger('PosModifiersService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /* ====================== Modifier groups ====================== */

  async listGroups(): Promise<ModifierGroupWithModifiers[]> {
    const orgId = this.tenant.organizationId;
    const groups = await this.prisma.client.modifierGroup.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        modifiers: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    return (groups as any[]).map((g) => ({
      id: g.id,
      name: g.name,
      groupType: g.groupType ?? 'ADD_ON',
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      sortOrder: g.sortOrder,
      modifiers: g.modifiers.map((m: any) => ({
        id: m.id, name: m.name, priceDelta: Number(m.priceDelta), isDefault: m.isDefault, sortOrder: m.sortOrder,
      })),
    }));
  }

  async createGroup(dto: { name: string; groupType?: 'ADD_ON' | 'MODIFIER'; minSelect?: number; maxSelect?: number; sortOrder?: number }): Promise<any> {
    const orgId = this.tenant.organizationId;
    if (!dto.name?.trim()) throw new BadRequestException('Group name is required');
    if (dto.groupType && !['ADD_ON', 'MODIFIER'].includes(dto.groupType)) {
      throw new BadRequestException('groupType must be ADD_ON or MODIFIER');
    }
    return this.prisma.client.modifierGroup.create({
      data: {
        organizationId: orgId,
        name: dto.name.trim(),
        groupType: dto.groupType ?? 'ADD_ON',
        minSelect: dto.minSelect ?? 0,
        maxSelect: dto.maxSelect ?? 1,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async createModifier(dto: { groupId: string; name: string; priceDelta?: number; isDefault?: boolean; sortOrder?: number }): Promise<any> {
    if (!dto.name?.trim()) throw new BadRequestException('Modifier name is required');
    const orgId = this.tenant.organizationId;
    const group = await this.prisma.client.modifierGroup.findFirst({ where: { id: dto.groupId, organizationId: orgId } });
    if (!group) throw new NotFoundException('Modifier group not found');
    return this.prisma.client.modifier.create({
      data: {
        organizationId: orgId,
        groupId: dto.groupId,
        name: dto.name.trim(),
        priceDelta: dto.priceDelta ?? 0,
        isDefault: dto.isDefault ?? false,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  /* ====================== Product ↔ groups ====================== */

  async getProductBundle(productId: string): Promise<ProductBundle | null> {
    const orgId = this.tenant.organizationId;
    const product = await this.prisma.client.product.findFirst({
      where: { id: productId, organizationId: orgId, isActive: true },
    });
    if (!product) return null;
    const links = await this.prisma.client.productModifierGroup.findMany({
      where: { productId, organizationId: orgId },
      orderBy: { sortOrder: 'asc' },
      include: {
        modifierGroup: {
          include: {
            modifiers: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });
    const groups: ModifierGroupWithModifiers[] = (links as any[])
      .filter((l) => l.modifierGroup && l.modifierGroup.isActive)
      .map((l) => ({
        id: l.modifierGroup.id,
        name: l.modifierGroup.name,
        groupType: l.modifierGroup.groupType ?? 'ADD_ON',
        minSelect: l.modifierGroup.minSelect,
        maxSelect: l.modifierGroup.maxSelect,
        sortOrder: l.sortOrder,
        modifiers: l.modifierGroup.modifiers.map((m: any) => ({
          id: m.id, name: m.name, priceDelta: Number(m.priceDelta), isDefault: m.isDefault, sortOrder: m.sortOrder,
        })),
      }));
    return {
      product: {
        id: (product as any).id,
        name: (product as any).name,
        unitPrice: Number((product as any).salesPrice ?? 0),
        sku: (product as any).sku ?? null,
        productType: (product as any).productType,
      },
      groups,
    };
  }

  /* ====================== Menu-item modifiers (MENU) ====================== */

  /** A sellable menu item + its modifier groups (same shape as a product bundle). */
  async getMenuItemBundle(menuItemId: string): Promise<ProductBundle | null> {
    const orgId = this.tenant.organizationId;
    const item = await this.prisma.client.menuItem.findFirst({ where: { id: menuItemId, organizationId: orgId } });
    if (!item) return null;
    const links = await this.prisma.client.menuItemModifierGroup.findMany({
      where: { menuItemId, organizationId: orgId },
      orderBy: { sortOrder: 'asc' },
      include: {
        modifierGroup: { include: { modifiers: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } } },
      },
    });
    const groups: ModifierGroupWithModifiers[] = (links as any[])
      .filter((l) => l.modifierGroup && l.modifierGroup.isActive)
      .map((l) => ({
        id: l.modifierGroup.id,
        name: l.modifierGroup.name,
        groupType: l.modifierGroup.groupType ?? 'ADD_ON',
        minSelect: l.modifierGroup.minSelect,
        maxSelect: l.modifierGroup.maxSelect,
        sortOrder: l.sortOrder,
        modifiers: l.modifierGroup.modifiers.map((m: any) => ({
          id: m.id, name: m.name, priceDelta: Number(m.priceDelta), isDefault: m.isDefault, sortOrder: m.sortOrder,
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
      groups,
    };
  }

  async assignGroupToMenuItem(menuItemId: string, modifierGroupId: string, sortOrder = 0): Promise<void> {
    const orgId = this.tenant.organizationId;
    const [m, g] = await Promise.all([
      this.prisma.client.menuItem.findFirst({ where: { id: menuItemId, organizationId: orgId } }),
      this.prisma.client.modifierGroup.findFirst({ where: { id: modifierGroupId, organizationId: orgId } }),
    ]);
    if (!m || !g) throw new NotFoundException('Menu item or modifier group not found');
    await this.prisma.client.menuItemModifierGroup.upsert({
      where: { menuItemId_modifierGroupId: { menuItemId, modifierGroupId } },
      update: { sortOrder },
      create: { organizationId: orgId, menuItemId, modifierGroupId, sortOrder },
    });
  }

  async unassignGroupFromMenuItem(menuItemId: string, modifierGroupId: string): Promise<void> {
    await this.prisma.client.menuItemModifierGroup.deleteMany({
      where: { menuItemId, modifierGroupId, organizationId: this.tenant.organizationId },
    });
  }

  async validateMenuItemModifiers(menuItemId: string, selectedModifierIds: string[]): Promise<void> {
    const bundle = await this.getMenuItemBundle(menuItemId);
    if (!bundle || bundle.groups.length === 0) return;
    this.warnOnModifierRules(bundle, selectedModifierIds);
  }

  /**
   * M-B — server-side check of a product's modifier rules. NON-BLOCKING: an
   * unmet "required" group or an over-max pick is logged, never thrown, so the
   * sale is never stopped (on-site POS rule). Price/anti-tamper is still
   * enforced separately in `resolveSelectedModifiers`.
   */
  async validateProductModifiers(productId: string, selectedModifierIds: string[]): Promise<void> {
    const bundle = await this.getProductBundle(productId);
    if (!bundle || bundle.groups.length === 0) return;
    this.warnOnModifierRules(bundle, selectedModifierIds);
  }

  private warnOnModifierRules(bundle: any, selectedModifierIds: string[]): void {
    const selected = new Set(selectedModifierIds);
    for (const g of bundle.groups) {
      const inGroup = g.modifiers.reduce((n: number, m: any) => (selected.has(m.id) ? n + 1 : n), 0);
      if (inGroup < g.minSelect) {
        this.logger.warn(`[modifier] "${bundle.product.name}" group "${g.name}" min ${g.minSelect}, got ${inGroup} — allowed through.`);
      }
      if (g.maxSelect > 0 && inGroup > g.maxSelect) {
        this.logger.warn(`[modifier] "${bundle.product.name}" group "${g.name}" max ${g.maxSelect}, got ${inGroup} — allowed through.`);
      }
    }
  }

  /** Validate every line's modifier selection against its menu item / product rules. */
  async validateSelections(
    lines: Array<{ productId?: string | null; menuItemId?: string | null; modifiers?: Array<{ modifierId: string }> }>,
  ): Promise<void> {
    for (const l of lines) {
      const ids = (l.modifiers ?? []).map((m) => m.modifierId);
      if (l.menuItemId) await this.validateMenuItemModifiers(l.menuItemId, ids);
      else if (l.productId) await this.validateProductModifiers(l.productId, ids);
    }
  }

  /**
   * Resolve a line's selected modifiers to DB-authoritative {name, priceDelta},
   * rejecting any id that isn't an active modifier on this item's groups. The
   * sell path MUST use this instead of trusting the client-sent priceDelta —
   * otherwise a crafted request could book an arbitrary add-on price to the GL,
   * and an admin price change wouldn't apply to a stale cart. Input order +
   * duplicates (one entry per add-on unit) are preserved so qty math holds.
   */
  async resolveSelectedModifiers(opts: {
    menuItemId?: string | null;
    productId?: string | null;
    modifierIds: string[];
  }): Promise<Array<{ modifierId: string; name: string; priceDelta: number }>> {
    if (!opts.modifierIds?.length) return [];
    const bundle = opts.menuItemId
      ? await this.getMenuItemBundle(opts.menuItemId)
      : opts.productId
        ? await this.getProductBundle(opts.productId)
        : null;
    if (!bundle) {
      // No modifier config (e.g. item changed since the cart was built) — drop
      // the add-ons rather than block the sale. Prices are never client-trusted.
      this.logger.warn(`[modifier] no config for item; ignoring ${opts.modifierIds.length} selected modifier(s).`);
      return [];
    }
    const allowed = new Map<string, { name: string; priceDelta: number }>();
    for (const g of bundle.groups) {
      for (const m of g.modifiers) allowed.set(m.id, { name: m.name, priceDelta: Number(m.priceDelta) });
    }
    // Anti-tamper: prices come from the DB, never the client. Unknown / deleted
    // / deactivated ids are dropped (logged) instead of rejected so a stale cart
    // still rings up — they simply aren't charged.
    return opts.modifierIds
      .map((id) => {
        const m = allowed.get(id);
        if (!m) { this.logger.warn(`[modifier] "${id}" not available for "${bundle.product.name}" — ignored.`); return null; }
        return { modifierId: id, name: m.name, priceDelta: m.priceDelta };
      })
      .filter((m): m is { modifierId: string; name: string; priceDelta: number } => m !== null);
  }

  async assignGroupToProduct(productId: string, modifierGroupId: string, sortOrder = 0): Promise<void> {
    const orgId = this.tenant.organizationId;
    const [p, g] = await Promise.all([
      this.prisma.client.product.findFirst({ where: { id: productId, organizationId: orgId } }),
      this.prisma.client.modifierGroup.findFirst({ where: { id: modifierGroupId, organizationId: orgId } }),
    ]);
    if (!p || !g) throw new NotFoundException('Product or modifier group not found');
    await this.prisma.client.productModifierGroup.upsert({
      where: { productId_modifierGroupId: { productId, modifierGroupId } },
      update: { sortOrder },
      create: { organizationId: orgId, productId, modifierGroupId, sortOrder },
    });
  }

  /* ====================== Edit / delete (M-E) ====================== */

  async updateGroup(id: string, dto: { name?: string; groupType?: 'ADD_ON' | 'MODIFIER'; minSelect?: number; maxSelect?: number; isActive?: boolean; expectedVersion?: number }): Promise<any> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.modifierGroup.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Modifier group not found');
    if (dto.groupType && !['ADD_ON', 'MODIFIER'].includes(dto.groupType)) {
      throw new BadRequestException('groupType must be ADD_ON or MODIFIER');
    }
    const data: any = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.groupType !== undefined ? { groupType: dto.groupType } : {}),
      ...(dto.minSelect !== undefined ? { minSelect: dto.minSelect } : {}),
      ...(dto.maxSelect !== undefined ? { maxSelect: dto.maxSelect } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      version: { increment: 1 },
    };
    if (dto.expectedVersion !== undefined) {
      const result = await this.prisma.client.modifierGroup.updateMany({
        where: { id, version: dto.expectedVersion, organizationId: orgId },
        data,
      });
      if (result.count === 0) {
        throw new ConflictException('This modifier group was modified by another user. Please reload and try again.');
      }
      return this.prisma.client.modifierGroup.findFirst({ where: { id, organizationId: orgId } });
    }
    return this.prisma.client.modifierGroup.update({ where: { id }, data });
  }

  async deleteGroup(id: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.modifierGroup.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Modifier group not found');
    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.productModifierGroup.deleteMany({ where: { modifierGroupId: id } });
      await tx.modifierGroup.delete({ where: { id } }); // options cascade via FK
    });
  }

  async updateModifier(id: string, dto: { name?: string; priceDelta?: number; isDefault?: boolean; isActive?: boolean }): Promise<any> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.modifier.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Modifier not found');
    return this.prisma.client.modifier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.priceDelta !== undefined ? { priceDelta: dto.priceDelta } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async deleteModifier(id: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.modifier.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Modifier not found');
    await this.prisma.client.modifier.delete({ where: { id } });
  }

  async unassignGroupFromProduct(productId: string, modifierGroupId: string): Promise<void> {
    await this.prisma.client.productModifierGroup.deleteMany({
      where: { productId, modifierGroupId, organizationId: this.tenant.organizationId },
    });
  }

  /**
   * M-F — modifier/add-on sales report: count + add-on revenue per modifier name
   * over a date window, for SOLD (posted/paid) sales only. Reads the M-D
   * DocumentLineModifier rows, so it's empty until that migration is applied.
   */
  async modifierSalesReport(from?: string, to?: string): Promise<Array<{ name: string; count: number; revenue: number }>> {
    const orgId = this.tenant.organizationId;
    const dateFilter = from || to
      ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
      : {};
    const rows = await this.prisma.client.documentLineModifier.findMany({
      where: {
        organizationId: orgId,
        documentLine: { document: { status: { in: ['posted', 'paid'] } } },
        ...dateFilter,
      },
      select: { name: true, priceDelta: true },
    });
    const map = new Map<string, { name: string; count: number; revenue: number }>();
    for (const r of rows as any[]) {
      const cur = map.get(r.name) ?? { name: r.name, count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += Number(r.priceDelta);
      map.set(r.name, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  /* ====================== Combos ====================== */

  async listCombos(): Promise<ComboWithItems[]> {
    const orgId = this.tenant.organizationId;
    const combos = await this.prisma.client.combo.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          include: { product: true },
        },
      },
    });
    return (combos as any[]).map((c) => ({
      id: c.id,
      name: c.name,
      price: Number(c.price),
      description: c.description,
      imageUrl: c.imageUrl,
      items: c.items.map((it: any) => ({
        productId: it.productId,
        productName: it.product?.name ?? '?',
        quantity: it.quantity,
      })),
    }));
  }

  async getCombo(comboId: string): Promise<ComboWithItems | null> {
    const orgId = this.tenant.organizationId;
    const c = await this.prisma.client.combo.findFirst({
      where: { id: comboId, organizationId: orgId },
      include: { items: { include: { product: true } } },
    });
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      price: Number(c.price),
      description: c.description,
      imageUrl: c.imageUrl,
      items: (c.items as any[]).map((it) => ({
        productId: it.productId,
        productName: it.product?.name ?? '?',
        quantity: it.quantity,
      })),
    };
  }

  async createCombo(dto: { name: string; price: number; description?: string; imageUrl?: string; items: Array<{ productId: string; quantity: number }> }): Promise<any> {
    const orgId = this.tenant.organizationId;
    if (!dto.name?.trim()) throw new BadRequestException('Combo name is required');
    if (!dto.items?.length) throw new BadRequestException('Combo must have at least one item');
    return this.prisma.client.$transaction(async (tx: any) => {
      const combo = await tx.combo.create({
        data: {
          organizationId: orgId,
          name: dto.name.trim(),
          price: dto.price,
          description: dto.description,
          imageUrl: dto.imageUrl,
        },
      });
      for (const it of dto.items) {
        const product = await tx.product.findFirst({ where: { id: it.productId, organizationId: orgId } });
        if (!product) throw new BadRequestException(`Combo references unknown product: ${it.productId}`);
        await tx.comboItem.create({
          data: {
            organizationId: orgId,
            comboId: combo.id,
            productId: it.productId,
            quantity: it.quantity || 1,
          },
        });
      }
      return combo;
    });
  }

  /**
   * P4 helper used by pos.service.checkout. Given a list of (comboId, quantity)
   * pairs, expand each combo into its component products × quantity, with
   * the *combo price* (not the sum of components) attributed to the first
   * component line so the receipt still shows the right total.
   */
  async expandCombosForCheckout(items: Array<{ comboId?: string; quantity: number }>): Promise<Array<{ productId: string; quantity: number; comboPrice?: number }>> {
    const out: Array<{ productId: string; quantity: number; comboPrice?: number }> = [];
    for (const it of items) {
      if (!it.comboId) continue;
      const combo = await this.getCombo(it.comboId);
      if (!combo) throw new BadRequestException(`Unknown combo: ${it.comboId}`);
      // The first component line carries the combo's price as a negative
      // "combo adjustment" via the priceDelta idea, but in practice we
      // simply sum component prices and then deduct the combo discount on
      // the first line so the receipt math works out.
      for (let i = 0; i < combo.items.length; i++) {
        const comp = combo.items[i];
        const expandedQty = comp.quantity * it.quantity;
        out.push({
          productId: comp.productId,
          quantity: expandedQty,
          comboPrice: i === 0 ? combo.price : undefined,
        });
      }
    }
    return out;
  }
}