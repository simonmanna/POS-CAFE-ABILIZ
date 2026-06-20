import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StockMoveType } from '@erp/shared';
import { dec, ZERO } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../kernel/events/event-bus';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { AuditService } from '../../kernel/audit/audit.service';
import {
  ReceiveStockDto,
  IssueStockDto,
  AdjustStockDto,
  TransferStockDto,
} from './dto/stock.dto';

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
  ) {}

  async receive(dto: ReceiveStockDto) {
    const organizationId = this.tenant.organizationId;
    const product = await this.prisma.client.product.findFirst({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');

    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');

    if (product.batchTracking && !dto.batchNumber) {
      throw new BadRequestException('Batch number is required for batch-tracked products');
    }
    if (dto.expiryDate && !product.batchTracking) {
      throw new BadRequestException('Expiry date is only valid for batch-tracked products');
    }

    const qty = dec(dto.quantity);
    const unitCost = dto.unitCost != null ? dec(dto.unitCost) : null;

    return this.prisma.client.$transaction(async (tx: any) => {
      const ledgerCode = await this.seq.next('stock_move', { prefix: 'STK/', padding: 6 }, tx);

      const stockItem = await tx.stockItem.upsert({
        where: { organizationId_productId_locationId: { organizationId, productId: dto.productId, locationId: dto.locationId } },
        create: { organizationId, productId: dto.productId, locationId: dto.locationId, quantity: qty },
        update: { quantity: { increment: qty } },
      });

      let batchId: string | null = null;
      if (product.batchTracking) {
        const batch = await tx.inventoryBatch.create({
          data: {
            organizationId,
            productId: dto.productId,
            locationId: dto.locationId,
            batchNumber: dto.batchNumber!,
            quantity: qty,
            unitCost,
            expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
          },
        });
        batchId = batch.id;
      }

      const currentQty = dec(stockItem.quantity);
      await tx.inventoryLedger.create({
        data: {
          organizationId,
          ledgerCode,
          productId: dto.productId,
          locationId: dto.locationId,
          batchId,
          type: 'receipt',
          quantityChange: qty,
          balanceAfter: currentQty,
          unitCost: unitCost ?? ZERO,
          totalValue: unitCost ? unitCost.times(qty) : ZERO,
          notes: dto.notes ?? null,
          performedBy: this.tenant.userId ?? null,
        },
      });

      this.events.publish('stock.received', {
        organizationId,
        productId: dto.productId,
        locationId: dto.locationId,
        ledgerCode,
        quantity: String(dto.quantity),
      });

      await this.audit.record({
        entity: 'StockItem',
        entityId: stockItem.id,
        action: 'receive',
        newValues: { productId: dto.productId, locationId: dto.locationId, quantity: dto.quantity, ledgerCode },
      });

      return { ledgerCode, quantity: dto.quantity };
    });
  }

  async issue(dto: IssueStockDto) {
    const organizationId = this.tenant.organizationId;
    const product = await this.prisma.client.product.findFirst({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');

    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');

    const qty = dec(dto.quantity);
    if (qty.lte(ZERO)) throw new BadRequestException('Quantity must be positive');

    return this.prisma.client.$transaction(async (tx: any) => {
      const stockItem = await tx.stockItem.findFirst({
        where: { organizationId, productId: dto.productId, locationId: dto.locationId },
      });
      if (!stockItem) throw new BadRequestException('No stock found for this product at this location');
      const available = dec(stockItem.quantity);
      if (available.lt(qty)) throw new BadRequestException(`Insufficient stock: available ${available}, requested ${qty}`);

      const ledgerCode = await this.seq.next('stock_move', { prefix: 'STK/', padding: 6 }, tx);
      let remaining = qty;

      if (product.batchTracking) {
        const batches = await tx.inventoryBatch.findMany({
          where: { organizationId, productId: dto.productId, locationId: dto.locationId, quantity: { gt: 0 }, isActive: true },
          orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }],
        });

        for (const batch of batches) {
          if (remaining.lte(ZERO)) break;
          const batchQty = dec(batch.quantity);
          const consumed = Prisma.Decimal.min(remaining, batchQty);
          const newBatchQty = batchQty.minus(consumed);

          await tx.inventoryBatch.updateMany({
            where: { id: batch.id, organizationId },
            data: { quantity: newBatchQty },
          });

          await tx.inventoryLedger.create({
            data: {
              organizationId,
              ledgerCode,
              productId: dto.productId,
              locationId: dto.locationId,
              batchId: batch.id,
              type: 'issue',
              quantityChange: consumed.negated(),
              balanceAfter: newBatchQty,
              unitCost: batch.unitCost ?? ZERO,
              totalValue: batch.unitCost ? dec(batch.unitCost).times(consumed) : ZERO,
              notes: dto.notes ?? null,
              performedBy: this.tenant.userId ?? null,
            },
          });

          remaining = remaining.minus(consumed);
        }

        if (remaining.gt(ZERO)) {
          throw new BadRequestException('Insufficient batch stock to fulfill issue');
        }
      } else {
        await tx.inventoryLedger.create({
          data: {
            organizationId,
            ledgerCode,
            productId: dto.productId,
            locationId: dto.locationId,
            batchId: null,
            type: 'issue',
            quantityChange: qty.negated(),
            balanceAfter: available.minus(qty),
            notes: dto.notes ?? null,
            performedBy: this.tenant.userId ?? null,
          },
        });
      }

      await tx.stockItem.updateMany({
        where: { id: stockItem.id, organizationId },
        data: { quantity: { decrement: qty } },
      });

      this.events.publish('stock.issued', {
        organizationId,
        productId: dto.productId,
        locationId: dto.locationId,
        ledgerCode,
        quantity: String(dto.quantity),
      });

      await this.audit.record({
        entity: 'StockItem',
        entityId: stockItem.id,
        action: 'issue',
        newValues: { productId: dto.productId, locationId: dto.locationId, quantity: dto.quantity, ledgerCode },
      });

      return { ledgerCode, quantity: dto.quantity };
    });
  }

  async adjust(dto: AdjustStockDto) {
    const organizationId = this.tenant.organizationId;
    const product = await this.prisma.client.product.findFirst({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');

    const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');

    const countedQty = dec(dto.countedQuantity);

    return this.prisma.client.$transaction(async (tx: any) => {
      const stockItem = await tx.stockItem.findFirst({
        where: { organizationId, productId: dto.productId, locationId: dto.locationId },
      });

      const currentQty = stockItem ? dec(stockItem.quantity) : ZERO;
      const delta = countedQty.minus(currentQty);
      if (delta.isZero()) return { ledgerCode: null, quantity: 0, delta: 0 };

      const ledgerCode = await this.seq.next('stock_move', { prefix: 'STK/', padding: 6 }, tx);
      const moveType: StockMoveType = delta.gt(ZERO) ? 'adjustment_in' : 'adjustment_out';

      if (stockItem) {
        await tx.stockItem.updateMany({
          where: { id: stockItem.id, organizationId },
          data: { quantity: countedQty },
        });
      } else {
        await tx.stockItem.create({
          data: { organizationId, productId: dto.productId, locationId: dto.locationId, quantity: countedQty },
        });
      }

      await tx.inventoryLedger.create({
        data: {
          organizationId,
          ledgerCode,
          productId: dto.productId,
          locationId: dto.locationId,
          type: moveType,
          quantityChange: delta,
          balanceAfter: countedQty,
          notes: dto.notes ?? null,
          performedBy: this.tenant.userId ?? null,
        },
      });

      this.events.publish('stock.adjusted', {
        organizationId,
        productId: dto.productId,
        locationId: dto.locationId,
        ledgerCode,
        quantity: String(countedQty),
      });

      await this.audit.record({
        entity: 'StockItem',
        entityId: stockItem?.id ?? 'new',
        action: 'adjust',
        newValues: { productId: dto.productId, locationId: dto.locationId, countedQuantity: dto.countedQuantity, previousQuantity: Number(currentQty), ledgerCode },
      });

      return { ledgerCode, previousQuantity: Number(currentQty), newQuantity: Number(countedQty), delta: Number(delta) };
    });
  }

  async transfer(dto: TransferStockDto) {
    const organizationId = this.tenant.organizationId;
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('Source and destination locations must be different');
    }

    const product = await this.prisma.client.product.findFirst({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');

    const [fromLoc, toLoc] = await Promise.all([
      this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.fromLocationId } }),
      this.prisma.client.inventoryLocation.findFirst({ where: { id: dto.toLocationId } }),
    ]);
    if (!fromLoc) throw new NotFoundException('Source location not found');
    if (!toLoc) throw new NotFoundException('Destination location not found');

    const qty = dec(dto.quantity);
    if (qty.lte(ZERO)) throw new BadRequestException('Quantity must be positive');

    return this.prisma.client.$transaction(async (tx: any) => {
      const fromItem = await tx.stockItem.findFirst({
        where: { organizationId, productId: dto.productId, locationId: dto.fromLocationId },
      });
      if (!fromItem) throw new BadRequestException('No stock found at source location');
      const fromQty = dec(fromItem.quantity);
      if (fromQty.lt(qty)) throw new BadRequestException(`Insufficient stock at source: available ${fromQty}, requested ${qty}`);

      const ledgerCode = await this.seq.next('stock_move', { prefix: 'STK/', padding: 6 }, tx);

      await tx.stockItem.updateMany({
        where: { id: fromItem.id, organizationId },
        data: { quantity: { decrement: qty } },
      });

      const toItem = await tx.stockItem.upsert({
        where: { organizationId_productId_locationId: { organizationId, productId: dto.productId, locationId: dto.toLocationId } },
        create: { organizationId, productId: dto.productId, locationId: dto.toLocationId, quantity: qty },
        update: { quantity: { increment: qty } },
      });

      if (product.batchTracking) {
        const batches = await tx.inventoryBatch.findMany({
          where: { organizationId, productId: dto.productId, locationId: dto.fromLocationId, quantity: { gt: 0 }, isActive: true },
          orderBy: { receivedAt: 'asc' },
        });

        let remaining = qty;
        for (const batch of batches) {
          if (remaining.lte(ZERO)) break;
          const batchQty = dec(batch.quantity);
          const movedQty = Prisma.Decimal.min(remaining, batchQty);

          await tx.inventoryBatch.updateMany({
            where: { id: batch.id, organizationId },
            data: { quantity: batchQty.minus(movedQty) },
          });

          await tx.inventoryBatch.create({
            data: {
              organizationId,
              productId: dto.productId,
              locationId: dto.toLocationId,
              batchNumber: batch.batchNumber,
              quantity: movedQty,
              unitCost: batch.unitCost,
              expiryDate: batch.expiryDate,
            },
          });

          remaining = remaining.minus(movedQty);
        }
      }

      const newFromQty = fromQty.minus(qty);
      const newToQty = dec(toItem.quantity);

      await tx.inventoryLedger.create({
        data: {
          organizationId,
          ledgerCode,
          productId: dto.productId,
          locationId: dto.fromLocationId,
          type: 'transfer_out',
          quantityChange: qty.negated(),
          balanceAfter: newFromQty,
          notes: dto.notes ?? null,
          performedBy: this.tenant.userId ?? null,
        },
      });

      await tx.inventoryLedger.create({
        data: {
          organizationId,
          ledgerCode,
          productId: dto.productId,
          locationId: dto.toLocationId,
          type: 'transfer_in',
          quantityChange: qty,
          balanceAfter: newToQty,
          notes: dto.notes ?? null,
          performedBy: this.tenant.userId ?? null,
        },
      });

      this.events.publish('stock.transferred', {
        organizationId,
        productId: dto.productId,
        locationId: dto.toLocationId,
        ledgerCode,
        quantity: String(dto.quantity),
      });

      await this.audit.record({
        entity: 'StockItem',
        entityId: fromItem.id,
        action: 'transfer',
        newValues: { productId: dto.productId, fromLocationId: dto.fromLocationId, toLocationId: dto.toLocationId, quantity: dto.quantity, ledgerCode },
      });

      return { ledgerCode, quantity: dto.quantity, fromLocationId: dto.fromLocationId, toLocationId: dto.toLocationId };
    });
  }
}
