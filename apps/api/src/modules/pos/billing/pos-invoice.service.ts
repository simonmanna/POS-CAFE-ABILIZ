/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EVENTS } from '@erp/shared';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { dec } from '../../../kernel/common/money';
import { DocumentBuilderService } from '../../invoicing/document/document-builder.service';
import { SequenceService } from '../../../kernel/sequence/sequence.service';
import { PaymentService } from '../../invoicing/payment/payment.service';
import { PostingService } from '../../accounting/posting/posting.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';
import { StockService } from '../../inventory/stock.service';
import { PosReceiptsService } from '../pos-receipts.service';
import { PosOverridesService } from '../pos-overrides.service';
import type { GenerateInvoiceDto, ReceivePaymentDto, SettleCreditDto, WriteOffDto, TenderDto } from '../order/dto/order.dto';

const MODE_FROM_METHOD: Record<string, 'cash' | 'card' | 'mobile_money'> = {
  cash: 'cash', bank: 'card', card: 'card', mobile_money: 'mobile_money', store_credit: 'card',
};

/**
 * POS billing on the **separate Invoice table** (R2). The financial Invoice is
 * fully decoupled from the generic `Document`: it owns its own GL posting
 * (Dr AR / Cr Revenue+Tax) and AR balance. Payments reuse the generic Payment
 * table via PaymentAllocation.invoiceId. Receipts/ReceiptItems are generated
 * from the Invoice. The GL stays the shared backbone (PostingService).
 */
@Injectable()
export class PosInvoiceService {
  private readonly logger = new Logger('PosInvoiceService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly builder: DocumentBuilderService,
    private readonly sequence: SequenceService,
    private readonly payments: PaymentService,
    private readonly posting: PostingService,
    private readonly determination: AccountDeterminationService,
    private readonly stock: StockService,
    private readonly receipts: PosReceiptsService,
    private readonly overrides: PosOverridesService,
  ) {}

