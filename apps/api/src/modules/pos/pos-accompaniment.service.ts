import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

export interface AccompanimentOptionWithDetails {
  id: string;
  groupId: string;
  name: string;
  priceImpact: number;
  isDefault: boolean;
  sortOrder: number;
  isActive: boolean;
  inventoryItemId: string | null;
}

export interface AccompanimentGroupWithOptions {
  id: string;
  name: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  isActive: boolean;
  options: AccompanimentOptionWithDetails[];
}

export interface AccompanimentAssignment {
  id: string;
  menuItemId: string;
  accompanimentGroupId: string;
  sortOrder: number;
  group: AccompanimentGroupWithOptions;
}

@Injectable()
export class PosAccompanimentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /* ====================== Groups (standalone CRUD) ====================== */

  async listAllGroups(): Promise<AccompanimentGroupWithOptions[]> {
    const orgId = this.tenant.organizationId;
    const groups = await this.prisma.client.accompanimentGroup.findMany({
      where: { organizationId: orgId },
      orderBy: { sortOrder: 'asc' },
      include: {
        options: { orderBy: { sortOrder: 'asc' } },
      },
    });
    return (groups as any[]).map(mapGroup);
  }

  async listActiveGroups(): Promise<AccompanimentGroupWithOptions[]> {
    const orgId = this.tenant.organizationId;
    const groups = await this.prisma.client.accompanimentGroup.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    return (groups as any[]).map(mapGroup);
  }

  async getGroup(id: string): Promise<AccompanimentGroupWithOptions> {
    const orgId = this.tenant.organizationId;
    const g = await this.prisma.client.accompanimentGroup.findFirst({
      where: { id, organizationId: orgId },
      include: {
        options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!g) throw new NotFoundException(`AccompanimentGroup ${id} not found`);
    return mapGroup(g as any);
  }

  async createGroup(dto: {
    name: string;
    isRequired?: boolean;
    minSelect?: number;
    maxSelect?: number;
    sortOrder?: number;
  }): Promise<AccompanimentGroupWithOptions> {
    const orgId = this.tenant.organizationId;
    if (!dto.name?.trim()) throw new BadRequestException('Accompaniment group name is required');

    const g = await this.prisma.client.accompanimentGroup.create({
      data: {
        organizationId: orgId,
        name: dto.name.trim(),
        isRequired: dto.isRequired ?? true,
        minSelect: dto.minSelect ?? 1,
        maxSelect: dto.maxSelect ?? 1,
        sortOrder: dto.sortOrder ?? 0,
      },
      include: { options: true },
    });
    return {
      id: g.id,
      name: g.name,
      isRequired: g.isRequired,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      sortOrder: g.sortOrder,
      isActive: g.isActive,
      options: [],
    };
  }

  async updateGroup(
    id: string,
    dto: {
      name?: string;
      isRequired?: boolean;
      minSelect?: number;
      maxSelect?: number;
      sortOrder?: number;
      isActive?: boolean;
    },
  ): Promise<AccompanimentGroupWithOptions> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.accompanimentGroup.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException(`AccompanimentGroup ${id} not found`);

    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('Group name cannot be empty');
    }

    await this.prisma.client.accompanimentGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.isRequired !== undefined ? { isRequired: dto.isRequired } : {}),
        ...(dto.minSelect !== undefined ? { minSelect: dto.minSelect } : {}),
        ...(dto.maxSelect !== undefined ? { maxSelect: dto.maxSelect } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.getGroup(id);
  }

  async deleteGroup(id: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.accompanimentGroup.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException(`AccompanimentGroup ${id} not found`);
    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.accompanimentOption.deleteMany({ where: { groupId: id } });
      await tx.accompanimentGroup.delete({ where: { id } });
    });
  }

  /* ====================== Options ====================== */

  async createOption(
    groupId: string,
    dto: {
      name: string;
      priceImpact?: number;
      isDefault?: boolean;
      sortOrder?: number;
      inventoryItemId?: string;
    },
  ): Promise<AccompanimentOptionWithDetails> {
    const orgId = this.tenant.organizationId;
    if (!dto.name?.trim()) throw new BadRequestException('Option name is required');

    const group = await this.prisma.client.accompanimentGroup.findFirst({
      where: { id: groupId, organizationId: orgId },
    });
    if (!group) throw new NotFoundException(`AccompanimentGroup ${groupId} not found`);

    const o = await this.prisma.client.accompanimentOption.create({
      data: {
        organizationId: orgId,
        groupId,
        name: dto.name.trim(),
        priceImpact: dto.priceImpact ?? 0,
        isDefault: dto.isDefault ?? false,
        sortOrder: dto.sortOrder ?? 0,
        inventoryItemId: dto.inventoryItemId ?? null,
      },
    });
    return {
      id: o.id,
      groupId: o.groupId,
      name: o.name,
      priceImpact: Number(o.priceImpact),
      isDefault: o.isDefault,
      sortOrder: o.sortOrder,
      isActive: o.isActive,
      inventoryItemId: o.inventoryItemId ?? null,
    };
  }

  async updateOption(
    id: string,
    dto: {
      name?: string;
      priceImpact?: number;
      isDefault?: boolean;
      sortOrder?: number;
      isActive?: boolean;
      inventoryItemId?: string | null;
    },
  ): Promise<AccompanimentOptionWithDetails> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.accompanimentOption.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException(`AccompanimentOption ${id} not found`);

    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('Option name cannot be empty');
    }

    const o = await this.prisma.client.accompanimentOption.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.priceImpact !== undefined ? { priceImpact: dto.priceImpact } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.inventoryItemId !== undefined ? { inventoryItemId: dto.inventoryItemId } : {}),
      },
    });
    return {
      id: o.id,
      groupId: o.groupId,
      name: o.name,
      priceImpact: Number(o.priceImpact),
      isDefault: o.isDefault,
      sortOrder: o.sortOrder,
      isActive: o.isActive,
      inventoryItemId: o.inventoryItemId ?? null,
    };
  }

  async deleteOption(id: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.client.accompanimentOption.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException(`AccompanimentOption ${id} not found`);
    await this.prisma.client.accompanimentOption.delete({ where: { id } });
  }

  /* ====================== MenuItem assignment ====================== */

  async listGroupsForMenuItem(menuItemId: string): Promise<AccompanimentGroupWithOptions[]> {
    const orgId = this.tenant.organizationId;
    const assignments = await this.prisma.client.menuItemAccompanimentGroup.findMany({
      where: { menuItemId, menuItem: { organizationId: orgId } },
      orderBy: { sortOrder: 'asc' },
      include: {
        accompanimentGroup: {
          include: {
            options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });
    return (assignments as any[]).map((a: any) => mapGroup(a.accompanimentGroup));
  }

  async assignGroupToMenuItem(menuItemId: string, accompanimentGroupId: string, sortOrder?: number): Promise<void> {
    const orgId = this.tenant.organizationId;
    const menuItem = await this.prisma.client.menuItem.findFirst({
      where: { id: menuItemId, organizationId: orgId },
    });
    if (!menuItem) throw new NotFoundException(`MenuItem ${menuItemId} not found`);

    const group = await this.prisma.client.accompanimentGroup.findFirst({
      where: { id: accompanimentGroupId, organizationId: orgId },
    });
    if (!group) throw new NotFoundException(`AccompanimentGroup ${accompanimentGroupId} not found`);

    await this.prisma.client.menuItemAccompanimentGroup.upsert({
      where: { menuItemId_accompanimentGroupId: { menuItemId, accompanimentGroupId } },
      update: { sortOrder: sortOrder ?? 0 },
      create: { organizationId: orgId, menuItemId, accompanimentGroupId, sortOrder: sortOrder ?? 0 },
    });
  }

  async unassignGroupFromMenuItem(menuItemId: string, accompanimentGroupId: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    await this.prisma.client.menuItemAccompanimentGroup.deleteMany({
      where: { menuItemId, accompanimentGroupId, menuItem: { organizationId: orgId } },
    });
  }

  /* ====================== Validation ====================== */

  async validateSelections(
    menuItemId: string,
    selectedOptionIds: string[],
  ): Promise<{ names: string[]; priceImpact: number }> {
    const orgId = this.tenant.organizationId;
    const assignments = await this.prisma.client.menuItemAccompanimentGroup.findMany({
      where: { menuItemId, menuItem: { organizationId: orgId } },
      include: {
        accompanimentGroup: {
          include: { options: { where: { isActive: true } } },
        },
      },
    });

    const groups = (assignments as any[]).map((a: any) => a.accompanimentGroup);
    if (groups.length === 0) return { names: [], priceImpact: 0 };

    const selected = new Set(selectedOptionIds);
    let totalPriceImpact = 0;
    const names: string[] = [];

    for (const g of groups) {
      const inGroup = g.options.filter((o: any) => selected.has(o.id));
      const count = inGroup.length;

      if (count < g.minSelect) {
        throw new BadRequestException(
          `"${g.name}" requires at least ${g.minSelect} selection(s), got ${count}.`,
        );
      }
      if (g.maxSelect > 0 && count > g.maxSelect) {
        throw new BadRequestException(
          `"${g.name}" allows at most ${g.maxSelect} selection(s), got ${count}.`,
        );
      }

      for (const o of inGroup) {
        const impact = Number(o.priceImpact);
        totalPriceImpact += impact;
        names.push(o.name);
      }
    }

    for (const optId of selectedOptionIds) {
      const valid = groups.some((g: any) => g.options.some((o: any) => o.id === optId));
      if (!valid) throw new BadRequestException(`AccompanimentOption ${optId} not found for this menu item`);
    }

    return { names, priceImpact: totalPriceImpact };
  }
}

/* ====================== Shared mapper ====================== */

function mapGroup(g: any): AccompanimentGroupWithOptions {
  return {
    id: g.id,
    name: g.name,
    isRequired: g.isRequired,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    sortOrder: g.sortOrder,
    isActive: g.isActive,
    options: (g.options ?? []).map((o: any) => ({
      id: o.id,
      groupId: o.groupId,
      name: o.name,
      priceImpact: Number(o.priceImpact),
      isDefault: o.isDefault,
      sortOrder: o.sortOrder,
      isActive: o.isActive,
      inventoryItemId: o.inventoryItemId ?? null,
    })),
  };
}
