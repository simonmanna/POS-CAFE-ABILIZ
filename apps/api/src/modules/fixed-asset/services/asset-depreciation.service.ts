import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { AssetDepreciationStrategy } from './asset-depreciation.strategy';
import type { RunDepreciationDto } from '../dto/run-depreciation.dto';

@Injectable()
export class AssetDepreciationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly strategy: AssetDepreciationStrategy,
  ) {}

  async findByAsset(assetId: string): Promise<any[]> {
    return this.prisma.client.assetDepreciation.findMany({
      where: { assetId },
      orderBy: { period: 'desc' },
    });
  }

  async findByPeriod(organizationId: string, period: string): Promise<any[]> {
    return this.prisma.client.assetDepreciation.findMany({
      where: { organizationId, period },
      include: { asset: { select: { name: true, assetCode: true, categoryId: true } } },
      orderBy: { asset: { name: 'asc' } },
    });
  }

  async run(orgId: string, dto: RunDepreciationDto): Promise<any[]> {
    const where: Record<string, any> = { organizationId: orgId, status: 'active', deletedAt: null };
    if (dto.assetId) where.id = dto.assetId;
    const assets = await this.prisma.client.asset.findMany({
      where,
      include: { category: true, depreciations: { where: { period: dto.period }, take: 1 } },
    });
    const results: any[] = [];
    for (const asset of assets) {
      if (asset.depreciations.length > 0) continue;
      const lastDepr = await this.prisma.client.assetDepreciation.findFirst({
        where: { assetId: asset.id },
        orderBy: { period: 'desc' },
      });
      const cost = Number(asset.purchaseCost ?? asset.currentValue ?? 0);
      const salvage = Number(asset.salvageValue ?? 0);
      const usefulLife = asset.usefulLife ?? 60;
      const method = asset.category?.depreciationMethod ?? 'straight_line';
      const accumDepr = lastDepr ? Number(lastDepr.accumulatedDepr) : 0;
      const bookValue = lastDepr ? Number(lastDepr.bookValue) : (cost - accumDepr);
      const input = { cost, salvageValue: salvage, usefulLife, currentBookValue: bookValue, accumulatedDepreciation: accumDepr, period: dto.period };
      const result = this.strategy.calculate(method, input);
      if (result.depreciationAmount <= 0) continue;
      const entry = await this.prisma.client.assetDepreciation.create({
        data: {
          organizationId: orgId,
          assetId: asset.id,
          period: dto.period,
          method: method as any,
          assetCost: cost,
          salvageValue: salvage,
          usefulLife,
          depreciationAmount: result.depreciationAmount,
          accumulatedDepr: result.accumulatedDepreciation,
          bookValue: result.bookValue,
          isPosted: dto.postEntries ?? false,
        },
      });
      await this.prisma.client.asset.update({
        where: { id: asset.id },
        data: { currentValue: result.bookValue },
      });
      results.push(entry);
    }
    this.events.publish('fixed_asset.depreciation_run', {
      organizationId: orgId,
      period: dto.period,
      entriesCount: results.length,
    });
    return results;
  }

  async postEntry(id: string): Promise<any> {
    const dep = await this.prisma.client.assetDepreciation.findFirst({ where: { id } });
    if (!dep) throw new NotFoundException(`Depreciation entry ${id} not found`);
    return this.prisma.client.assetDepreciation.update({
      where: { id },
      data: { isPosted: true, postedAt: new Date() },
    });
  }
}
