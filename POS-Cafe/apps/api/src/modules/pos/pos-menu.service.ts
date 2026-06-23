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
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

@Injectable()
export class PosMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  // ───────────────────────── Categories ─────────────────────────

  listCategories() {
    return this.prisma.client.menuCategory.findMany({
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      where: { isActive: true },
    });
  }

  async createCategory(input: {
    name: string;
    parentId?: string;
    image?: string;
    icon?: string;
    displayOrder?: number;
  }) {
    return this.prisma.client.menuCategory.create({
      data: {
        organizationId: this.tenant.organizationId,
        name: input.name,
        parentId: input.parentId,
        image: input.image,
        icon: input.icon,
        displayOrder: input.displayOrder ?? 0,
      },
    });
  }

  async updateCategory(id: string, data: { name?: string; displayOrder?: number; image?: string; icon?: string }) {
    const existing = await this.prisma.client.menuCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`MenuCategory ${id} not found`);
    return this.prisma.client.menuCategory.update({ where: { id }, data });
  }

  async deleteCategory(id: string) {
    const existing = await this.prisma.client.menuCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`MenuCategory ${id} not found`);
    return this.prisma.client.menuCategory.update({ where: { id }, data: { isActive: false } });
  }

  // ─────────────────────────── Items ────────────────────────────

  /** The POS terminal calls this on load. Returns the menu grouped by category,
   *  filtered to available items only. Ingredient links are included so the
   *  KDS can show "uses: Espresso, Milk" and the cashier can show stock hint. */
  async listAvailable() {
    const cats = await this.prisma.client.menuCategory.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
    const items = await this.prisma.client.menuItem.findMany({
      where: { isAvailable: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      include: {
        ingredients: { include: { product: { select: { id: true, code: true, name: true, station: true } } } },
      },
    });
    return {
      categories: cats,
      items,
    };
  }

  async listAll() {
    return this.prisma.client.menuItem.findMany({
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      include: { ingredients: true, category: true },
    });
  }

  async getOne(id: string) {
    const item = await this.prisma.client.menuItem.findUnique({
      where: { id },
      include: { ingredients: { include: { product: true } }, category: true },
    });
    if (!item) throw new NotFoundException(`MenuItem ${id} not found`);
    return item;
  }

  async create(input: {
    code?: string;
    name: string;
    description?: string;
    categoryId?: string;
    basePrice?: number;
    image?: string;
    preparationTime?: number;
    isAvailable?: boolean;
    displayOrder?: number;
    ingredients: { productId: string; quantity?: number }[];
  }) {
    if (!input.ingredients?.length) {
      throw new BadRequestException('A menu item must reference at least one product (ingredient).');
    }
    return this.prisma.client.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: {
          organizationId: this.tenant.organizationId,
          code: input.code,
          name: input.name,
          description: input.description,
          categoryId: input.categoryId,
          basePrice: input.basePrice ?? null,
          image: input.image,
          preparationTime: input.preparationTime ?? null,
          isAvailable: input.isAvailable ?? true,
          displayOrder: input.displayOrder ?? 0,
        },
      });
      for (const ing of input.ingredients) {
        await tx.menuProduct.create({
          data: {
            organizationId: this.tenant.organizationId,
            menuItemId: item.id,
            productId: ing.productId,
            quantity: ing.quantity ?? 1,
          },
        });
      }
      return tx.menuItem.findUniqueOrThrow({
        where: { id: item.id },
        include: { ingredients: { include: { product: true } }, category: true },
      });
    });
  }

  async update(id: string, patch: Partial<{
    code: string;
    name: string;
    description: string;
    categoryId: string | null;
    basePrice: number | null;
    image: string | null;
    preparationTime: number | null;
    isAvailable: boolean;
    displayOrder: number;
    ingredients: { productId: string; quantity?: number }[];
  }>) {
    await this.getOne(id);
    const { ingredients, ...data } = patch;
    return this.prisma.client.$transaction(async (tx) => {
      if (data && Object.keys(data).length > 0) {
        await tx.menuItem.update({ where: { id }, data });
      }
      if (ingredients) {
        if (!ingredients.length) {
          throw new BadRequestException('A menu item must reference at least one product (ingredient).');
        }
        await tx.menuProduct.deleteMany({ where: { menuItemId: id } });
        for (const ing of ingredients) {
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
      return tx.menuItem.findUniqueOrThrow({
        where: { id },
        include: { ingredients: { include: { product: true } }, category: true },
      });
    });
  }

  async setAvailability(id: string, isAvailable: boolean) {
    return this.prisma.client.menuItem.update({ where: { id }, data: { isAvailable } });
  }

  async disable(id: string) {
    await this.getOne(id);
    return this.prisma.client.menuItem.update({
      where: { id },
      data: { isAvailable: false },
    });
  }
}