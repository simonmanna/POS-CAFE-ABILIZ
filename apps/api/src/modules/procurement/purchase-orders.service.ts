import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { ThreeWayMatchService } from '../../kernel/three-way-match/three-way-match.service';
import type { CreatePODto, LinkBillDto, UpdatePODto } from './purchase-orders.dto';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly sequence: SequenceService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly twm: ThreeWayMatchService,
  ) {}

  async create(dto: CreatePODto) {
    const orgId = this.tenant.organizationId;
    if (!dto.lines?.length) throw new BadRequestException('At least one line required');
    const year = new Date().getUTCFullYear();
    const orderNumber = await this.sequence.next(`po:${year}`, { prefix: `PO-${year}-`, padding: 5 });

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
          expectedDeliveryDate: dto.expectedDeliveryDate ? new Date(dto.expectedDeliveryDate) : null,
          currencyCode: dto.currencyCode ?? 'USD',
          exchangeRate: dto.exchangeRate ?? 1,
          subtotal,
          taxAmount,
          totalAmount: total,
          status: 'draft',
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
      // If converted from a PR, mark the PR as converted.
      if (dto.requestId) {
        await tx.purchaseRequest.update({
          where: { id: dto.requestId },
          data: { status: 'converted' },
        });
      }
      return created;
    });

    await this.audit.record({
      entity: 'PurchaseOrder',
      entityId: order.id,
      action: 'create',
      newValues: { orderNumber, totalAmount: total },
    });
    this.events.publish('purchase_order.created' as any, {
      organizationId: orgId,
      orderId: order.id,
      orderNumber,
      partnerId: dto.partnerId,
    });
    // Initialize three-way match rows so the dashboard has data.
    await this.twm.recomputeForOrder(order.id);
    return order;
  }

  list(query: { status?: string; partnerId?: string }) {
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.status) where.status = query.status;
    if (query.partnerId) where.partnerId = query.partnerId;
    return this.prisma.client.purchaseOrder.findMany({
      where,
      include: {
        lines: true,
        receipts: true,
        bills: true,
        matchStatuses: true,
        _count: { select: { receipts: true, bills: true } },
      },
      orderBy: { orderDate: 'desc' },
      take: 200,
    });
  }

  findOne(id: string) {
    return this.prisma.client.purchaseOrder.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: {
        lines: true,
        receipts: { include: { lines: true } },
        bills: true,
        matchStatuses: true,
        request: true,
      },
    });
  }

  async update(id: string, dto: UpdatePODto) {
    const order = await this.requireOwned(id);
    if (order.status !== 'draft') throw new BadRequestException('Only drafts can be edited');
    return this.prisma.client.purchaseOrder.update({
      where: { id },
      data: {
        description: dto.description,
        expectedDeliveryDate: dto.expectedDeliveryDate ? new Date(dto.expectedDeliveryDate) : null,
        notes: dto.notes,
        terms: dto.terms,
      },
    });
  }

  async submit(id: string) {
    await this.requireOwned(id);
    return this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'submitted' },
    });
  }

  async approve(id: string) {
    const order = await this.requireOwned(id);
    if (!['draft', 'submitted'].includes(order.status)) {
      throw new BadRequestException(`Cannot approve PO in status ${order.status}`);
    }
    const updated = await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        approvedById: this.tenant.userId ?? null,
      },
    });
    await this.audit.record({
      entity: 'PurchaseOrder',
      entityId: id,
      action: 'approve',
      newValues: { status: 'approved' },
    });
    this.events.publish('purchase_order.approved' as any, {
      organizationId: this.tenant.organizationId,
      orderId: id,
      approverId: this.tenant.userId,
    });
    return updated;
  }

  async sendToSupplier(id: string) {
    const order = await this.requireOwned(id);
    if (order.status !== 'approved') {
      throw new BadRequestException(`PO must be approved before sending; current status: ${order.status}`);
    }
    const updated = await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date() },
    });
    this.events.publish('purchase_order.sent' as any, {
      organizationId: this.tenant.organizationId,
      orderId: id,
      sentAt: new Date().toISOString(),
    });
    return updated;
  }

  async cancel(id: string, reason?: string) {
    const order = await this.requireOwned(id);
    if (['closed', 'billed', 'cancelled'].includes(order.status)) {
      throw new BadRequestException(`Cannot cancel PO in status ${order.status}`);
    }
    const updated = await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    this.events.publish('purchase_order.cancelled' as any, {
      organizationId: this.tenant.organizationId,
      orderId: id,
      reason: reason ?? '',
    });
    return updated;
  }

  async linkBill(id: string, dto: LinkBillDto) {
    const orgId = this.tenant.organizationId;
    const order = await this.requireOwned(id);
    if (!order.partnerId) throw new BadRequestException('PO has no partner');
    const bill = await this.prisma.raw.document.findFirst({
      where: { id: dto.vendorBillId, organizationId: orgId, documentType: 'vendor_bill' },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found');
    if (bill.partnerId !== order.partnerId) {
      throw new BadRequestException('Bill partner does not match PO partner');
    }
    const link = await this.prisma.client.vendorBillLink.upsert({
      where: { vendorBillId_purchaseOrderId: { vendorBillId: dto.vendorBillId, purchaseOrderId: id } },
      update: { amount: dto.amount, notes: dto.notes },
      create: {
        organizationId: orgId,
        vendorBillId: dto.vendorBillId,
        purchaseOrderId: id,
        amount: dto.amount,
        notes: dto.notes,
      },
    });
    // Update billed quantity on lines (greedy: distribute by line ordered qty).
    await this.allocateBillToLines(id, dto.vendorBillId, dto.amount);
    await this.twm.recomputeForOrder(id);
    return link;
  }

  private async allocateBillToLines(orderId: string, billId: string, billAmount: number) {
    const lines = await this.prisma.raw.purchaseOrderLine.findMany({
      where: { organizationId: this.tenant.organizationId, purchaseOrderId: orderId },
      orderBy: { lineNumber: 'asc' },
    });
    if (lines.length === 0) return;
    const totalOrderedValue = lines.reduce(
      (s, l: any) => s + Number(l.quantity) * Number(l.unitPrice),
      0,
    );
    if (totalOrderedValue <= 0) return;
    // Distribute billAmount proportionally; cap at ordered quantity per line.
    let remaining = billAmount;
    for (const ln of lines) {
      const lineOrderedValue = Number(ln.quantity) * Number(ln.unitPrice);
      const share = (lineOrderedValue / totalOrderedValue) * billAmount;
      const maxForLine = Number(ln.quantity) * Number(ln.unitPrice);
      const capped = Math.min(share, maxForLine);
      const billedQty = Number(ln.unitPrice) > 0 ? capped / Number(ln.unitPrice) : 0;
      await this.prisma.raw.purchaseOrderLine.update({
        where: { id: ln.id },
        data: { billedQuantity: billedQty },
      });
      remaining -= capped;
    }
  }

  async recomputeMatch(id: string) {
    const order = await this.requireOwned(id);
    return this.twm.recomputeForOrder(order.id);
  }

  async remove(id: string) {
    const order = await this.requireOwned(id);
    if (order.status !== 'draft') throw new BadRequestException('Only drafts can be deleted');
    await this.prisma.client.purchaseOrder.delete({ where: { id } });
    return { ok: true };
  }

  private async requireOwned(id: string) {
    const order = await this.prisma.client.purchaseOrder.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    return order;
  }
}
