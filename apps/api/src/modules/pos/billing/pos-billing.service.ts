/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EVENTS } from '@erp/shared';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { dec } from '../../../kernel/common/money';
import { DocumentBuilderService } from '../../invoicing/document/document-builder.service';
import { InvoiceService } from '../../invoicing/invoice/invoice.service';
import { PaymentService } from '../../invoicing/payment/payment.service';
import { PostingService } from '../../accounting/posting/posting.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';
import { StockService } from '../../inventory/stock.service';
import { PosTablesService } from '../pos-tables.service';
import { PosReceiptsService } from '../pos-receipts.service';
import type { GenerateInvoiceDto, ReceivePaymentDto, SettleCreditDto, WriteOffDto, TenderDto } from '../order/dto/order.dto';

const MODE_FROM_METHOD: Record<string, 'cash' | 'card' | 'mobile_money'> = {
  cash: 'cash', bank: 'card', card: 'card', mobile_money: 'mobile_money', store_credit: 'card',
};

/**
 * Billing layer of the Order→Invoice→Receipt split. Turns an operational Order
 * into a financial Invoice (Document), deducts inventory at bill time, takes
 * payment(s), and emits typed Receipts. Also owns the credit (postpaid AR) path
 * and write-offs. Reuses the proven invoice/payment/posting services so the GL
 * stays authoritative.
 */
@Injectable()
export class PosBillingService {
  private readonly logger = new Logger('PosBillingService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly builder: DocumentBuilderService,
    private readonly invoices: InvoiceService,
    private readonly payments: PaymentService,
    private readonly posting: PostingService,
    private readonly determination: AccountDeterminationService,
    private readonly stock: StockService,
    private readonly tables: PosTablesService,
    private readonly receipts: PosReceiptsService,
  ) {}

