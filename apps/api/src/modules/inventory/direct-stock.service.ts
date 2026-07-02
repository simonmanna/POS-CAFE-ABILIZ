import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { dec, ZERO } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { StockService } from './stock.service';
import { DirectStockInDto, DirectStockOutDto } from './dto/direct-stock.dto';

@Injectable()
export class DirectStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly stock: StockService,
  ) {}

  private get org(): string {
    return this.tenant.organizationId;
  }

  async directIn(dto: DirectStockInDto) {
    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, batchTracking: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    for (const item of dto.items) {
      const prod = productMap.get(item.productId);
      if (!prod) throw new NotFoundException(`Product ${item.productId} not found`);
      if (prod.batchTracking && !item.batchNumber) {
        throw new BadRequestException(`Batch number required for batch-tracked product "${prod.name}"`);
      }
      if (prod.batchTracking && !item.expiryDate) {
        throw new BadRequestException(`Expiry date required for batch-tracked product "${prod.name}"`);
      }
    }

    const code = await this.seq.next('direct_stock_in', { prefix: 'DSI-', padding: 5 });

    return this.prisma.client.$transaction(async (tx: any) => {
      let totalValue = ZERO;
      const results: any[] = [];

      for (const item of dto.items) {
        const res = await this.stock.receive(
          {
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            locationId: dto.locationId,
            quantity: item.quantity,
            unitCost: item.unitCost,
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
            sourceType: 'direct_stock_in',
            sourceId: code,
            notes: item.notes ?? dto.notes ?? undefined,
          },
          tx,
        );
        const uc = dec(res.unitCost ?? 0);
        const lineValue = uc.times(item.quantity);
        totalValue = totalValue.plus(lineValue);
        results.push({
          productId: item.productId,
          quantity: item.quantity,
          unitCost: uc.toString(),
        });
      }

      return {
        code,
        type: 'IN' as const,
        locationId: dto.locationId,
        totalValue: Number(totalValue),
        items: results,
        notes: dto.notes ?? null,
        timestamp: new Date(),
      };
    });
  }

  async directOut(dto: DirectStockOutDto) {
    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    for (const item of dto.items) {
      if (!productMap.has(item.productId)) {
        throw new NotFoundException(`Product ${item.productId} not found`);
      }
    }

    // Phase 1 — Pre-validate stock availability
    for (const item of dto.items) {
      const variantKey = item.variantId ?? '';
      const stockItem = await this.prisma.client.stockItem.findFirst({
        where: { organizationId: this.org, productId: item.productId, variantKey, locationId: dto.locationId },
      });
      const available = stockItem ? Number(stockItem.quantity) : 0;
      if (available < item.quantity) {
        const prod = productMap.get(item.productId)!;
        throw new BadRequestException(
          `Insufficient stock for "${prod.name}": requested ${item.quantity}, available ${available}`,
        );
      }
    }

    const code = await this.seq.next('direct_stock_out', { prefix: 'DSO-', padding: 5 });

    return this.prisma.client.$transaction(async (tx: any) => {
      let totalValue = ZERO;
      const results: any[] = [];

      for (const item of dto.items) {
        const res = await this.stock.issue(
          {
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            locationId: dto.locationId,
            quantity: item.quantity,
            moveType: 'issue',
            distStrategy: item.distStrategy ?? 'FEFO',
            batchNumber: item.batchNumber,
            sourceType: 'direct_stock_out',
            sourceId: code,
            notes: item.notes ?? dto.notes ?? undefined,
          },
          tx,
        );
        const lineValue = dec(res.totalValue ?? 0);
        totalValue = totalValue.plus(lineValue);
        results.push({
          productId: item.productId,
          quantity: item.quantity,
          unitCost: res.unitCost,
        });
      }

      return {
        code,
        type: 'OUT' as const,
        locationId: dto.locationId,
        totalValue: Number(totalValue),
        items: results,
        notes: dto.notes ?? null,
        timestamp: new Date(),
      };
    });
  }
}
