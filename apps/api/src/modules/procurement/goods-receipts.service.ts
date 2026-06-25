import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { StockService } from '../inventory/stock.service';
import { ThreeWayMatchService } from '../../kernel/three-way-match/three-way-match.service';

interface CreateGRNInput {
  purchaseOrderId?: string;
  branchId?: string;
  warehouseId: string;
  receivedAt?: string;
  notes?: string;
  lines: Array<{
    purchaseOrderLineId?: string;
    productId?: string;
    description: string;
    quantity: number;
    unitCost?: number;
    batchNumber?: string;
    expiryDate?: string;
    notes?: string;
  }>;
}

@Injectable()
export class GoodsReceiptsService {
  private readonly logger = new Logger('GoodsReceipts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly sequence: SequenceService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly twm: ThreeWayMatchService,
  ) {}

  async create(input: CreateGRNInput) {
    const orgId = this.tenant.organizationId;
    if (!input.lines?.length) throw new BadRequestException('At least one line required');
    const warehouse = await this.prisma.raw.inventoryLocation.findFirst({
      where: { id: input.warehouseId, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (input.purchaseOrderId) {
      const po = await this.prisma.raw.purchaseOrder.findFirst({
        where: { id: input.purchaseOrderId, organizationId: orgId },
      });
      if (!po) throw new NotFoundException('Purchase order not found');
    }
    const year = new Date().getUTCFullYear();
    const receiptNumber = await this.sequence.next(`grn:${year}`, { prefix: `GRN-${year}-`, padding: 5 });
    const grn = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.goodsReceiptNote.create({
        data: {
          organizationId: orgId,
          receiptNumber,
          purchaseOrderId: input.purchaseOrderId,
          branchId: input.branchId,
          warehouseId: input.warehouseId,
          receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
          status: 'draft',
          notes: input.notes,
          createdBy: this.tenant.userId ?? null,
          lines: {
            create: input.lines.map((ln, idx) => ({
              organizationId: orgId,
              purchaseOrderLineId: ln.purchaseOrderLineId ?? null,
              productId: ln.productId ?? null,
              description: ln.description,
              quantity: ln.quantity,
              unitCost: ln.unitCost ?? 0,
              batchNumber: ln.batchNumber ?? null,
              expiryDate: ln.expiryDate ? new Date(ln.expiryDate) : null,
              notes: ln.notes ?? null,
              lineNumber: idx + 1,
            })),
          },
        },
        include: { lines: true },
      });
      // Increment PO line receivedQuantity.
      for (const ln of input.lines) {
        if (!ln.purchaseOrderLineId) continue;
        await tx.purchaseOrderLine.update({
          where: { id: ln.purchaseOrderLineId },
          data: { receivedQuantity: { increment: ln.quantity } },
        });
      }
      return created;
    });
    return grn;
  }

  list(query: { status?: string; purchaseOrderId?: string }) {
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.status) where.status = query.status;
    if (query.purchaseOrderId) where.purchaseOrderId = query.purchaseOrderId;
    return this.prisma.client.goodsReceiptNote.findMany({
      where,
      include: { lines: true, order: { select: { orderNumber: true } } },
      orderBy: { receivedAt: 'desc' },
      take: 200,
    });
  }

  findOne(id: string) {
    return this.prisma.client.goodsReceiptNote.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: { lines: true, order: true },
    });
  }

  async post(id: string) {
    const orgId = this.tenant.organizationId;
    const grn = await this.prisma.client.goodsReceiptNote.findFirst({
      where: { id, organizationId: orgId },
      include: { lines: true },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (grn.status !== 'draft') throw new BadRequestException(`GRN already ${grn.status}`);
    // Issue stock-in for each line (only stockable products with trackInventory).
    for (const ln of grn.lines) {
      if (!ln.productId) continue;
      const product = await this.prisma.raw.product.findFirst({
        where: { id: ln.productId, organizationId: orgId },
      });
      if (!product?.trackInventory) continue;
      try {
        await this.stock.receive({
          productId: ln.productId,
          locationId: grn.warehouseId,
          quantity: Number(ln.quantity),
          reference: `GRN ${grn.receiptNumber}`,
        } as any);
      } catch (err) {
        this.logger.warn(`Stock receive for GRN line ${ln.id} failed: ${String(err)}`);
      }
    }
    const updated = await this.prisma.client.goodsReceiptNote.update({
      where: { id },
      data: { status: 'posted', postedAt: new Date(), postedById: this.tenant.userId ?? null },
    });
    await this.audit.record({
      entity: 'GoodsReceiptNote',
      entityId: id,
      action: 'update',
      newValues: { status: 'posted' },
    });
    this.events.publish('goods_receipt.posted' as any, {
      organizationId: orgId,
      receiptId: id,
      receiptNumber: grn.receiptNumber,
      orderId: grn.purchaseOrderId,
    });
    if (grn.purchaseOrderId) {
      await this.twm.recomputeForOrder(grn.purchaseOrderId);
    }
    return updated;
  }
}
