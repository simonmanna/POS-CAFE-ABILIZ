import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { StockService } from '../inventory/stock.service';
import type {
  CreatePODto,
  ReceivePODto,
  PayPODto,
  ReceiveLineDto,
  UpdatePODto,
} from './purchase-orders.dto';

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger('PurchaseOrders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly sequence: SequenceService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  // ── Step 1: Register Purchase ──────────────────────────────────────────

  async create(dto: CreatePODto) {
    const orgId = this.tenant.organizationId;
    if (!dto.lines?.length)
      throw new BadRequestException('At least one line required');
    if (!dto.warehouseId)
      throw new BadRequestException('Warehouse is required');

    // Validate warehouse exists
    const warehouse = await this.prisma.raw.inventoryLocation.findFirst({
      where: { id: dto.warehouseId, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    // Validate partner exists (basic FK guard)
    if (dto.partnerId) {
      const partner = await this.prisma.raw.partner.findFirst({
        where: { id: dto.partnerId, organizationId: orgId },
      });
      if (!partner) throw new NotFoundException('Supplier not found');
    }

    const year = new Date().getUTCFullYear();
    const orderNumber = await this.sequence.next(`po:${year}`, {
      prefix: `PO-${year}-`,
      padding: 5,
    });

    let subtotal = 0;
    let taxAmount = 0;
    for (const ln of dto.lines) {
      const lineSubtotal = Number(ln.quantity) * Number(ln.unitPrice);
      const lineTax = lineSubtotal * (Number(ln.taxRate ?? 0) / 100);
      subtotal += lineSubtotal;
      taxAmount += lineTax;
    }
    const total = subtotal + taxAmount;

    const order = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          organizationId: orgId,
          orderNumber,
          partnerId: dto.partnerId,
          branchId: dto.branchId,
          description: dto.description,
          expectedDeliveryDate: dto.expectedDeliveryDate
            ? new Date(dto.expectedDeliveryDate)
            : null,
          currencyCode: dto.currencyCode ?? 'USD',
          exchangeRate: dto.exchangeRate ?? 1,
          subtotal,
          taxAmount,
          totalAmount: total,
          status: 'active',
          paymentType: dto.paymentType ?? 'cash',
          paymentStatus: dto.paymentType === 'credit' ? 'not_paid' : null,
          notes: dto.notes,
          terms: dto.terms,
          requestId: dto.requestId,
          createdBy: this.tenant.userId ?? null,
          lines: {
            create: dto.lines.map((ln, idx) => ({
              organizationId: orgId,
              productId: ln.productId ?? null,
              description: ln.description,
              quantity: ln.quantity,
              unitOfMeasureId: ln.unitOfMeasureId ?? null,
              unitPrice: ln.unitPrice,
              taxId: ln.taxId ?? null,
              taxRate: ln.taxRate ?? 0,
              subtotal: Number(ln.quantity) * Number(ln.unitPrice),
              lineNumber: idx + 1,
              notes: ln.notes ?? null,
            })),
          },
        },
        include: { lines: true },
      });
      return created;
    });

    await this.audit.record({
      entity: 'PurchaseOrder',
      entityId: order.id,
      action: 'create',
      newValues: { orderNumber, totalAmount: total, paymentType: dto.paymentType },
    });
    this.events.publish('purchase_order.created' as any, {
      organizationId: orgId,
      orderId: order.id,
      orderNumber,
      partnerId: dto.partnerId,
    });
    return order;
  }

  // ── Listing & detail ───────────────────────────────────────────────────

  async list(query: {
    status?: string;
    paymentType?: string;
    paymentStatus?: string;
    partnerId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.status) where.status = query.status;
    if (query.paymentType) where.paymentType = query.paymentType;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
    if (query.partnerId) where.partnerId = query.partnerId;
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { paymentType: { contains: query.search, mode: 'insensitive' } },
        { paymentStatus: { contains: query.search, mode: 'insensitive' } },
        { status: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.dateFrom) {
      where.orderDate = { ...(where.orderDate || {}), gte: new Date(query.dateFrom) };
    }
    if (query.dateTo) {
      const end = new Date(query.dateTo);
      end.setHours(23, 59, 59, 999);
      where.orderDate = { ...(where.orderDate || {}), lte: end };
    }
    const [data, total] = await Promise.all([
      this.prisma.client.purchaseOrder.findMany({
        where,
        include: { partner: { select: { id: true, name: true } } },
        orderBy: { orderDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.purchaseOrder.count({ where }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  findOne(id: string) {
    return this.prisma.client.purchaseOrder.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: {
        lines: true,
        receipts: { include: { lines: true } },
        payments: true,
        request: true,
      },
    });
  }

  // ── Step 2: Receive Products ───────────────────────────────────────────

  async receive(id: string, dto: ReceivePODto) {
    const orgId = this.tenant.organizationId;

    if (!dto.warehouseId)
      throw new BadRequestException('Warehouse is required for receiving stock');
    if (!dto.lines?.length)
      throw new BadRequestException('At least one line required');

    const warehouse = await this.prisma.raw.inventoryLocation.findFirst({
      where: { id: dto.warehouseId, organizationId: orgId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    // Load PO with lines (must include version for optimistic locking)
    const po = await this.prisma.client.purchaseOrder.findFirst({
      where: { id, organizationId: orgId },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    // Guard: PO must be active or partially received
    if (po.status === 'cancelled')
      throw new BadRequestException('Cannot receive against a cancelled PO');
    if (po.status === 'received')
      throw new BadRequestException('PO is fully received');
    if (!['active', 'partially_received'].includes(po.status))
      throw new BadRequestException(
        `PO is in status "${po.status}" — cannot receive`,
      );

    // Cache PO lines by ID AND productId for fast lookup
    const poLines = new Map(po.lines.map((l) => [l.id, l]));
    const poLinesByProduct = new Map(
      po.lines.filter((l) => l.productId).map((l) => [l.productId!, l]),
    );

    // Resolve the effective PO line ID for each receive line
    function resolvePOLineId(rln: ReceiveLineDto): string | null {
      if (rln.purchaseOrderLineId) {
        if (!poLines.has(rln.purchaseOrderLineId))
          throw new BadRequestException(
            `PO line ${rln.purchaseOrderLineId} not found`,
          );
        return rln.purchaseOrderLineId;
      }
      if (rln.productId) {
        const match = poLinesByProduct.get(rln.productId);
        if (match) return match.id;
      }
      return null;
    }

    // Resolve once and attach back so both loops use the same resolution
    const resolvedLines = dto.lines.map((rln) => ({
      ...rln,
      _resolvedLineId: resolvePOLineId(rln),
    }));

    // Validate each receive line against the PO line
    for (const rln of resolvedLines) {
      const lineId = rln._resolvedLineId;
      if (!lineId) continue;
      const poLine = poLines.get(lineId)!;
      const ordered = Number(poLine.quantity);
      const alreadyReceived = Number(poLine.receivedQuantity);
      const nowReceiving = Number(rln.quantity);
      if (alreadyReceived + nowReceiving > ordered) {
        throw new BadRequestException(
          `Over-receiving PO line "${poLine.description}": ordered ${ordered}, already received ${alreadyReceived}, trying to receive ${nowReceiving}`,
        );
      }
    }

    // Generate GRN number
    const year = new Date().getUTCFullYear();
    const receiptNumber = await this.sequence.next(`grn:${year}`, {
      prefix: `GRN-${year}-`,
      padding: 5,
    });

    // Everything in ONE transaction — stock, GRN, PO status, PO lines
    const result = await this.prisma.client.$transaction(async (tx) => {
      // 1. Create GRN (draft)
      const grn = await tx.goodsReceiptNote.create({
        data: {
          organizationId: orgId,
          receiptNumber,
          purchaseOrderId: id,
          partnerId: po.partnerId,
          branchId: po.branchId,
          warehouseId: dto.warehouseId,
          receivedAt: dto.receivedAt
            ? new Date(dto.receivedAt)
            : new Date(),
          status: 'draft',
          notes: dto.notes,
          createdBy: this.tenant.userId ?? null,
          lines: {
            create: resolvedLines.map((rln, idx) => ({
              organizationId: orgId,
              purchaseOrderLineId: rln._resolvedLineId,
              productId: rln.productId ?? null,
              description: rln.description,
              quantity: rln.quantity,
              unitCost: rln.unitCost ?? 0,
              batchNumber: rln.batchNumber ?? null,
              expiryDate: rln.expiryDate
                ? new Date(rln.expiryDate)
                : null,
              notes: rln.notes ?? null,
              lineNumber: idx + 1,
            })),
          },
        },
        include: { lines: true },
      });

      // 2. Update PO line receivedQuantity + version (concurrency guard)
      for (const rln of resolvedLines) {
        const lineId = rln._resolvedLineId;
        if (!lineId) continue;
        const poLine = poLines.get(lineId)!;
        // Optimistic lock: only update if version matches
        const updatedLine = await tx.purchaseOrderLine.updateMany({
          where: {
            id: lineId,
            version: poLine.version,
          },
          data: {
            receivedQuantity: { increment: rln.quantity },
            version: { increment: 1 },
          },
        });
        if (updatedLine.count === 0) {
          throw new BadRequestException(
            `PO line "${poLine.description}" was modified by another user. Please refresh and try again.`,
          );
        }
      }

      // 3. Post GRN
      await tx.goodsReceiptNote.update({
        where: { id: grn.id },
        data: {
          status: 'posted',
          postedAt: new Date(),
          postedById: this.tenant.userId ?? null,
        },
      });

      // 4. Issue stock-in for each line (only stockable products)
      for (const rln of dto.lines) {
        if (!rln.productId) continue;
        const product = await tx.product.findFirst({
          where: { id: rln.productId, organizationId: orgId },
        });
        if (!product?.trackInventory) continue;
        // Use stock service's receiveCore via raw query fallback
        await this.stock.receive(
          {
            productId: rln.productId,
            locationId: dto.warehouseId,
            quantity: Number(rln.quantity),
            unitCost: rln.unitCost ?? 0,
            batchNumber: rln.batchNumber,
            expiryDate: rln.expiryDate ? new Date(rln.expiryDate) : undefined,
            reference: `GRN ${receiptNumber}`,
          } as any,
          tx,
        );
      }

      // 5. Determine if PO is fully received
      const allLines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: id },
      });
      const fullyReceived = allLines.every(
        (l: any) => Number(l.receivedQuantity) >= Number(l.quantity),
      );
      const newStatus = fullyReceived ? 'received' : 'partially_received';

      // 6. Update PO status + optimistic lock on PO
      const updatedPo = await tx.purchaseOrder.updateMany({
        where: { id, organizationId: orgId, version: po.version },
        data: {
          status: newStatus,
          version: { increment: 1 },
        },
      });
      if (updatedPo.count === 0) {
        throw new BadRequestException(
          'Purchase order was modified by another user. Please refresh and try again.',
        );
      }

      // 7. If cash purchase, auto-settle payment
      if (po.paymentType === 'cash') {
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            totalPaid: po.totalAmount,
            paymentStatus: 'paid',
          },
        });
        await tx.purchasePayment.create({
          data: {
            organizationId: orgId,
            purchaseOrderId: id,
            amount: po.totalAmount,
            paidAt: new Date(),
            paidById: this.tenant.userId ?? null,
            reference: `auto:GRN ${receiptNumber}`,
          },
        });
      }

      return { grn, status: newStatus };
    });

    await this.audit.record({
      entity: 'PurchaseOrder',
      entityId: id,
      action: 'receive',
      newValues: {
        receiptNumber,
        status: result.status,
        linesReceived: dto.lines.length,
      },
    });
    this.events.publish('purchase_order.received' as any, {
      organizationId: orgId,
      orderId: id,
      receiptNumber,
      status: result.status,
    });

    return result;
  }

  // ── Step 3: Register Payment (credit purchases only) ───────────────────

  async pay(id: string, dto: PayPODto) {
    const orgId = this.tenant.organizationId;
    const po = await this.requireOwned(id);

    if (po.paymentType !== 'credit')
      throw new BadRequestException(
        'Only credit purchases can accept manual payments',
      );
    if (po.status === 'cancelled')
      throw new BadRequestException('Cannot pay a cancelled PO');

    const amount = dto.amount ?? Number(po.totalAmount) - Number(po.totalPaid);
    if (amount <= 0)
      throw new BadRequestException('Payment amount must be positive');

    const remaining = Number(po.totalAmount) - Number(po.totalPaid);
    if (amount > remaining) {
      throw new BadRequestException(
        `Payment of ${amount} exceeds remaining balance of ${remaining}`,
      );
    }

    const newTotalPaid = Number(po.totalPaid) + amount;
    const newPaymentStatus =
      newTotalPaid >= Number(po.totalAmount) ? 'paid' : 'partial';

    const result = await this.prisma.client.$transaction(async (tx) => {
      // 1. Record payment
      const payment = await tx.purchasePayment.create({
        data: {
          organizationId: orgId,
          purchaseOrderId: id,
          amount,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          paidById: this.tenant.userId ?? null,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
        },
      });

      // 2. Update PO totalPaid and paymentStatus
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          totalPaid: newTotalPaid,
          paymentStatus: newPaymentStatus,
          version: { increment: 1 },
        },
      });

      return payment;
    });

    await this.audit.record({
      entity: 'PurchaseOrder',
      entityId: id,
      action: 'update',
      newValues: {
        paymentStatus: newPaymentStatus,
        amountPaid: amount,
      },
    });
    this.events.publish('purchase_order.paid' as any, {
      organizationId: orgId,
      orderId: id,
      amount,
    });

    return result;
  }

  // ── Cancel (simple flow: no approval needed) ───────────────────────────

  async update(id: string, dto: UpdatePODto) {
    const po = await this.requireOwned(id);
    if (po.status !== 'active')
      throw new BadRequestException('Only active POs can be updated');
    return this.prisma.client.purchaseOrder.update({
      where: { id },
      data: {
        description: dto.description,
        expectedDeliveryDate: dto.expectedDeliveryDate
          ? new Date(dto.expectedDeliveryDate)
          : null,
        notes: dto.notes,
        terms: dto.terms,
      },
    });
  }

  async cancel(id: string, reason?: string) {
    const po = await this.requireOwned(id);
    if (['received', 'cancelled'].includes(po.status))
      throw new BadRequestException(`Cannot cancel PO in status ${po.status}`);

    const updated = await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'cancelled', notes: reason ?? po.notes },
    });
    this.events.publish('purchase_order.cancelled' as any, {
      organizationId: this.tenant.organizationId,
      orderId: id,
      reason: reason ?? '',
    });
    return updated;
  }

  // ── Delete (draft PO only) ─────────────────────────────────────────────

  async remove(id: string) {
    const po = await this.requireOwned(id);
    if (po.status === 'received' || po.status === 'cancelled') {
      throw new BadRequestException(
        'Cannot delete a received or cancelled PO',
      );
    }
    await this.prisma.client.purchaseOrder.delete({ where: { id } });
    return { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async requireOwned(id: string) {
    const order = await this.prisma.client.purchaseOrder.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    return order;
  }
}