  /**
   * Generate the bill: build + post the invoice (books AR), deduct inventory,
   * link it back to the order. Idempotent — a second call returns the existing
   * invoice. This is the "Customer requests bill" step.
   */
  async generateInvoice(orderId: string, dto: GenerateInvoiceDto = {}) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.order.findFirst({ where: { id: orderId, organizationId: orgId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'cancelled') throw new BadRequestException('Cannot bill a cancelled order');
    if (order.invoiceId) return this.invoices.findOne(order.invoiceId); // idempotent

    const items = await this.prisma.client.orderItem.findMany({
      where: { orderId, cancelled: false }, orderBy: { lineNumber: 'asc' },
    });
    if (!items.length) throw new BadRequestException('Order has no items to bill');

    const txPct = dto.transactionDiscountPercent ?? Number(order.transactionDiscountPercent ?? 0);

    // 1) Build the draft invoice from the order's items.
    const doc = await this.builder.createDocument(
      this.prisma.client,
      'sales_invoice',
      {
        partnerId: order.partnerId!,
        branchId: dto.branchId ?? order.branchId ?? undefined,
        sourceType: 'pos',
        issueDate: new Date().toISOString(),
        reference: order.orderNumber,
      } as any,
      items.map((it: any) => ({
        productId: it.productId ?? undefined,
        menuItemId: it.menuItemId ?? undefined,
        description: it.description,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        taxId: it.taxId ?? undefined,
        discountPercent: Number(it.discountPercent ?? 0),
        taxInclusive: it.taxInclusive,
      })),
    );

    // Order-level discount → adjust the document total before posting.
    if (txPct > 0) {
      const txDisc = dec(doc.totalAmount).times(dec(txPct).dividedBy(100));
      const adjustedTotal = dec(doc.totalAmount).minus(txDisc);
      await this.prisma.client.document.update({
        where: { id: doc.id },
        data: { totalAmount: adjustedTotal, amountResidual: adjustedTotal, discountTotal: dec(doc.discountTotal ?? 0).plus(txDisc) },
      });
      (doc as any).totalAmount = adjustedTotal;
    }

    // 2) Post the invoice (Dr AR / Cr Revenue+Tax) and deduct inventory. If
    //    either fails, cancel the draft so a failed bill is a no-op on the books.
    try {
      await this.invoices.post(doc.id);
      await this.issueStockForItems(items, doc.documentNumber);
    } catch (e: any) {
      await this.invoices.cancel(doc.id).catch(() => undefined);
      throw e;
    }

    // 3) Link order → invoice, stamp settlement defaults.
    await this.prisma.client.document.update({
      where: { id: doc.id },
      data: { paymentMode: dto.paymentMode ?? null, settlementStatus: 'unsettled' },
    });
    await this.prisma.client.order.update({ where: { id: orderId }, data: { invoiceId: doc.id, status: 'served' } });

    // 4) Link the table for occupancy/revenue reports (existing PosTableOrder machinery).
    if (order.tableId) {
      await this.tables.attachSaleToTable({ tableId: order.tableId, documentId: doc.id, guestCount: order.guestCount ?? undefined })
        .catch((e) => this.logger.warn(`attachSaleToTable failed: ${String(e?.message ?? e)}`));
    }

    this.events.publish(EVENTS.PosOrderInvoiced, {
      organizationId: orgId, orderId, invoiceId: doc.id, invoiceNumber: (doc as any).documentNumber,
    });
    await this.audit.record({ entity: 'Order', entityId: orderId, action: 'post' as any, newValues: { kind: 'invoice_generated', invoiceId: doc.id } });
    return this.invoices.findOne(doc.id);
  }

  /**
   * Receive one or more payments against an invoice and settle it. When the
   * residual reaches zero the order is closed, the table is freed, and a
   * payment/settlement receipt is emitted.
   */
  async receivePayment(invoiceId: string, dto: ReceivePaymentDto) {
    const orgId = this.tenant.organizationId;
    const doc = await this.prisma.client.document.findFirst({
      where: { id: invoiceId, organizationId: orgId, documentType: 'sales_invoice' },
    });
    if (!doc) throw new NotFoundException('Invoice not found');
    if (doc.status === 'cancelled') throw new BadRequestException('Invoice is cancelled');
    const residual = Number(doc.amountResidual);
    if (residual <= 0.001) throw new BadRequestException('Invoice is already fully paid');

    const tenders = this.normalizeTenders(dto, residual);
    let lastPaymentId: string | null = null;
    for (const tender of tenders) {
      const payment = await this.payments.createReceipt({
        partnerId: doc.partnerId,
        paymentDate: new Date().toISOString(),
        paymentMethod: tender.method === 'store_credit' ? 'cash' : tender.method,
        amount: tender.amount,
        reference: tender.reference,
        cashSessionId: tender.method === 'cash' ? dto.cashSessionId : undefined,
        allocations: [{ documentId: doc.id, amount: tender.amount }],
      } as any);
      if ((payment as any)?.id) lastPaymentId = (payment as any).id;
    }

    const fresh = await this.prisma.client.document.findFirst({ where: { id: invoiceId } });
    const settled = Number(fresh!.amountResidual) <= 0.001;
    const wasCredit = doc.paymentMode === 'credit';
    const paymentMode = wasCredit ? 'credit' : (tenders.length > 1 ? 'mixed' : MODE_FROM_METHOD[tenders[0].method] ?? 'cash');
    const settlementStatus = settled ? 'settled' : 'partially_settled';
    await this.prisma.client.document.update({
      where: { id: invoiceId },
      data: { paymentMode, settlementStatus },
    });

    const receiptType = wasCredit ? 'settlement_receipt' : (settled ? 'payment_receipt' : 'partial_payment_receipt');
    const receipt = await this.createReceipt(doc, receiptType, lastPaymentId);
    await this.printReceiptSafe(invoiceId);

    if (settled) {
      await this.closeOrderForInvoice(invoiceId);
      this.events.publish(EVENTS.PosInvoiceSettled, {
        organizationId: orgId, invoiceId, invoiceNumber: doc.documentNumber, paymentMode,
      });
    }

    const tendered = dto.amountTendered ?? tenders.reduce((s, t) => s + t.amount, 0);
    return {
      invoiceId,
      settlementStatus,
      paymentMode,
      receiptId: receipt.id,
      change: Math.max(0, tendered - residual),
    };
  }

  /**
   * Settle on credit (postpaid house account). The invoice was already posted
   * (AR booked) at generation; this records the credit decision, emits a
   * credit-issue receipt, and closes the order. The balance stays in AR until a
   * later payment settles it.
   */
  async settleCredit(invoiceId: string, dto: SettleCreditDto = {}) {
    const orgId = this.tenant.organizationId;
    const doc = await this.prisma.client.document.findFirst({
      where: { id: invoiceId, organizationId: orgId, documentType: 'sales_invoice' },
    });
    if (!doc) throw new NotFoundException('Invoice not found');
    if (doc.status === 'cancelled') throw new BadRequestException('Invoice is cancelled');
    if (Number(doc.amountResidual) <= 0.001) throw new BadRequestException('Invoice is already settled');

    // Optional credit-limit guard against the partner's outstanding AR.
    await this.assertCreditAllowed(doc.partnerId, Number(doc.amountResidual));

    await this.prisma.client.document.update({
      where: { id: invoiceId },
      data: { paymentMode: 'credit', settlementStatus: 'unsettled' },
    });
    const receipt = await this.createReceipt(doc, 'credit_issue_receipt', null);
    await this.closeOrderForInvoice(invoiceId);

    this.events.publish(EVENTS.PosInvoiceCredited, {
      organizationId: orgId, invoiceId, invoiceNumber: doc.documentNumber, partnerId: doc.partnerId, amount: String(doc.amountResidual),
    });
    await this.audit.record({ entity: 'Document', entityId: invoiceId, action: 'update' as any, newValues: { kind: 'credit_issue', notes: dto.notes ?? null } });
    return { invoiceId, settlementStatus: 'unsettled', paymentMode: 'credit', receiptId: receipt.id };
  }

  /** Write off the outstanding balance of a credit invoice (Dr Bad Debt / Cr AR). */
  async writeOff(invoiceId: string, dto: WriteOffDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to write off an invoice');
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const doc = await tx.document.findFirst({ where: { id: invoiceId, organizationId: orgId, documentType: 'sales_invoice' } });
      if (!doc) throw new NotFoundException('Invoice not found');
      const residual = dec(doc.amountResidual);
      if (residual.lessThanOrEqualTo(0.001)) throw new BadRequestException('Nothing to write off');

      const partner = await tx.partner.findFirst({ where: { id: doc.partnerId } });
      const badDebtAccount = await this.determination.mapped('bad_debt', tx);
      const arAccount = await this.determination.receivableAccount(partner, tx);

      await this.posting.post({
        journalCode: 'GEN',
        date: new Date().toISOString(),
        description: `Write-off ${doc.documentNumber} — ${dto.reason}`,
        sourceType: 'invoice_writeoff',
        sourceId: doc.id,
        lines: [
          { accountId: badDebtAccount, debit: residual.toString() },
          { accountId: arAccount, credit: residual.toString(), partnerId: doc.partnerId },
        ],
      } as any, tx);

      await tx.document.update({
        where: { id: invoiceId },
        data: { settlementStatus: 'written_off', amountResidual: 0, amountPaid: doc.totalAmount, paymentStatus: 'paid', status: 'paid' },
      });
      await this.closeOrderForInvoiceTx(tx, invoiceId);
      await this.audit.recordInTx(tx, { entity: 'Document', entityId: invoiceId, action: 'update', newValues: { kind: 'write_off', reason: dto.reason, amount: residual.toString() } });
      this.events.publish(EVENTS.PosInvoiceWrittenOff, { organizationId: orgId, invoiceId, invoiceNumber: doc.documentNumber, amount: residual.toString() });
      return { invoiceId, settlementStatus: 'written_off', amount: residual.toString() };
    });
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private normalizeTenders(dto: ReceivePaymentDto, residual: number): TenderDto[] {
    if (dto.tenders?.length) {
      const sum = dto.tenders.reduce((s, t) => s + Number(t.amount), 0);
      if (Math.abs(sum - residual) > 0.01) {
        throw new BadRequestException(`Tenders sum ${sum} does not match amount due ${residual}`);
      }
      return dto.tenders;
    }
    return [{ method: dto.paymentMethod ?? 'cash', amount: residual } as TenderDto];
  }

