import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { ApprovalsService } from '../../kernel/approvals/approvals.service';
import { StockService } from '../inventory/stock.service';
import { StockPostingService } from '../inventory/posting/stock-posting.service';
import { StockReversalService } from '../inventory/stock-reversal.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { dec, ZERO } from '../../kernel/common/money';
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
    private readonly approvals: ApprovalsService,
    private readonly stock: StockService,
    private readonly stockPosting: StockPostingService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly reversals: StockReversalService,
  ) {}

  /**
   * Capture + post in one call for ad-hoc stock-ins with no PO. It is exactly
   * {@link createDraft} followed by {@link post}, so it inherits the same
   * approval gate, atomic claim and product validation. A caller without
   * `goods_receipt:post` (a receiving clerk) only ever gets a draft — capturing
   * a delivery note must not also commit it to stock and the GL.
   */
  async createAdhoc(input: CreateGRNInput) {
    if (!input.lines?.length) throw new BadRequestException('At least one line required');
    const draft = await this.createDraft(input);
    if (!this.tenant.has('goods_receipt:post')) return draft;

    const gate = await this.approvals.checkOrRequestApproval({
      entityType: 'goods_receipt',
      entityId: draft.id,
      snapshot: this.approvalSnapshot(draft),
    });
    if (gate?.needsApproval) return draft;
    return this.post(draft.id);
  }

  /** Approval snapshot: `amount` is the receipt's money value (see approval amount units). */
  private approvalSnapshot(grn: { receiptNumber: string; partnerId: string | null; purchaseOrderId?: string | null; lines: Array<{ quantity: any; unitCost: any }> }) {
    const amount = grn.lines.reduce((s, l) => s.plus(dec(l.quantity).times(dec(l.unitCost ?? 0))), ZERO);
    return {
      amount: Number(amount),
      receiptNumber: grn.receiptNumber,
      partnerId: grn.partnerId ?? null,
      purchaseOrderId: grn.purchaseOrderId ?? null,
      createdBy: this.tenant.userId ?? null,
    };
  }

  /**
   * Capture a delivery note as a DRAFT goods receipt. Deliberately inert: no
   * stock movement, no GL, no PO advance. The only way a GRN affects inventory
   * is {@link post}, which is the single audited draft→posted transition and
   * carries the approval check + `applyReceiptToPO` over-receipt guard.
   *
   * The three canonical entry points are therefore:
   *   - {@link createDraft} → {@link post} — clerk captures, supervisor posts
   *   - {@link createAdhoc} — capture + post in one step for ad-hoc stock-ins
   *     that reference no PO (POST /procurement/goods-receipts/adhoc)
   *   - {@link PurchaseOrdersService.receive} — PO-driven receive that creates
   *     and posts the GRN inside the PO's own $transaction
   */
  async createDraft(input: CreateGRNInput & { purchaseOrderId?: string }) {
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

    // Check that no pending or rejected approval blocks posting
    const approvalReq = await this.prisma.client.approvalRequest.findFirst({
      where: {
        organizationId: orgId,
        entityType: 'goods_receipt',
        entityId: id,
        status: { in: ['pending', 'rejected'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (approvalReq) {
      if (approvalReq.status === 'pending') {
        throw new BadRequestException(
          `Goods receipt is pending approval (request ${approvalReq.id}) and cannot be posted yet`,
        );
      }
      if (approvalReq.status === 'rejected') {
        throw new BadRequestException(
          'Goods receipt was rejected and cannot be posted',
        );
      }
    }
    // Enforce the goods_receipt approval policy here, not only at ad-hoc
    // creation: a draft created via createDraft never requested approval, so
    // posting it used to bypass the policy entirely.
    const gate = await this.approvals.checkOrRequestApproval({
      entityType: 'goods_receipt',
      entityId: id,
      snapshot: this.approvalSnapshot(grn),
    });
    if (gate?.needsApproval) {
      throw new BadRequestException(
        `Goods receipt requires approval before posting (request ${gate.requestId})`,
      );
    }

    // Every product line must resolve now — posting a GRN whose line silently
    // received nothing leaves the delivery half-booked.
    const productIds = [...new Set(grn.lines.map((l) => l.productId).filter(Boolean))] as string[];
    if (productIds.length) {
      const found = await this.prisma.client.product.findMany({
        where: { id: { in: productIds }, organizationId: orgId },
        select: { id: true },
      });
      const missing = productIds.filter((pid) => !found.some((f) => f.id === pid));
      if (missing.length) throw new NotFoundException(`Product(s) not found: ${missing.join(', ')}`);
    }

    const result = await this.prisma.client.$transaction(async (tx) => {
      // Atomic draft→posted claim. The status check above is outside the tx, so
      // two concurrent posts (distinct idempotency keys) would both see 'draft'
      // and both receive the delivery. Only one updateMany can match.
      const claim = await tx.goodsReceiptNote.updateMany({
        where: { id, organizationId: orgId, status: 'draft' },
        data: {
          status: 'posted',
          postedAt: new Date(),
          postedById: this.tenant.userId ?? null,
        },
      });
      if (claim.count === 0) {
        throw new ConflictException('Goods receipt was already posted by another request');
      }
      const updated = await tx.goodsReceiptNote.findFirstOrThrow({
        where: { id, organizationId: orgId },
        include: { lines: true },
      });

      // Advance the referenced PO (over-receipt block + receivedQuantity +
      // status) so a GRN-screen receipt keeps the PO in sync — previously it
      // stocked the warehouse while the PO stayed at 0 received, which let the
      // same goods be received a second time via the PO endpoint.
      let po: any = null;
      if (grn.purchaseOrderId) {
        await this.purchaseOrders.applyReceiptToPO(
          tx,
          grn.purchaseOrderId,
          updated.lines.map((l: any) => ({
            purchaseOrderLineId: l.purchaseOrderLineId ?? undefined,
            productId: l.productId ?? undefined,
            quantity: Number(l.quantity),
            description: l.description,
          })),
        );
        po = await tx.purchaseOrder.findFirst({
          where: { id: grn.purchaseOrderId, organizationId: orgId },
          include: { lines: true },
        });
      }
      const poLineById = new Map<string, any>((po?.lines ?? []).map((l: any) => [l.id, l]));

      let receiptNet = ZERO;
      let receiptTax = ZERO;
      for (const ln of updated.lines) {
        if (!ln.productId) continue;
        const product = await tx.product.findFirst({
          where: { id: ln.productId, organizationId: orgId },
        });
        if (!product) continue;
        const unitCost = Number(ln.unitCost);
        const received = await this.stock.receiveForDocument(
          {
            productId: ln.productId,
            locationId: grn.warehouseId,
            quantity: Number(ln.quantity),
            unitCost: unitCost > 0 ? unitCost : Number(product.costPrice ?? 0),
            uomId: product.purchaseUomId ?? undefined,
            batchNumber: ln.batchNumber,
            expiryDate: ln.expiryDate ? new Date(ln.expiryDate) : undefined,
            reference: `GRN ${grn.receiptNumber}`,
          } as any,
          {
            sourceType: 'goods_receipt',
            sourceId: grn.id,
            date: grn.receivedAt ?? new Date(),
          },
          tx,
        );
        const lineNet = dec(received.totalValue);
        receiptNet = receiptNet.plus(lineNet);
        if (po) {
          const poLine = ln.purchaseOrderLineId ? poLineById.get(ln.purchaseOrderLineId) : undefined;
          const taxRate = poLine ? dec(poLine.taxRate ?? 0) : ZERO;
          receiptTax = receiptTax.plus(lineNet.times(taxRate).dividedBy(100));
        }
      }

      // Voucher to the supplier ONLY on the simple PO flow (the PO acts as the
      // bill): Dr GRNI + Dr Input Tax / Cr AP, so GRNI nets to zero. Ad-hoc GRNs
      // with no PO intentionally leave GRNI open as received-not-invoiced, to be
      // cleared by a later vendor bill — vouchering them here would double-count.
      if (po) {
        await this.stockPosting.postReceiptVoucher({
          partnerId: po.partnerId,
          netTotal: receiptNet,
          taxTotal: receiptTax,
          date: grn.receivedAt ?? new Date(),
          sourceType: 'goods_receipt',
          sourceId: grn.id,
          description: `Goods received ${grn.receiptNumber} · PO ${po.orderNumber}`,
          tx,
        });
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

  /**
   * Posted reversal of a goods receipt: returns the received quantities out of
   * stock, mirrors every journal the receipt posted (Dr Stock / Cr GRNI, and the
   * PO voucher Dr GRNI / Cr AP) in the current period, and rolls the PO's
   * received quantities back. Refused once a vendor bill has been matched to
   * the receipt or the PO has payments — reverse those documents first, or
   * return the goods through a debit note.
   */
  async reverse(id: string, reason: string) {
    const orgId = this.tenant.organizationId;
    if (!reason?.trim()) throw new BadRequestException('A reason is required to reverse a goods receipt');
    const grn = await this.prisma.client.goodsReceiptNote.findFirst({
      where: { id, organizationId: orgId },
      include: { lines: true },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (grn.status === 'reversed' || grn.reversedAt) throw new ConflictException(`Goods receipt ${grn.receiptNumber} is already reversed`);
    if (grn.status !== 'posted') throw new BadRequestException('Only posted goods receipts can be reversed');

    const matched = await this.prisma.client.vendorBillReceiptMatch.count({
      where: { organizationId: orgId, goodsReceiptLineId: { in: grn.lines.map((l) => l.id) } },
    });
    if (matched > 0) {
      throw new BadRequestException(
        `Goods receipt ${grn.receiptNumber} is matched to a vendor bill — reverse the bill or raise a debit note instead`,
      );
    }
    if (grn.purchaseOrderId) {
      const [links, payments] = await Promise.all([
        this.prisma.client.vendorBillLink.count({ where: { organizationId: orgId, purchaseOrderId: grn.purchaseOrderId } }),
        this.prisma.client.purchasePayment.count({ where: { organizationId: orgId, purchaseOrderId: grn.purchaseOrderId } }),
      ]);
      if (links > 0 || payments > 0) {
        throw new BadRequestException(
          `The purchase order for ${grn.receiptNumber} already has ${links > 0 ? 'a vendor bill' : 'payments'} — return the goods with a debit note instead`,
        );
      }
    }

    const result = await this.prisma.client.$transaction(
      async (tx: any) => {
        const claim = await tx.goodsReceiptNote.updateMany({
          where: { id, organizationId: orgId, status: 'posted', reversedAt: null },
          data: { status: 'reversed', reversedAt: new Date(), reversedById: this.tenant.userId ?? null, reversalReason: reason.trim() },
        });
        if (claim.count === 0) throw new ConflictException('Goods receipt was reversed concurrently');

        const hasStock = grn.lines.some((l) => l.productId);
        if (hasStock) {
          await this.reversals.reverseLedgerSource(tx, {
            referenceType: 'goods_receipt',
            referenceId: grn.id,
            reversalSourceType: 'goods_receipt_reversal',
            reversalSourceId: grn.id,
            journalSourceTypes: ['goods_receipt'],
            notes: `Reversal of GRN ${grn.receiptNumber}: ${reason.trim()}`,
          });
        }

        if (grn.purchaseOrderId) {
          const po = await tx.purchaseOrder.findFirst({ where: { id: grn.purchaseOrderId, organizationId: orgId }, include: { lines: true } });
          if (po) {
            const byProduct = new Map<string, any[]>();
            for (const l of po.lines) if (l.productId) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
            for (const ln of grn.lines) {
              const poLineId = ln.purchaseOrderLineId ?? (ln.productId && byProduct.get(ln.productId)?.length === 1 ? byProduct.get(ln.productId)![0].id : null);
              if (!poLineId) continue;
              await tx.purchaseOrderLine.updateMany({
                where: { id: poLineId },
                data: { receivedQuantity: { decrement: ln.quantity }, version: { increment: 1 } },
              });
            }
            const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
            const anyReceived = lines.some((l: any) => Number(l.receivedQuantity) > 0);
            const allReceived = lines.every((l: any) => Number(l.receivedQuantity) >= Number(l.quantity));
            const status = allReceived ? 'received' : anyReceived ? 'partially_received' : 'active';
            await tx.purchaseOrder.updateMany({
              where: { id: po.id, organizationId: orgId },
              data: { status, version: { increment: 1 } },
            });
          }
        }

        await this.audit.recordInTx(tx, {
          entity: 'GoodsReceiptNote',
          entityId: grn.id,
          action: 'update',
          newValues: { status: 'reversed', reason: reason.trim(), receiptNumber: grn.receiptNumber },
        });
        return tx.goodsReceiptNote.findFirst({ where: { id }, include: { lines: true } });
      },
      { timeout: 60_000 },
    );
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
