import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { dec, ZERO } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { SettingResolverService } from '../../kernel/settings/setting-resolver.service';
import { StockService } from './stock.service';
import { assertActiveStaff, assertDirectStockApproval } from './staff-attribution';
import { DirectStockInDto, DirectStockOutDto } from './dto/direct-stock.dto';

@Injectable()
export class DirectStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly stock: StockService,
    private readonly settings: SettingResolverService,
  ) {}

  private get org(): string {
    return this.tenant.organizationId;
  }

  /** Attribution ids are real org users AND the named approver provably approved. */
  private async assertAttribution(dto: { responsibleById: string; approvedById?: string; approverPin?: string }, approvalNeeded: boolean) {
    await assertActiveStaff(this.prisma.client, this.org, { responsibleById: dto.responsibleById, approvedById: dto.approvedById });
    if (!approvalNeeded) return;
    await assertDirectStockApproval(this.prisma.client, {
      organizationId: this.org,
      actorUserId: this.tenant.userId,
      actorPermissions: this.tenant.permissions ?? [],
      approvedById: dto.approvedById!,
      approverPin: dto.approverPin,
    });
  }

  async directIn(dto: DirectStockInDto) {
    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');
    const approvalNeeded = await this.settings.resolveBool('inventory.stockInApprovalNeeded', { warehouseId: dto.locationId });
    await this.assertAttribution(dto, approvalNeeded);

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, batchTracking: true, expiryTracking: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    for (const item of dto.items) {
      const prod = productMap.get(item.productId);
      if (!prod) throw new NotFoundException(`Product ${item.productId} not found`);
      if (prod.batchTracking && !item.batchNumber) {
        throw new BadRequestException(`Batch number required for batch-tracked product "${prod.name}"`);
      }
      if (prod.expiryTracking && !item.expiryDate) {
        throw new BadRequestException(`Expiry date required for expiry-tracked product "${prod.name}"`);
      }
    }

    const code = await this.seq.next('direct_stock_in', { prefix: 'DSI-', padding: 5 });

    return this.prisma.client.$transaction(async (tx: any) => {
      let totalValue = ZERO;
      const results: any[] = [];

      for (const item of dto.items) {
        // Direct stock-in has no supplier document, so the value is a stock gain:
        // Dr Stock Valuation / Cr Inventory Adjustment. A bare receive() here left
        // inventory capitalised in the sub-ledger with no GL entry at all.
        const res = await this.stock.receiveForDocument(
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
            responsibleById: dto.responsibleById,
            approvedById: dto.approvedById,
          },
          { sourceType: 'direct_stock_in', sourceId: code, date: new Date(), kind: 'stock_gain' },
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
    }, { timeout: 20_000 });
  }

  async directOut(dto: DirectStockOutDto) {
    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');
    const approvalNeeded = await this.settings.resolveBool('inventory.stockOutApprovalNeeded', { warehouseId: dto.locationId });
    await this.assertAttribution(dto, approvalNeeded);

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

    const code = await this.seq.next('direct_stock_out', { prefix: 'DSO-', padding: 5 });

    // Owner decision: with inventory.allowNegativeStock on, a direct stock-out
    // simply proceeds (the migrated data is legitimately negative). The transfer
    // loss paths keep their own requireAvailable semantics untouched.
    const allowNegative = await this.settings.resolveBool('inventory.allowNegativeStock', { warehouseId: dto.locationId });

    // Availability is enforced by StockService.issue under the StockItem row
    // lock (`requireAvailable`), re-reading on-hand in BASE units after the lock
    // is held. A check before the lock let two concurrent stock-outs of the last
    // unit both pass and drive on-hand negative. Lines are issued in a
    // deterministic (product, variant) order so multi-line documents touching
    // the same quants lock in the same order and cannot deadlock.
    return this.prisma.client.$transaction(async (tx: any) => {
      let totalValue = ZERO;
      const results: any[] = [];

      const ordered = [...dto.items].sort((a, b) =>
        a.productId === b.productId
          ? (a.variantId ?? '').localeCompare(b.variantId ?? '')
          : a.productId.localeCompare(b.productId),
      );
      for (const item of ordered) {
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
            requireAvailable: !allowNegative,
            notes: item.notes ?? dto.notes ?? undefined,
            responsibleById: dto.responsibleById,
            approvedById: dto.approvedById,
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
    }, { timeout: 20_000 });
  }
}
