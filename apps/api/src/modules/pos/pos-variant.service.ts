import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

export interface VariantWithDetails {
  id: string;
  menuItemId: string;
  name: string;
  price: number;
  sortOrder: number;
  isActive: boolean;
}

@Injectable()
export class PosVariantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /* ====================== Read ====================== */

  async listVariants(menuItemId: string): Promise<VariantWithDetails[]> {
    const orgId = this.tenant.organizationId;
    const rows = await this.prisma.client.menuItemVariant.findMany({
      where: { organizationId: orgId, menuItemId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return (rows as any[]).map((v) => ({
      id: v.id,
      menuItemId: v.menuItemId,
      name: v.name,
      price: Number(v.price),
      sortOrder: v.sortOrder,
      isActive: v.isActive,
    }));
  }

  async getVariant(id: string): Promise<VariantWithDetails> {
    const orgId = this.tenant.organizationId;
    const v = await this.prisma.client.menuItemVariant.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!v) throw new NotFoundException(`MenuItemVariant ${id} not found`);
    return {
      id: v.id,
      menuItemId: v.menuItemId,
      name: v.name,
      price: Number(v.price),
      sortOrder: v.sortOrder,
      isActive: v.isActive,
    };
  }

  /* ====================== Write ====================== */

  async createVariant(
    menuItemId: string,
    dto: { name: string; price: number; sortOrder?: number },
  ): Promise<VariantWithDetails> {
    const orgId = this.tenant.organizationId;
    if (!dto.name?.trim()) throw new BadRequestException('Variant name is required');
    if (dto.price == null || dto.price < 0) throw new BadRequestException('Variant price must be >= 0');

    const menuItem = await this.prisma.client.menuItem.findFirst({
      where: { id: menuItemId, organizationId: orgId },
    });
    if (!menuItem) throw new NotFoundException(`MenuItem ${menuItemId} not found`);

    const existing = await this.prisma.client.menuItemVariant.findFirst({
      where: { organizationId: orgId, menuItemId, name: dto.name.trim() },
    });
    if (existing) throw new BadRequestException(`Variant "${dto.name.trim()}" already exists for this item`);

    const v = await this.prisma.client.menuItemVariant.create({
      data: {
        organizationId: orgId,
        menuItemId,
        name: dto.name.trim(),
        price: dto.price,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    return {
      id: v.id,
      menuItemId: v.menuItemId,
      name: v.name,
      price: Number(v.price),
      sortOrder: v.sortOrder,
      isActive: v.isActive,
    };
  }

  async updateVariant(
    id: string,
    dto: { name?: string; price?: number; sortOrder?: number; isActive?: boolean },
  ): Promise<VariantWithDetails> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.menuItemVariant.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException(`MenuItemVariant ${id} not found`);

    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('Variant name cannot be empty');
    }
    if (dto.price !== undefined && dto.price < 0) {
      throw new BadRequestException('Variant price must be >= 0');
    }

    const v = await this.prisma.client.menuItemVariant.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return {
      id: v.id,
      menuItemId: v.menuItemId,
      name: v.name,
      price: Number(v.price),
      sortOrder: v.sortOrder,
      isActive: v.isActive,
    };
  }

  async deleteVariant(id: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.menuItemVariant.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException(`MenuItemVariant ${id} not found`);
    await this.prisma.client.menuItemVariant.delete({ where: { id } });
  }

  /* ====================== Validation ====================== */

  async resolveVariantPrice(menuItemId: string, variantId: string): Promise<number> {
    const orgId = this.tenant.organizationId;
    const v = await this.prisma.client.menuItemVariant.findFirst({
      where: { id: variantId, menuItemId, organizationId: orgId, isActive: true },
    });
    if (!v) throw new BadRequestException(`Variant ${variantId} not found or inactive`);
    return Number(v.price);
  }

  async validateVariant(menuItemId: string, variantId: string): Promise<VariantWithDetails> {
    const orgId = this.tenant.organizationId;
    const v = await this.prisma.client.menuItemVariant.findFirst({
      where: { id: variantId, menuItemId, organizationId: orgId, isActive: true },
    });
    if (!v) throw new BadRequestException(`Invalid variant selection for this menu item`);
    return {
      id: v.id,
      menuItemId: v.menuItemId,
      name: v.name,
      price: Number(v.price),
      sortOrder: v.sortOrder,
      isActive: v.isActive,
    };
  }
}