  private async issueStockForItems(items: any[], reference: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const warehouse = await this.prisma.client.inventoryLocation.findFirst({
      where: { organizationId: orgId, type: 'warehouse', isActive: true },
    });
    if (!warehouse) return;
    for (const it of items) {
      if (it.menuItemId) {
        await this.issueMenuItemRecipe(it.menuItemId, Number(it.quantity), warehouse.id, `POS bill ${reference}`);
        continue;
      }
      if (!it.productId) continue;
      const product = await this.prisma.client.product.findFirst({ where: { id: it.productId } });
      if (!product?.trackInventory) continue;
      if (product.productType !== 'stockable' && product.productType !== 'consumable') continue;
      await this.stock.issue({ productId: it.productId, locationId: warehouse.id, quantity: Number(it.quantity), reference: `POS bill ${reference}` } as any);
    }
  }

  private async issueMenuItemRecipe(menuItemId: string, lineQty: number, warehouseId: string, reference: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const recipe = await this.prisma.client.menuProduct.findMany({ where: { menuItemId, organizationId: orgId } });
    for (const ing of recipe as any[]) {
      const qty = Number(ing.quantity) * lineQty;
      if (!(qty > 0)) continue;
      try {
        await this.stock.issue({ productId: ing.productId, locationId: warehouseId, quantity: qty, reference } as any);
      } catch {
        // Ingredient shortage surfaces on the inventory dashboard; never fail the bill.
      }
    }
  }

