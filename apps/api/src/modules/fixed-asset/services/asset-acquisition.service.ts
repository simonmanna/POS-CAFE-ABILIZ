import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import type { CreateAcquisitionDto } from '../dto/create-acquisition.dto';

@Injectable()
export class AssetAcquisitionService {
  constructor(private readonly prisma: PrismaService) {}

  async findByAsset(assetId: string): Promise<any> {
    const acq = await this.prisma.client.assetAcquisition.findUnique({ where: { assetId } });
    if (!acq) throw new NotFoundException(`Acquisition for asset ${assetId} not found`);
    return acq;
  }

  async upsert(assetId: string, dto: CreateAcquisitionDto): Promise<any> {
    const asset = await this.prisma.client.asset.findFirst({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);
    const data: any = { ...dto };
    if (dto.acquisitionDate) data.acquisitionDate = new Date(dto.acquisitionDate);
    return this.prisma.client.assetAcquisition.upsert({
      where: { assetId },
      create: { assetId, ...data },
      update: data,
    });
  }

  async remove(assetId: string): Promise<void> {
    await this.prisma.client.assetAcquisition.deleteMany({ where: { assetId } });
  }
}
