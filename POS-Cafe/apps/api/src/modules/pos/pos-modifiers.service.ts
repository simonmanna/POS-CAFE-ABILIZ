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
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

export interface ModifierGroupWithModifiers {
  id: string;
  name: string;
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
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      sortOrder: g.sortOrder,
      modifiers: g.modifiers.map((m: any) => ({
        id: m.id, name: m.name, priceDelta: Number(m.priceDelta), isDefault: m.isDefault, sortOrder: m.sortOrder,
      })),
    }));
  }

  async createGroup(dto: { name: string; minSelect?: number; maxSelect?: number; sortOrder?: number }): Promise<any> {
    const orgId = this.tenant.organizationId;
    if (!dto.name?.trim()) throw new BadRequestException('Group name is required');
    return this.prisma.client.modifierGroup.create({
      data: {
        organizationId: orgId,
        name: dto.name.trim(),
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