  private async createReceipt(doc: any, type: string, paymentId: string | null) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.receipt.create({
      data: {
        organizationId: orgId,
        invoiceId: doc.id,
        receiptNumber: doc.documentNumber,
        type: type as any,
        paymentId: paymentId ?? null,
        printedById: this.tenant.userId ?? null,
      },
    });
  }

  private async printReceiptSafe(invoiceId: string): Promise<void> {
    try {
      await this.receipts.printReceipt(invoiceId, this.tenant.userId ?? undefined);
    } catch (e: any) {
      this.logger.warn(`auto-print receipt failed for ${invoiceId}: ${String(e?.message ?? e)}`);
    }
  }

  private async closeOrderForInvoice(invoiceId: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.order.findFirst({ where: { invoiceId, organizationId: orgId } });
    if (order) {
      await this.prisma.client.order.update({ where: { id: order.id }, data: { status: 'closed', closedAt: new Date() } });
      this.events.publish(EVENTS.PosOrderClosed, { organizationId: orgId, orderId: order.id, invoiceId });
    }
    // Close the table link + free the table.
    const tableOrder = await this.prisma.client.posTableOrder.findFirst({ where: { documentId: invoiceId, closedAt: null } });
    if (tableOrder) {
      await this.tables.closeTableOrder({ tableId: tableOrder.tableId, documentId: invoiceId }).catch(() => undefined);
    } else if (order?.tableId) {
      await this.tables.closeTableOrder({ tableId: order.tableId, documentId: invoiceId }).catch(() => undefined);
    }
  }

  /** Transaction-bound order close (used by write-off which runs in its own tx). */
  private async closeOrderForInvoiceTx(tx: any, invoiceId: string): Promise<void> {
    const order = await tx.order.findFirst({ where: { invoiceId } });
    if (order) await tx.order.update({ where: { id: order.id }, data: { status: 'closed', closedAt: new Date() } });
  }

  /** Guard a credit sale against the partner's credit limit (0 = no limit). */
  private async assertCreditAllowed(partnerId: string, amount: number): Promise<void> {
    const orgId = this.tenant.organizationId;
    const tab = await this.prisma.client.customerTab.findFirst({ where: { organizationId: orgId, partnerId } });
    const limit = Number(tab?.creditLimit ?? 0);
    if (limit <= 0) return; // no limit configured
    const open = await this.prisma.client.document.aggregate({
      where: { organizationId: orgId, partnerId, documentType: 'sales_invoice', paymentMode: 'credit', settlementStatus: { in: ['unsettled', 'partially_settled'] } },
      _sum: { amountResidual: true },
    });
    const outstanding = Number(open._sum.amountResidual ?? 0);
    if (outstanding + amount > limit + 0.01) {
      throw new BadRequestException(`Credit limit exceeded: outstanding ${outstanding} + ${amount} > limit ${limit}`);
    }
  }
}
