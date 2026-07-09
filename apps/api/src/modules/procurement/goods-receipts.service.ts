import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { StockService } from '../inventory/stock.service';
import { PaginatedResult, PaginationQuery, DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@erp/shared';

interface CreateGRNInput {
  warehouseId: string;
  branchId?: string;
  partnerId?: string;
  receivedAt?: string;
  notes?: string;
  lines: Array<{
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
  ) {}

  async createAdhoc(input: CreateGRNInput) {
    const orgId = this.tenant.organizationId;
    if (!input.lines?.length) throw new BadRequestException('At least one line required');
    if (!input.warehouseId) throw new BadRequestException('Warehouse required');

    const warehouse = await this.prisma.raw.inventoryLocation.findFirst({
      where: { id: input.warehouseId, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const year = new Date().getUTCFullYear();
    const receiptNumber = await this.sequence.next(`grn:${year}`, {
      prefix: `GRN-${year}-`,
      padding: 5,
    });

    const result = await this.prisma.client.$transaction(async (tx) => {
      const grn = await tx.goodsReceiptNote.create({
        data: {
          organizationId: orgId,
          receiptNumber,
          partnerId: input.partnerId ?? null,
          branchId: input.branchId ?? null,
          warehouseId: input.warehouseId,
          receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
          status: 'posted',
          postedAt: new Date(),
          postedById: this.tenant.userId ?? null,
          notes: input.notes,
          createdBy: this.tenant.userId ?? null,
          lines: {
            create: input.lines.map((ln, idx) => ({
              organizationId: orgId,
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

      for (const ln of input.lines) {
        if (!ln.productId) continue;
        const product = await tx.product.findFirst({
          where: { id: ln.productId, organizationId: orgId },
        });
        if (!product) continue;
        await this.stock.receive(
          {
            productId: ln.productId,
            locationId: input.warehouseId,
            quantity: Number(ln.quantity),
            unitCost: ln.unitCost ?? 0,
            batchNumber: ln.batchNumber,
            expiryDate: ln.expiryDate ? new Date(ln.expiryDate) : undefined,
            reference: `GRN ${receiptNumber}`,
          } as any,
          tx,
        );
      }

      return grn;
    });

    await this.audit.record({
      entity: 'GoodsReceiptNote',
      entityId: result.id,
      action: 'create',
      newValues: { receiptNumber, lines: input.lines.length },
    });
    this.events.publish('goods_receipt.posted' as any, {
      organizationId: this.tenant.organizationId,
      receiptId: result.id,
      receiptNumber,
    });

    return result;
  }

  async create(input: CreateGRNInput & { purchaseOrderId?: string }) {
    const orgId = this.tenant.organizationId;
    if (!input.lines?.length) throw new BadRequestException('At least one line required');
    if (!input.warehouseId) throw new BadRequestException('Warehouse required');

    const warehouse = await this.prisma.raw.inventoryLocation.findFirst({
      where: { id: input.warehouseId, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const year = new Date().getUTCFullYear();
    const receiptNumber = await this.sequence.next(`grn:${year}`, {
      prefix: `GRN-${year}-`,
      padding: 5,
    });

    const grn = await this.prisma.client.goodsReceiptNote.create({
      data: {
        organizationId: orgId,
        receiptNumber,
        purchaseOrderId: input.purchaseOrderId ?? null,
        partnerId: input.partnerId ?? null,
        branchId: input.branchId ?? null,
        warehouseId: input.warehouseId,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        status: 'draft',
        notes: input.notes,
        createdBy: this.tenant.userId ?? null,
        lines: {
          create: input.lines.map((ln, idx) => ({
            organizationId: orgId,
            purchaseOrderLineId: (ln as any).purchaseOrderLineId ?? null,
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

    await this.audit.record({
      entity: 'GoodsReceiptNote',
      entityId: grn.id,
      action: 'create',
      newValues: { receiptNumber, lines: input.lines.length, status: 'draft' },
    });

    return grn;
  }

  async post(id: string) {
    const orgId = this.tenant.organizationId;
    const grn = await this.prisma.client.goodsReceiptNote.findFirst({
      where: { id, organizationId: orgId },
      include: { lines: true },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (grn.status !== 'draft') throw new BadRequestException('Only draft receipts can be posted');

    const result = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.goodsReceiptNote.update({
        where: { id },
        data: {
          status: 'posted',
          postedAt: new Date(),
          postedById: this.tenant.userId ?? null,
        },
        include: { lines: true },
      });

      for (const ln of updated.lines) {
        if (!ln.productId) continue;
        const product = await tx.product.findFirst({
          where: { id: ln.productId, organizationId: orgId },
        });
        if (!product) continue;
        await this.stock.receive(
          {
            productId: ln.productId,
            locationId: grn.warehouseId,
            quantity: Number(ln.quantity),
            unitCost: Number(ln.unitCost),
            batchNumber: ln.batchNumber,
            expiryDate: ln.expiryDate ? new Date(ln.expiryDate) : undefined,
            reference: `GRN ${grn.receiptNumber}`,
          } as any,
          tx,
        );
      }

      return updated;
    });

    await this.audit.record({
      entity: 'GoodsReceiptNote',
      entityId: result.id,
      action: 'post',
      newValues: { receiptNumber: grn.receiptNumber, status: 'posted' },
    });
    this.events.publish('goods_receipt.posted' as any, {
      organizationId: orgId,
      receiptId: result.id,
      receiptNumber: grn.receiptNumber,
    });

    return result;
  }

  async list(query: PaginationQuery & { status?: string }): Promise<PaginatedResult<any>> {
    const orgId = this.tenant.organizationId;
    const page = Math.max(1, Number(query.page) || DEFAULT_PAGE);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || DEFAULT_PAGE_SIZE));
    const where: any = { organizationId: orgId };

    if (query.status) where.status = query.status;

    if (query.search) {
      where.OR = [
        { receiptNumber: { contains: query.search, mode: 'insensitive' } },
        { notes: { contains: query.search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.client.goodsReceiptNote.findMany({
        where,
        include: { lines: true, order: { select: { orderNumber: true } } },
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.goodsReceiptNote.count({ where }),
    ]);

    return {
      data,
      meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async findOne(id: string) {
    const grn = await this.prisma.client.goodsReceiptNote.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        order: true,
        warehouse: { select: { id: true, code: true, name: true } },
      },
    });
    if (!grn) return null;

    const productIds = grn.lines.map((l) => l.productId).filter(Boolean) as string[];
    const products = productIds.length
      ? await this.prisma.client.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    const partner = grn.partnerId
      ? await this.prisma.client.partner.findFirst({
          where: { id: grn.partnerId },
          select: { id: true, name: true },
        })
      : null;

    return {
      ...grn,
      lines: grn.lines.map((l) => ({
        ...l,
        product: l.productId ? (productMap.get(l.productId) ?? null) : null,
      })),
      partner,
    };
  }
}