  /**
   * Generate the bill: price the order's items, create Invoice + InvoiceItems,
   * post its own GL (Dr AR / Cr Revenue+Tax), deduct inventory, and link it back
   * to the order. Idempotent — a second call returns the existing invoice.
   */
  async generateInvoice(orderId: string, dto: GenerateInvoiceDto = {}) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.order.findFirst({ where: { id: orderId, organizationId: orgId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'cancelled') throw new BadRequestException('Cannot bill a cancelled order');
    if (order.invoiceId) return this.findInvoice(order.invoiceId); // idempotent

    const items = await this.prisma.client.orderItem.findMany({
      where: { orderId, cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true },
    });
    if (!items.length) throw new BadRequestException('Order has no items to bill');

    // Fold any order-level discount into each line so the GL stays balanced
    // (AR debit == Revenue+Tax credit) without a separate discount account.
    const txPct = Number(dto.transactionDiscountPercent ?? order.transactionDiscountPercent ?? 0);
    const txFactor = 1 - txPct / 100;
    const lineInputs = items.map((it: any) => ({
      productId: it.productId ?? undefined,
      menuItemId: it.menuItemId ?? undefined,
      description: it.description,
      quantity: Number(it.quantity),
      unitPrice: Number(it.unitPrice),
      taxId: it.taxId ?? undefined,
      discountPercent: txPct > 0 ? 100 * (1 - (1 - Number(it.discountPercent) / 100) * txFactor) : Number(it.discountPercent),
      taxInclusive: it.taxInclusive,
    }));

    const year = new Date().getUTCFullYear();
    const invoiceNumber = await this.sequenceInvoiceNumber(year);

    const invoice = await this.prisma.client.$transaction(async (tx: any) => {
      const totals = await this.builder.prepareLines(tx, lineInputs);
      const inv = await tx.invoice.create({
        data: {
          organizationId: orgId,
          invoiceNumber,
          orderId,
          partnerId: order.partnerId!,
          branchId: dto.branchId ?? order.branchId ?? null,
          cashSessionId: order.cashSessionId ?? null,
          waiterId: order.waiterId ?? null,
          tableId: order.tableId ?? null,
          issueDate: new Date(),
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.total,
          amountResidual: totals.total,
          status: 'draft',
          settlementStatus: 'unsettled',
          paymentMode: dto.paymentMode ?? null,
          reference: order.orderNumber,
          notes: order.notes ?? null,
          createdBy: this.tenant.userId ?? null,
        },
      });
      for (let i = 0; i < totals.prepared.length; i++) {
        const p = totals.prepared[i];
        const src: any = items[i];
        const item = await tx.invoiceItem.create({
          data: {
            organizationId: orgId,
            invoiceId: inv.id,
            productId: p.productId,
            menuItemId: p.menuItemId,
            accountId: p.accountId,
            description: p.description,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            discountPercent: p.discountPercent,
            taxId: p.taxId,
            taxInclusive: p.taxInclusive,
            subtotal: p.subtotal,
            taxAmount: p.taxAmount,
            total: p.total,
            lineNumber: p.lineNumber,
          },
        });
        const mods = src?.modifiers ?? [];
        if (mods.length) {
          await tx.invoiceItemModifier.createMany({
            data: mods.map((m: any) => ({ organizationId: orgId, invoiceItemId: item.id, modifierId: m.modifierId ?? null, name: m.name, priceDelta: m.priceDelta })),
          });
        }
      }
      // Post the invoice's own GL entry (Dr AR / Cr Revenue+Tax).
      const dbItems = await tx.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      const journalEntryId = await this.postInvoiceGl(tx, inv, dbItems);
      await tx.invoice.update({
        where: { id: inv.id },
        data: { journalEntryId, status: 'posted', postedAt: new Date(), postedBy: this.tenant.userId ?? null },
      });

      // Deduct inventory inside the SAME transaction by threading `tx` into the
      // stock service (audit P0-1: previously stock.issue opened its own
      // transaction on a separate connection, so an invoice rollback left the
      // stock decremented — permanent drift). Now it joins this tx and rolls
      // back atomically. Recipe errors are no longer swallowed.
      await this.issueStockForItems(tx, items, inv.invoiceNumber);

      return tx.invoice.findFirst({ where: { id: inv.id }, include: { items: { orderBy: { lineNumber: 'asc' } } } });
    });

    await this.prisma.client.order.update({ where: { id: orderId }, data: { invoiceId: invoice.id, status: 'served' } });

    this.events.publish(EVENTS.PosOrderInvoiced, {
      organizationId: orgId, orderId, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
    });
    await this.audit.record({ entity: 'Invoice', entityId: invoice.id, action: 'post' as any, newValues: { kind: 'invoice_generated', orderId, total: invoice.totalAmount.toString() } });
    return invoice;
  }

  /**
   * Receive one or more payments against an Invoice and settle it.
   *
   * P0-2: the whole settlement is one transaction guarded by a `FOR UPDATE` row
   * lock on the invoice. Two terminals settling the same invoice are serialised:
   * the second blocks until the first commits, then re-reads a zero residual and
   * is rejected below — no double-charge, no negative residual, no double close.
   * The `version` column is bumped on every settlement for optimistic callers.
   * Side effects (printing, events) run only AFTER the tx commits.
   */
  async receivePayment(invoiceId: string, dto: ReceivePaymentDto) {
    const orgId = this.tenant.organizationId;

    const result = await this.prisma.client.$transaction(async (tx: any) => {
      // Serialise concurrent settlements of THIS invoice.
      await tx.$queryRawUnsafe(`SELECT id FROM "Invoice" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`, invoiceId, orgId);
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'cancelled' || invoice.status === 'refunded') throw new BadRequestException(`Invoice is ${invoice.status}`);
      const residual = Number(invoice.amountResidual);
      if (residual <= 0.001) throw new BadRequestException('Invoice is already fully paid');

      // If the invoice GL was posted with a cash/bank counter-account
      // (pre-settled), payments skip GL posting to avoid double-counting cash.
      const preSettledModes = new Set(['cash', 'card', 'mobile_money']);
      const skipGl = !!invoice.paymentMode && preSettledModes.has(invoice.paymentMode);

      const tenders = this.normalizeTenders(dto, residual);
      let lastPaymentId: string | null = null;
      for (const tender of tenders) {
        let accountId: string | undefined;
        if (tender.method === 'store_credit') {
          accountId = await this.storeCreditAccountId();
        }
        const payment = await this.payments.createReceipt({
          partnerId: invoice.partnerId,
          paymentDate: new Date().toISOString(),
          paymentMethod: tender.method,
          amount: tender.amount,
          reference: tender.reference,
          accountId,
          cashSessionId: tender.method === 'cash' ? dto.cashSessionId : undefined,
          skipGlPosting: skipGl,
          // R2: allocate against the Invoice (not a Document).
          allocations: [{ invoiceId: invoice.id, amount: tender.amount }],
        } as any, tx);
        if ((payment as any)?.id) lastPaymentId = (payment as any).id;
      }

      const fresh = await tx.invoice.findFirst({ where: { id: invoiceId } });
      const settled = Number(fresh!.amountResidual) <= 0.001;
      const wasCredit = invoice.paymentMode === 'credit';
      const paymentMode = wasCredit ? 'credit' : (tenders.length > 1 ? 'mixed' : MODE_FROM_METHOD[tenders[0].method] ?? 'cash');
      const settlementStatus = settled ? 'settled' : 'partially_settled';
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { paymentMode, settlementStatus, status: settled ? 'paid' : invoice.status, version: { increment: 1 } },
      });

      const receiptType = wasCredit ? 'settlement_receipt' : (settled ? 'payment_receipt' : 'partial_payment_receipt');
      const receipt = await this.createReceipt(tx, invoice, receiptType, lastPaymentId);
      // The cashier/settlement copy printed right after the customer one.
      if (settled) await this.createReceipt(tx, invoice, 'merchant_copy', lastPaymentId);
      const closed = settled ? await this.closeOrderForInvoice(tx, invoiceId) : null;

      return { residual, settled, paymentMode, settlementStatus, receiptId: receipt.id, closed, invoiceNumber: invoice.invoiceNumber };
    });

    // Side effects AFTER commit — never on a rolled-back tx.
    await this.printReceiptSafe(invoiceId);
    if (result.settled) {
      if (result.closed) this.events.publish(EVENTS.PosOrderClosed, { organizationId: orgId, orderId: result.closed.orderId, invoiceId });
      this.events.publish(EVENTS.PosInvoiceSettled, { organizationId: orgId, invoiceId, invoiceNumber: result.invoiceNumber, paymentMode: result.paymentMode });
    }

    const tendered = dto.amountTendered ?? result.residual;
    return { invoiceId, settlementStatus: result.settlementStatus, paymentMode: result.paymentMode, receiptId: result.receiptId, change: Math.max(0, tendered - result.residual) };
  }

  /** Settle on credit (postpaid house account). AR already booked at generation. */
  async settleCredit(invoiceId: string, dto: SettleCreditDto = {}) {
    const orgId = this.tenant.organizationId;
    const invoice = await this.prisma.client.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'cancelled' || invoice.status === 'refunded') throw new BadRequestException(`Invoice is ${invoice.status}`);
    if (Number(invoice.amountResidual) <= 0.001) throw new BadRequestException('Invoice is already settled');

    await this.assertCreditAllowed(invoice.partnerId, Number(invoice.amountResidual));
    await this.prisma.client.invoice.update({ where: { id: invoiceId }, data: { paymentMode: 'credit', settlementStatus: 'unsettled', version: { increment: 1 } } });
    const receipt = await this.createReceipt(this.prisma.client, invoice, 'credit_issue_receipt', null);
    const closed = await this.closeOrderForInvoice(this.prisma.client, invoiceId);
    if (closed) this.events.publish(EVENTS.PosOrderClosed, { organizationId: orgId, orderId: closed.orderId, invoiceId });

    this.events.publish(EVENTS.PosInvoiceCredited, {
      organizationId: orgId, invoiceId, invoiceNumber: invoice.invoiceNumber, partnerId: invoice.partnerId, amount: String(invoice.amountResidual),
    });
    await this.audit.record({ entity: 'Invoice', entityId: invoiceId, action: 'update' as any, newValues: { kind: 'credit_issue', notes: dto.notes ?? null } });
    return { invoiceId, settlementStatus: 'unsettled', paymentMode: 'credit', receiptId: receipt.id };
  }

  /** Write off the outstanding balance (Dr bad-debt / Cr AR). */
  async writeOff(invoiceId: string, dto: WriteOffDto) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to write off an invoice');
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      const residual = dec(invoice.amountResidual);
      if (residual.lessThanOrEqualTo(0.001)) throw new BadRequestException('Nothing to write off');

      const partner = await tx.partner.findFirst({ where: { id: invoice.partnerId } });
      const badDebtAccount = await this.determination.mapped('bad_debt', tx);
      const arAccount = await this.determination.receivableAccount(partner, tx);
      await this.posting.post({
        journalCode: 'GEN',
        date: new Date().toISOString(),
        description: `Write-off ${invoice.invoiceNumber} — ${dto.reason}`,
        sourceType: 'pos_invoice_writeoff',
        sourceId: invoice.id,
        lines: [
          { accountId: badDebtAccount, debit: residual.toString() },
          { accountId: arAccount, credit: residual.toString(), partnerId: invoice.partnerId },
        ],
      } as any, tx);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { settlementStatus: 'written_off', amountResidual: 0, amountPaid: invoice.totalAmount, paymentStatus: 'paid', status: 'paid' },
      });
      await tx.order.updateMany({ where: { invoiceId }, data: { status: 'closed', closedAt: new Date() } });
      await this.audit.recordInTx(tx, { entity: 'Invoice', entityId: invoiceId, action: 'update', newValues: { kind: 'write_off', reason: dto.reason, amount: residual.toString() } });
      this.events.publish(EVENTS.PosInvoiceWrittenOff, { organizationId: orgId, invoiceId, invoiceNumber: invoice.invoiceNumber, amount: residual.toString() });
      return { invoiceId, settlementStatus: 'written_off', amount: residual.toString() };
    });
  }

  /**
   * Full refund/void: reverse the invoice GL, restock, return cash, mark refunded.
   *
   * P0-3: the whole thing is ONE transaction (GL reversal + restock + cash-out +
   * status), so a partial failure can't leave reversed revenue with un-restored
   * stock (or vice-versa). For a cash-settled sale the GL cash leg is reversed in
   * step 1, and an outbound cash refund Payment (GL-skipped) is recorded so the
   * cash-session Z-report reconciles with the money physically leaving the drawer.
   */
  async refund(
    invoiceId: string,
    reason?: string,
    opts?: { overrideById?: string; cashSessionId?: string; requireOverride?: boolean },
  ) {
    const orgId = this.tenant.organizationId;

    // Manual void/refund of a settled sale needs a manager sign-off. Internal
    // compensation calls (failed checkout/settle) pass no opts and skip this.
    if (opts?.requireOverride && !opts.overrideById) {
      throw new BadRequestException('Refunding a settled sale requires a manager override');
    }
    if (opts?.overrideById) {
      await this.overrides.assertCanOverride(opts.overrideById, 'manual_refund');
    }

    const result = await this.prisma.client.$transaction(async (tx: any) => {
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId }, include: { items: true } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'refunded') throw new BadRequestException('Invoice already refunded');

      // 1) Reverse the invoice GL (Dr Revenue+Tax / Cr counter). For the canonical
      //    pre-settled cash/card sale the counter was Cash/Bank, so the cash leg
      //    is reversed here at the GL level.
      if (invoice.journalEntryId) {
        await this.posting.reverse(invoice.journalEntryId, { description: `Refund of ${invoice.invoiceNumber}${reason ? ` — ${reason}` : ''}` }, tx);
      }

      // 2) Restock the sold items (recipe-aware) in the same tx.
      const warehouse = await tx.inventoryLocation.findFirst({ where: { organizationId: orgId, type: 'warehouse', isActive: true } });
      if (warehouse) {
        for (const it of invoice.items as any[]) {
          if (it.menuItemId) { await this.receiveMenuItemRecipe(tx, it.menuItemId, Number(it.quantity), warehouse.id, `Refund ${invoice.invoiceNumber}`); continue; }
          if (!it.productId) continue;
          await this.stock.receive({ productId: it.productId, locationId: warehouse.id, quantity: Number(it.quantity), reference: `Refund ${invoice.invoiceNumber}` } as any, tx);
        }
      }

      // 3) Return cash to the drawer. GL cash was already reversed in (1), so this
      //    outbound payment skips GL — it exists to write the CashMovement('refund')
      //    that reconciles the session and to leave an auditable money-out trail.
      //    Only for cash actually collected, on the same cashier's open session.
      const cashPaid = Number(invoice.amountPaid);
      // Prefer the cashier's CURRENT open session (passed by the refund endpoint)
      // so a void rung up after the original shift still records the cash leaving
      // the drawer; fall back to the session the sale was rung on.
      const refundSessionId = opts?.cashSessionId ?? invoice.cashSessionId;
      if (cashPaid > 0.001 && refundSessionId) {
        const session = await tx.cashSession.findFirst({ where: { id: refundSessionId, organizationId: orgId } });
        if (session && session.status === 'open' && session.userId === this.tenant.userId) {
          await this.payments.createCustomerRefund({
            partnerId: invoice.partnerId,
            paymentDate: new Date().toISOString(),
            paymentMethod: 'cash',
            amount: cashPaid,
            reference: `Refund ${invoice.invoiceNumber}`,
            cashSessionId: refundSessionId,
            skipGlPosting: true,
          } as any, tx);
        }
      }

      // 4) Mark refunded + close the order (release the table).
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'refunded', settlementStatus: 'settled', amountResidual: 0, version: { increment: 1 } } });
      const closed = await this.closeOrderForInvoice(tx, invoiceId);
      await this.createReceipt(tx, invoice, 'merchant_copy', null);
      return { total: invoice.totalAmount.toString(), closed };
    });

    await this.audit.record({ entity: 'Invoice', entityId: invoiceId, action: 'cancel' as any, newValues: { kind: 'refund', reason: reason ?? null, overrideById: opts?.overrideById ?? null } });
    if (result.closed) this.events.publish(EVENTS.PosOrderClosed, { organizationId: orgId, orderId: result.closed.orderId, invoiceId });
    this.events.publish(EVENTS.PosRefundCompleted, { organizationId: orgId, invoiceId, creditNoteId: '', total: result.total } as any);
    return { invoiceId, status: 'refunded', amount: result.total };
  }

  /** Read an invoice with items (public — used by controllers). */
  findInvoice(invoiceId: string) {
    return this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, organizationId: this.tenant.organizationId },
      include: { items: { orderBy: { lineNumber: 'asc' } }, receipts: true },
    });
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async sequenceInvoiceNumber(year: number): Promise<string> {
    // Reuse the shared sales-invoice sequence so POS + manual invoices share INV- series.
    return this.sequence.next(`invoice:${year}`, { prefix: `INV-${year}-`, padding: 6 });
  }

  /**
   * Post GL entry for the invoice. The counter account is payment-mode-aware:
   *   • credit / mixed / null → Accounts Receivable (deferred settlement)
   *   • cash                → Cash account (immediate settlement)
   *   • card                → Bank account (card settlement)
   *   • mobile_money        → Cash account (treated as cash-equivalent)
   *
   * When the debit side is a cash/bank account (not AR), the caller should
   * pass `skipGlPosting: true` to the subsequent payment call to avoid
   * double-posting the cash entry.
   */
  private async postInvoiceGl(tx: any, invoice: any, items: any[]): Promise<string> {
    const fullLike = { partnerId: invoice.partnerId, lines: items };
    const { counterAccount: defaultCounter, itemByAccount, taxByAccount } = await this.builder.groupForPosting(tx, fullLike, 'sales');

    const mode = invoice.paymentMode;
    const mappingKey: Record<string, string> = {
      cash: 'default_cash',
      card: 'default_bank',
      mobile_money: 'default_cash',
    };
    let counterAccount = defaultCounter;
    if (mode && mode !== 'credit' && mode !== 'mixed') {
      const key = mappingKey[mode as string];
      if (key) {
        try { counterAccount = await this.determination.mapped(key, tx); } catch { /* fallback to AR */ }
      }
    }

    const lines: any[] = [
      { accountId: counterAccount, debit: invoice.totalAmount.toString(), partnerId: invoice.partnerId, description: `Invoice ${invoice.invoiceNumber}` },
    ];
    for (const [accountId, amount] of itemByAccount) lines.push({ accountId, credit: (amount as any).toString(), partnerId: invoice.partnerId, description: 'Revenue' });
    for (const [accountId, amount] of taxByAccount) lines.push({ accountId, credit: (amount as any).toString(), description: 'Output tax' });
    const entry = await this.posting.post({
      journalCode: 'SALES',
      date: invoice.issueDate,
      description: `Invoice ${invoice.invoiceNumber}`,
      currencyId: invoice.currencyId ?? undefined,
      exchangeRate: Number(invoice.exchangeRate),
      sourceType: 'pos_invoice',
      sourceId: invoice.id,
      lines,
    } as any, tx);
    return entry.id;
  }

  private normalizeTenders(dto: ReceivePaymentDto, residual: number): TenderDto[] {
    if (dto.tenders?.length) {
      const sum = dto.tenders.reduce((s, t) => s + Number(t.amount), 0);
      if (Math.abs(sum - residual) > 0.01) throw new BadRequestException(`Tenders sum ${sum} does not match amount due ${residual}`);
      return dto.tenders;
    }
    return [{ method: dto.paymentMethod ?? 'cash', amount: residual } as TenderDto];
  }

  private async issueStockForItems(tx: any, items: any[], reference: string): Promise<void> {
    const orgId = this.tenant.organizationId;
    const warehouse = await tx.inventoryLocation.findFirst({ where: { organizationId: orgId, type: 'warehouse', isActive: true } });
    if (!warehouse) return;
    for (const it of items) {
      if (it.menuItemId) { await this.issueMenuItemRecipe(tx, it.menuItemId, Number(it.quantity), warehouse.id, `POS bill ${reference}`); continue; }
      if (!it.productId) continue;
      const product = await tx.product.findFirst({ where: { id: it.productId } });
      if (!product?.trackInventory) continue;
      if (product.productType !== 'stockable' && product.productType !== 'consumable') continue;
      await this.stock.issue({ productId: it.productId, locationId: warehouse.id, quantity: Number(it.quantity), reference: `POS bill ${reference}` } as any, tx);
    }
  }

  // P0-1: errors are NOT swallowed — a stock failure must roll back the invoice
  // (atomic) instead of silently corrupting on-hand quantities.
  private async issueMenuItemRecipe(tx: any, menuItemId: string, lineQty: number, warehouseId: string, reference: string): Promise<void> {
    const recipe = await tx.menuProduct.findMany({ where: { menuItemId, organizationId: this.tenant.organizationId } });
    for (const ing of recipe as any[]) {
      const qty = Number(ing.quantity) * lineQty;
      if (!(qty > 0)) continue;
      await this.stock.issue({ productId: ing.productId, locationId: warehouseId, quantity: qty, reference } as any, tx);
    }
  }

  private async receiveMenuItemRecipe(tx: any, menuItemId: string, lineQty: number, warehouseId: string, reference: string): Promise<void> {
    const recipe = await tx.menuProduct.findMany({ where: { menuItemId, organizationId: this.tenant.organizationId } });
    for (const ing of recipe as any[]) {
      const qty = Number(ing.quantity) * lineQty;
      if (!(qty > 0)) continue;
      await this.stock.receive({ productId: ing.productId, locationId: warehouseId, quantity: qty, reference } as any, tx);
    }
  }

  /** Create a Receipt + ReceiptItems on the given executor (a tx, or the base client). */
  private async createReceipt(db: any, invoice: any, type: string, paymentId: string | null) {
    const orgId = this.tenant.organizationId;
    const receipt = await db.receipt.create({
      data: { organizationId: orgId, invoiceId: invoice.id, receiptNumber: invoice.invoiceNumber, type: type as any, paymentId: paymentId ?? null, printedById: this.tenant.userId ?? null },
    });
    const items = await db.invoiceItem.findMany({ where: { invoiceId: invoice.id }, orderBy: { lineNumber: 'asc' } });
    if (items.length) {
      await db.receiptItem.createMany({
        data: items.map((it: any) => ({ organizationId: orgId, receiptId: receipt.id, invoiceItemId: it.id, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, total: it.total, lineNumber: it.lineNumber })),
      });
    }
    return receipt;
  }

  private async printReceiptSafe(invoiceId: string): Promise<void> {
    try { await this.receipts.printReceipt(invoiceId, this.tenant.userId ?? undefined); }
    catch (e: any) { this.logger.warn(`auto-print receipt failed for ${invoiceId}: ${String(e?.message ?? e)}`); }
  }

  /**
   * Close the order linked to an invoice and free its table, on the given
   * executor. Returns the order/table touched so the caller can publish the
   * PosOrderClosed event AFTER the tx commits (no events on a rolled-back tx).
   */
  private async closeOrderForInvoice(db: any, invoiceId: string): Promise<{ orderId: string; tableId: string | null } | null> {
    const orgId = this.tenant.organizationId;
    const order = await db.order.findFirst({ where: { invoiceId, organizationId: orgId } });
    if (!order) return null;
    await db.order.update({ where: { id: order.id }, data: { status: 'closed', closedAt: new Date() } });
    await this.freeTableIfEmpty(db, order.tableId);
    return { orderId: order.id, tableId: order.tableId };
  }

  private async freeTableIfEmpty(db: any, tableId?: string | null): Promise<void> {
    if (!tableId) return;
    const open = await db.order.count({ where: { tableId, status: { in: ['draft', 'open', 'preparing', 'ready', 'served'] }, invoiceId: null } });
    if (open > 0) return;
    const table = await db.posTable.findFirst({ where: { id: tableId } });
    if (!table || table.status === 'out_of_service' || table.status === 'reserved') return;
    if (table.status !== 'available') await db.posTable.update({ where: { id: tableId }, data: { status: 'available' } });
  }

  private async storeCreditAccountId(): Promise<string> {
    const mapping = await this.prisma.client.accountMapping.findFirst({ where: { key: 'store_credit' } });
    if (!mapping) {
      throw new BadRequestException(
        "Store-credit payments need the 'store_credit' account mapping. Configure it under Accounting > Account Mapping.",
      );
    }
    return mapping.accountId;
  }

  private async assertCreditAllowed(partnerId: string, amount: number): Promise<void> {
    const orgId = this.tenant.organizationId;
    const tab = await this.prisma.client.customerTab.findFirst({ where: { organizationId: orgId, partnerId } });
    const limit = Number(tab?.creditLimit ?? 0);
    if (limit <= 0) return;
    const open = await this.prisma.client.invoice.aggregate({
      where: { organizationId: orgId, partnerId, paymentMode: 'credit', settlementStatus: { in: ['unsettled', 'partially_settled'] } },
      _sum: { amountResidual: true },
    });
    const outstanding = Number(open._sum.amountResidual ?? 0);
    if (outstanding + amount > limit + 0.01) throw new BadRequestException(`Credit limit exceeded: outstanding ${outstanding} + ${amount} > limit ${limit}`);
  }
}
