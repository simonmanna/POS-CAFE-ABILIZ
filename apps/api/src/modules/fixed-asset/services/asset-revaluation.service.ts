import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import type { CreateRevaluationDto } from '../dto/create-revaluation.dto';

@Injectable()
export class AssetRevaluationService {
  constructor(private readonly prisma: PrismaService) {}

  async findByAsset(assetId: string): Promise<any[]> {
    return this.prisma.client.assetRevaluation.findMany({
      where: { assetId },
      orderBy: { revaluationDate: 'desc' },
    });
  }

  async create(assetId: string, dto: CreateRevaluationDto): Promise<any> {
    const asset = await this.prisma.client.asset.findFirst({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);
    const data: any = { assetId, ...dto };
    if (dto.revaluationDate) data.revaluationDate = new Date(dto.revaluationDate);
    const reval = await this.prisma.client.assetRevaluation.create({ data });
    await this.prisma.client.asset.update({
      where: { id: assetId },
      data: { currentValue: dto.newValue },
    });
    return reval;
  }
}
