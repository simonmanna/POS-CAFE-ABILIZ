import { resolveTenderAccount } from '../../accounting/treasury/tender-account';
import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { assertPricingAuthority, currentPermissions, discountedLines } from '../pricing-policy';
import { refundInvoice, type RefundOptions } from './refund-operation';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { resolvePosStockLocation } from '../../inventory/pos-stock-location';
import { EVENTS } from '@erp/shared';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { ApprovalsService } from '../../../kernel/approvals/approvals.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { dec } from '../../../kernel/common/money';
import { resolveOccurredAt } from '../../../kernel/common/occurred-at';
import { DocumentBuilderService } from '../../invoicing/document/document-builder.service';
import { SequenceService } from '../../../kernel/sequence/sequence.service';
import { PaymentService } from '../../invoicing/payment/payment.service';
import { PostingService } from '../../accounting/posting/posting.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';
import { StockService } from '../../inventory/stock.service';
import { StockReservationService } from '../../inventory/stock-reservation.service';
import { PosReceiptsService } from '../pos-receipts.service';
import { PosOverridesService } from '../pos-overrides.service';
import { recomputeTableStatus } from '../table-status.util';
import { WorkflowService } from '../../../kernel/workflow/workflow.service';
import { SettingResolverService } from '../../../kernel/settings/setting-resolver.service';
import { NotificationsService } from '../../../kernel/notifications/notifications.service';
import type { StockPostingTiming } from '../inventory-posting.types';
import { resolveCreditStatus } from './credit-status';
import type { GenerateInvoiceDto, ReceivePaymentDto, SettleCreditDto, WriteOffDto, TenderDto } from '../order/dto/order.dto';

const MODE_FROM_METHOD: Record<string, 'cash' | 'card' | 'mobile_money' | 'mixed'> = {
  cash: 'cash', bank: 'card', card: 'card', mobile_money: 'mobile_money', store_credit: 'mixed',
};

/** Context threaded through durable inventory posting (Phase 1). */
interface StockPostingCtx {
  invoiceId: string | null;
  // Nullable since Phase C: a pre-invoice trigger has no invoice number yet.
  invoiceNumber: string | null;
  orderId: string | null;
}

/** A single sale line whose stock could not be issued → an InventoryException. */
interface StockLineFailure {
  kind: 'menu_recipe' | 'product' | 'line_extras' | 'whole_invoice';
  productId: string | null;
  menuItemId: string | null;
  description: string | null;
  quantity: number;
  locationId: string | null;
  reason: string;
  stackTrace: string | null;
  payload: Record<string, unknown> | null;
}

/** A paid modifier / accompaniment component whose stock movement failed. */
interface LineExtraFailure {
  componentId: string;
  componentType: 'modifier' | 'accompaniment_option';
  productId: string | null;
  error: any;
}

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
    private readonly reservations: StockReservationService,
    private readonly receipts: PosReceiptsService,
    private readonly overrides: PosOverridesService,
    private readonly approvals: ApprovalsService,
    private readonly workflows: WorkflowService,
    private readonly settings: SettingResolverService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Reject known tender/configuration problems before creating financial work.
   * PaymentService repeats these checks under the committing transaction's locks. */
  async preflightPayment(total: number, input: any, partnerId?: string) {
    if (input.settleMode === 'credit') {
      return this.prisma.client.$transaction((tx: any) => this.assertCreditAllowed(partnerId!, total, tx));
    }
    const tenders = this.normalizeTenders(input, total);
    const handed = input.amountTendered;
    if (handed != null && (!Number.isFinite(handed) || handed < total || (!tenders.some(t => t.method === 'cash') && handed > total))) throw new BadRequestException('Cash handed over is invalid for these tenders');
    await this.prisma.client.$transaction(async (tx: any) => {
      for (const tender of tenders) await resolveTenderAccount(tx, this.determination, this.tenant.organizationId, { method: tender.method, accountId: tender.accountId, cashSessionId: input.cashSessionId });
      const creditTotal = tenders.filter(t => t.method === 'store_credit').reduce((n, t) => n.plus(t.amount), dec(0));
      if (creditTotal.gt(0)) {
        if (!partnerId) throw new BadRequestException('Select the customer who owns this store credit');
        const credit = await tx.storeCredit.findFirst({ where: { organizationId: this.tenant.organizationId, partnerId } });
        if (!credit || !credit.isActive || (credit.expiresAt && credit.expiresAt <= new Date()) || creditTotal.gt(credit.balance)) throw new BadRequestException('Customer store credit is unavailable, expired or insufficient');
      }
    });
  }

  async quoteSavedItems(items: any[], input: any = {}, db: any = this.prisma.client) {
    return this.builder.prepareLines(db, discountedLines(items, input));
  }

  async preflightOrderPayment(order: any, input: any) {
    const items = order.items ?? await this.prisma.client.orderItem.findMany({ where: { orderId: order.id, cancelled: false } });
    const discountInput = { ...input,
      transactionDiscountType: input.transactionDiscountType ?? order.transactionDiscountType ?? 'percentage',
      transactionDiscountAmount: input.transactionDiscountAmount ?? order.transactionDiscountAmount ?? 0,
      transactionDiscountPercent: input.transactionDiscountPercent ?? order.transactionDiscountPercent ?? 0,
    };
    const lines = discountedLines(items.filter((i: any) => !i.cancelled).map((i: any) => ({ ...i, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), discountPercent: Number(i.discountPercent ?? 0), discountAmount: Number(i.discountAmount ?? 0) })), discountInput);
    const totals = await this.builder.prepareLines(this.prisma.client, lines);
    await this.preflightPayment(Number(totals.total), input, input.partnerId ?? order.partnerId);
  }

  /** The org's stock-deduction timing policy (`inventory.stockPostingTiming`). */
  async stockPostingTiming(): Promise<StockPostingTiming> {
    return this.settings.resolveEnum<StockPostingTiming>('inventory.stockPostingTiming');
  }

  /**
   * Enqueue a durable stock-posting job idempotently. The `(trigger, keyBase)`
   * idempotency key means a replayed trigger event — or the invoice path and a
   * subscriber both firing — can never enqueue a second job for the same
   * order+policy. `keyBase` is the invoice id when one exists (matching the
   * historical `at_invoice:<invoiceId>` key), else the order id.
   */
  async enqueueStockPosting(params: {
    orderId: string;
    invoiceId?: string | null;
    invoiceNumber?: string | null;
    trigger: StockPostingTiming;
    tx?: any;
  }): Promise<void> {
    const orgId = this.tenant.organizationId;
    const keyBase = params.invoiceId ?? params.orderId;
    const idempotencyKey = `${params.trigger}:${keyBase}`;
    const db = params.tx ?? this.prisma.client;
    try {
      await db.stockPostingJob.create({
        data: {
          organizationId: orgId,
          invoiceId: params.invoiceId ?? null,
          invoiceNumber: params.invoiceNumber ?? null,
          orderId: params.orderId,
          postingTrigger: params.trigger,
          idempotencyKey,
        },
      });
    } catch (e: any) {
      // P2002 = unique violation on (org, idempotencyKey): already enqueued.
      if (e?.code === 'P2002') return;
      throw e;
    }
  }

  /**
   * Generate the bill: price the order's items, create Invoice + InvoiceItems,
   * post its own GL (Dr AR / Cr Revenue+Tax), deduct inventory, and link it back
   * to the order. Idempotent — a second call returns the existing invoice.
   */
  async generateInvoice(orderId: string, dto: GenerateInvoiceDto = {}, externalTx?: any) {
    const orgId = this.tenant.organizationId;
    // When a caller already holds a transaction (rental checkout, split bill),
    // read through it so uncommitted rows (e.g. a fresh order) are visible.
    const db = externalTx ?? this.prisma.client;
    const order = await db.order.findFirst({ where: { id: orderId, organizationId: orgId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'cancelled') throw new BadRequestException('Cannot bill a cancelled order');
    if (order.invoiceId) return this.findInvoice(order.invoiceId); // idempotent
    if (dto.expectedVersion != null && dto.expectedVersion !== order.version) throw new BadRequestException('Saved order changed; review the current order before billing');

    const items = await db.orderItem.findMany({
      where: { orderId, cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true },
    });
    if (!items.length) throw new BadRequestException('Order has no items to bill');

    // Stock-deduction timing policy (resolved outside the tx — settings aren't
    // transactional). `at_invoice` (default) enqueues here; other policies defer
    // to the InventoryPostingSubscriber.
    const timing = await this.stockPostingTiming();

    // Resolve discount type/value: DTO overrides order defaults.
    const txDiscType = dto.transactionDiscountType ?? order.transactionDiscountType ?? 'percentage';
    const txDiscValue = txDiscType === 'fixed_amount'
      ? Number(dto.transactionDiscountAmount ?? order.transactionDiscountAmount ?? 0)
      : Number(dto.transactionDiscountPercent ?? order.transactionDiscountPercent ?? 0);
    const discountReason = dto.discountReason ?? order.discountReason ?? null;

    // Full (pre-order-discount) line inputs for the GL discount leg.
    const fullLineInputs = items.map((it: any) => ({
      productId: it.productId ?? undefined,
      menuItemId: it.menuItemId ?? undefined,
      variantId: it.variantId ?? undefined,
      variantName: it.variantName ?? undefined,
      description: it.description,
      quantity: Number(it.quantity),
      unitPrice: Number(it.unitPrice),
      taxId: it.taxId ?? undefined,
      discountPercent: Number(it.discountPercent),
      discountType: it.discountType ?? 'percentage',
      discountAmount: it.discountAmount ? Number(it.discountAmount) : undefined,
      discountReason: it.discountReason ?? undefined,
      discountSource: 'manual' as const,
      taxInclusive: it.taxInclusive,
    }));
    // Discounted line inputs: order-level discount folded into per-line.
    const discountInput = { ...dto, transactionDiscountType: txDiscType, transactionDiscountAmount: txDiscType === 'fixed_amount' ? txDiscValue : 0, transactionDiscountPercent: txDiscType === 'percentage' ? txDiscValue : 0, discountReason };
    await assertPricingAuthority(this, fullLineInputs, discountInput);
    const lineInputs = discountedLines(fullLineInputs, discountInput);

    const year = new Date().getUTCFullYear();

    const run = async (tx: any) => {
      const cashSessionId = order.cashSessionId ?? dto.cashSessionId;
      if (order.cashSessionId && dto.cashSessionId && order.cashSessionId !== dto.cashSessionId) throw new BadRequestException('Order belongs to another register session');
      if (cashSessionId) {
        await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', cashSessionId, orgId);
        const session = await tx.cashSession.findFirst({ where: { id: cashSessionId, organizationId: orgId } });
        if (!session || session.status !== 'open') throw new BadRequestException('The order register session is closed');
      }
      // Concurrency guard: lock the order row so two terminals can't both bill
      // the same order (the order.invoiceId fast-path at the top is read outside
      // this tx). Re-check invoiceId under the lock and replay if already billed.
      await tx.$queryRawUnsafe(`SELECT id FROM "Order" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`, orderId, orgId);
      const locked = await tx.order.findFirst({ where: { id: orderId, organizationId: orgId }, select: { invoiceId: true, version: true } });
      if (locked?.invoiceId) return tx.invoice.findFirst({ where: { id: locked.invoiceId } });
      if (locked?.version !== order.version) throw new BadRequestException('Order changed while billing. Refresh the saved order and quote.');

      if (!order.cashSessionId && cashSessionId) await tx.order.update({ where: { id: orderId }, data: { cashSessionId } });
      const totals = await this.builder.prepareLines(tx, lineInputs);
      if (dto.expectedTotal != null && dec(totals.total).minus(dto.expectedTotal).abs().gt('0.000001')) throw new BadRequestException('The price has changed. Review the refreshed quote before taking payment.');
      // H2: allocate the invoice number INSIDE the tx (after line pricing) so a
      // prepareLines failure no longer burns a number. NOTE: Postgres sequences
      // are non-transactional — a later rollback still advances the sequence, so
      // the INV- series can gap but never duplicates (see SequenceService). True
      // gap-free numbering needs a row-locked gapless counter (separate change).
      const invoiceNumber = await this.sequenceInvoiceNumber(year, tx);
      const inv = await tx.invoice.create({
        data: {
          organizationId: orgId,
          invoiceNumber,
          orderId,
          partnerId: order.partnerId!,
          branchId: dto.branchId ?? order.branchId ?? null,
          cashSessionId: cashSessionId ?? null,
          waiterId: order.waiterId ?? null,
          tableId: order.tableId ?? null,
          // Offline-first: an offline sale replayed later keeps its original
          // business date (drives the GL/journal date + report buckets).
          issueDate: resolveOccurredAt(dto.occurredAt) ?? new Date(),
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          discountType: txDiscType,
          discountValue: txDiscValue,
          discountSource: 'manual',
          discountReason,
          discountAppliedBy: this.tenant.userId ?? null,
          discountApprovedBy: dto.overrideById ?? null,
          discountApprovedAt: dto.overrideById ? new Date() : null,
          taxAmount: totals.taxAmount,
          totalAmount: totals.total,
          amountResidual: totals.total,
          status: 'draft',
          settlementStatus: 'unsettled',
          paymentMode: dto.paymentMode ?? null,
          // Order-level payment term (if any) flows onto the invoice, driving
          // its due-date derivation (resolveTerm in InvoiceService).
          paymentTermId: dto.paymentTermId ?? order.paymentTermId ?? null,
          reference: order.orderNumber,
          notes: order.notes ?? null,
          createdBy: this.tenant.userId ?? null,
        },
      });
      for (let i = 0; i < totals.prepared.length; i++) {
        const p = totals.prepared[i];
        const src: any = items[i];
        const accounts = await this.builder.groupForPosting(tx, { partnerId: order.partnerId, lines: [p] }, 'sales');
        const item = await tx.invoiceItem.create({
          data: {
            organizationId: orgId,
            invoiceId: inv.id,
            productId: p.productId,
            menuItemId: p.menuItemId,
            variantId: p.variantId ?? undefined,
            variantName: p.variantName ?? undefined,
            accompanimentOptionIds: src?.accompanimentOptionIds ?? [],
            accountId: accounts.itemByAccount.keys().next().value,
            taxAccountId: accounts.taxByAccount.keys().next().value ?? null,
            description: p.description,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            discountPercent: p.discountPercent,
            discountType: (p as any).discountType ?? 'percentage',
            discountAmount: (p as any).discountAmount ?? 0,
            discountReason: (p as any).discountReason ?? null,
            discountSource: (p as any).discountSource ?? 'manual',
            discountAppliedBy: this.tenant.userId ?? null,
            discountApprovedBy: null,
            discountApprovedAt: null,
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
            data: mods.map((m: any) => ({ organizationId: orgId, invoiceItemId: item.id, modifierId: m.modifierId ?? null, name: m.name, kitchenPrintName: m.kitchenPrintName ?? null, priceDelta: m.priceDelta })),
          });
        }
      }
      await recordBusinessOutcome(tx, { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, orderId, orderNumber: order.orderNumber, total: Number(inv.totalAmount) });
      // Post the invoice's own GL entry (Dr AR / Cr Revenue+Tax + Dr sales_discount).
      const dbItems = await tx.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      // Phase 3 — seed financial dimensions from the POS sale so the GL is
      // segmentable by cashier / shift / register (branch stays a typed column).
      const glDimensions: Record<string, string> = { source: 'pos' };
      if (cashSessionId) glDimensions.cashSessionId = cashSessionId;
      if (order.waiterId) glDimensions.cashierId = order.waiterId;
      if (order.deviceId) glDimensions.registerId = order.deviceId;
      const journalEntryId = await this.postInvoiceGl(tx, inv, dbItems, glDimensions);
      await tx.invoice.update({
        where: { id: inv.id },
        data: { journalEntryId, status: 'posted', postedAt: new Date(), postedBy: this.tenant.userId ?? null },
      });

      // Durable inventory posting. Under the default `at_invoice` policy the job
      // is enqueued here, ATOMICALLY with the invoice — a worker drains it with
      // backoff, per-line failures surface as InventoryException, and the sale is
      // never blocked by stock. Under any other `inventory.stockPostingTiming`
      // the deduction is triggered by a business event instead
      // (InventoryPostingSubscriber), so this path stays silent and the café's
      // behaviour is byte-identical to before.
      if (timing === 'at_invoice') {
        await this.enqueueStockPosting({
          orderId, invoiceId: inv.id, invoiceNumber, trigger: 'at_invoice', tx,
        });
      }

      // Bind the order to its invoice and advance it to `completed` (billed).
      // This MUST be in the same transaction as the invoice: it used to run
      // post-commit and only when `externalTx` was absent, so rental checkout
      // (rental-posting.service.ts, which supplies a tx) never had `invoiceId`
      // written by this service and its orders never left the open state —
      // which in turn broke `closeOrderForInvoice`, since that looks orders up
      // BY `invoiceId`. Every caller now behaves identically.
      //
      // The status half goes through the engine (validated transition + audit +
      // event, ADR-007); `invoiceId` is a domain column it does not know about.
      await this.workflows.transition({
        entityType: 'order', entityId: orderId, action: 'complete',
        entity: order, payload: { invoiceId: inv.id, invoiceNumber }, externalTx: tx,
      });
      await tx.order.update({ where: { id: orderId }, data: { invoiceId: inv.id } });

      return tx.invoice.findFirst({ where: { id: inv.id }, include: { items: { orderBy: { lineNumber: 'asc' } } } });
    };

    // Nested transaction: reuse the caller's tx when one is supplied (rental
    // checkout), otherwise own a fresh transaction.
    const invoice = externalTx ? await run(externalTx) : await this.prisma.client.$transaction((tx: any) => run(tx));

    // Post-commit side-effects are skipped when we're inside a caller's tx —
    // the outer transaction hasn't committed yet, so these would act on data
    // that may still roll back. (The order↔invoice binding is NOT one of these:
    // it now happens inside `run` above, for every caller.)
    if (!externalTx) {
      // Hold the billed quantities against available-to-promise until the async
      // stock job actually decrements them. Without this, ATP over-promises for
      // the whole window between billing and deduction. Runs after the invoice tx
      // commits and is best-effort by design: a reservation is an advisory number,
      // and a sale is never blocked by inventory bookkeeping.
      await this.reserveForInvoice(invoice, orderId).catch((e: any) =>
        this.logger.warn(`reservation skipped for ${invoice.invoiceNumber}: ${e?.message ?? e}`),
      );

      // M4 — fiscalization seam. Jurisdictions such as UG (EFRIS) require each
      // invoice be signed by a fiscal device and carry a fiscal code/QR. Runs
      // best-effort and gated by FISCAL_PROVIDER (default 'none' = disabled) so it
      // never blocks a sale; wire a real provider inside fiscalizeInvoice().
      await this.fiscalizeInvoice(invoice).catch((e: any) => this.logger.warn(`fiscalization skipped for ${invoice.invoiceNumber}: ${e?.message ?? e}`));

      this.events.publish(EVENTS.PosOrderInvoiced, {
        organizationId: orgId, orderId, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
      });
      await this.audit.record({ entity: 'Invoice', entityId: invoice.id, action: 'post' as any, newValues: { kind: 'invoice_generated', orderId, total: invoice.totalAmount.toString() } });
    }
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
  async receivePayment(invoiceId: string, dto: ReceivePaymentDto, externalTx?: any) {
    const orgId = this.tenant.organizationId;

    const run = async (tx: any) => {
      if (dto.cashSessionId) await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', dto.cashSessionId, orgId);
      // Serialise concurrent settlements of THIS invoice.
      await tx.$queryRawUnsafe(`SELECT id FROM "Invoice" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`, invoiceId, orgId);
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'cancelled' || invoice.status === 'refunded') throw new BadRequestException(`Invoice is ${invoice.status}`);
      const residual = Number(invoice.amountResidual);
      if (residual <= 0) throw new BadRequestException('Invoice is already fully paid');

      // If the invoice GL was posted with a cash/bank counter-account
      // (pre-settled), payments skip GL posting to avoid double-counting cash.
      // New invoices always debit AR. Legacy cash-counter postings require an
      // explicit accounting correction before accepting another collection.
      const skipGl = !invoice.receivableAccountId && ['cash', 'card', 'mobile_money'].includes(invoice.paymentMode);
      if (skipGl) throw new BadRequestException('Legacy invoice uses a cash/bank posting. Reconcile its original journal before collecting payment.');

      const tenders = this.normalizeTenders(dto, residual, { allowPartial: dto.allowPartial === true });
      const tendersSum = tenders.reduce((s, t) => s + Number(t.amount), 0);
      if (tenders.some((t) => t.method === 'cash') && !dto.cashSessionId) throw new BadRequestException('Select an open register for a cash payment');
      if (dto.amountTendered != null && (!Number.isFinite(dto.amountTendered) || dto.amountTendered < tendersSum || (!tenders.some((t) => t.method === 'cash') && dto.amountTendered > tendersSum))) throw new BadRequestException('Cash handed over is invalid for these tenders');
      const isPartial = tendersSum < residual - 0.000001;
      // D1: a pre-settled invoice already debited Cash/Bank for its FULL total at
      // generation, so a partial (skip-GL) payment would leave the GL claiming cash
      // that was never collected. Partial is only sound when the GL counter is AR.
      if (isPartial && skipGl) {
        throw new BadRequestException(
          'Partial payment is not allowed on an invoice billed with a pre-settled payment mode (cash/card/mobile money); settle in full or re-bill without a payment mode',
        );
      }

      let lastPaymentId: string | null = null;
      const paymentIds: string[] = [];
      for (const tender of tenders) {
        const accountId = tender.accountId;
        const payment = await this.payments.createReceipt({
          partnerId: invoice.partnerId,
          paymentDate: (resolveOccurredAt(dto.occurredAt) ?? new Date()).toISOString(),
          paymentMethod: tender.method,
          amount: tender.amount,
          reference: tender.reference,
          accountId,
          cashSessionId: dto.cashSessionId,
          // R2: allocate against the Invoice (not a Document).
          allocations: [{ invoiceId: invoice.id, amount: tender.amount }],
          // F17: a collection lands in the drawer of the cashier taking it. The
          // owner check stays ON unless this org has deliberately declared the
          // till shared; the refund path is the other flow that legitimately
          // posts into a session it does not own.
        } as any, tx, { allowSessionOwnerMismatch: await this.sharedDrawer(tx) });
        if ((payment as any)?.id) { lastPaymentId = (payment as any).id; paymentIds.push(lastPaymentId!); }
      }

      const fresh = await tx.invoice.findFirst({ where: { id: invoiceId } });
      const settled = Number(fresh!.amountResidual) <= 0;
      const wasCredit = invoice.paymentMode === 'credit';
      const settlementStatus = settled ? 'settled' : 'partially_settled';

      // Final paymentMode is derived from ALL allocations on settlement, not just
      // this call's tenders — a cash partial followed by a card completion must end
      // 'mixed', not 'card'. While partially paid we leave paymentMode untouched
      // (stays null → the GL counter remains AR, which matches reality).
      let paymentMode = invoice.paymentMode ?? null;
      if (settled) {
        if (wasCredit) {
          paymentMode = 'credit';
        } else {
          const allocs = await tx.paymentAllocation.findMany({
            where: { invoiceId, organizationId: orgId },
            include: { payment: { select: { paymentMethod: true, direction: true } } },
          });
          const modes = new Set(
            allocs
              .filter((a: any) => (a.payment?.direction ?? 'inbound') === 'inbound')
              .map((a: any) => MODE_FROM_METHOD[a.payment?.paymentMethod] ?? 'cash'),
          );
          paymentMode = modes.size > 1 ? 'mixed' : ([...modes][0] ?? 'cash');
        }
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          settlementStatus,
          status: settled ? 'paid' : invoice.status,
          settledBy: this.tenant.userId ?? null,
          version: { increment: 1 },
          ...(settled ? { paymentMode } : {}),
          // Record cash physically tendered so the receipt can show the change
          // given (amountTendered − totalAmount). Only on full settlement; the
          // value is already quarantined from tenders-sum, so GL/drawer are unaffected.
          ...(settled && dto.amountTendered != null ? { amountTendered: dto.amountTendered } : {}),
        },
      });

      const receiptType = settled ? (wasCredit ? 'settlement_receipt' : 'payment_receipt') : 'partial_payment_receipt';
      const receipt = await this.createReceipt(tx, invoice, receiptType, lastPaymentId);
      // The cashier/settlement copy printed right after the customer one.
      if (settled) await this.createReceipt(tx, invoice, 'merchant_copy', lastPaymentId);
      const closed = settled ? await this.closeOrderForInvoice(tx, invoiceId) : null;

      await recordBusinessOutcome(tx, { invoiceId, invoiceNumber: invoice.invoiceNumber, total: Number(invoice.totalAmount), settlementStatus, paymentMode, receiptId: receipt.id, paymentIds, change: Math.max(0, (dto.amountTendered ?? tendersSum) - tendersSum), amountDue: Number(fresh.amountResidual), settleMode: 'tender' }, true);
      return { paymentIds, residual, tendersSum, settled, paymentMode, settlementStatus, receiptId: receipt.id, closed, invoiceNumber: invoice.invoiceNumber };
    };
    const result = externalTx ? await run(externalTx) : await this.prisma.client.$transaction(run);

    // Side effects AFTER commit — never on a rolled-back tx.
    if (!externalTx) await this.printReceiptSafe(invoiceId);
    if (result.settled && !externalTx) {
      if (result.closed) this.events.publish(EVENTS.PosOrderClosed, { organizationId: orgId, orderId: result.closed.orderId, invoiceId });
      this.events.publish(EVENTS.PosInvoiceSettled, { organizationId: orgId, invoiceId, invoiceNumber: result.invoiceNumber, paymentMode: result.paymentMode });
    }

    const tendered = dto.amountTendered ?? result.tendersSum;
    return { paymentIds: result.paymentIds, invoiceId, settlementStatus: result.settlementStatus, paymentMode: result.paymentMode, receiptId: result.receiptId, change: Math.max(0, tendered - result.tendersSum) };
  }

  /**
   * Settle on credit (postpaid house account). AR is already booked at
   * generation, so this just flags the invoice CREDIT, issues the credit-issue
   * receipt, and closes the order (freeing the table) while leaving the balance
   * outstanding for later collection.
   *
   * D3: the whole thing runs in one transaction guarded by a `FOR UPDATE` lock
   * on the invoice (mirrors receivePayment) and the credit-limit check runs
   * inside the tx with a `FOR UPDATE` lock on the customer tab — otherwise two
   * terminals could both pass a check-then-act limit test and jointly blow the
   * limit, or race a concurrent cash settlement.
   */
  async afterExternalPaymentCommit(invoiceId: string) {
    const invoice = await this.findInvoice(invoiceId);
    if (!invoice) return;
    await this.printReceiptSafe(invoiceId);
    this.events.publish(EVENTS.PosInvoiceSettled, { organizationId: this.tenant.organizationId, invoiceId, invoiceNumber: invoice.invoiceNumber, paymentMode: invoice.paymentMode ?? 'mixed' });
  }

  async settleCredit(invoiceId: string, dto: SettleCreditDto = {}) {
    const orgId = this.tenant.organizationId;

    const result = await this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(`SELECT id FROM "Invoice" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`, invoiceId, orgId);
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'cancelled' || invoice.status === 'refunded') throw new BadRequestException(`Invoice is ${invoice.status}`);
      if (invoice.paymentMode === 'credit') throw new BadRequestException('Invoice is already settled on credit');
      if (Number(invoice.amountResidual) <= 0.001) throw new BadRequestException('Invoice is already settled');

      // A-020: the direct endpoint historically skipped the walk-in guard the
      // checkout path enforces — a WALKIN invoice must never enter AR.
      const partner = await tx.partner.findFirst({ where: { id: invoice.partnerId, organizationId: orgId } });
      if (!partner || partner.code === 'WALKIN') {
        throw new BadRequestException('A credit sale needs a named customer — walk-in invoices cannot be settled on account');
      }

      await this.assertCreditAllowed(invoice.partnerId, Number(invoice.amountResidual), tx);
      await tx.invoice.update({ where: { id: invoiceId }, data: { paymentMode: 'credit', settlementStatus: 'unsettled', settledBy: this.tenant.userId ?? null, version: { increment: 1 } } });
      const receipt = await this.createReceipt(tx, invoice, 'credit_issue_receipt', null);
      const closed = await this.closeOrderForInvoice(tx, invoiceId);
      await recordBusinessOutcome(tx, { invoiceId, invoiceNumber: invoice.invoiceNumber, total: Number(invoice.totalAmount), receiptId: receipt.id, settlementStatus: 'unsettled', paymentMode: 'credit', settleMode: 'credit', amountDue: Number(invoice.amountResidual), change: 0 }, true);
      return { receiptId: receipt.id, closed, invoiceNumber: invoice.invoiceNumber, partnerId: invoice.partnerId, amount: String(invoice.amountResidual) };
    });

    // Side effects AFTER commit — never on a rolled-back tx.
    if (result.closed) this.events.publish(EVENTS.PosOrderClosed, { organizationId: orgId, orderId: result.closed.orderId, invoiceId });
    this.events.publish(EVENTS.PosInvoiceCredited, {
      organizationId: orgId, invoiceId, invoiceNumber: result.invoiceNumber, partnerId: result.partnerId, amount: result.amount,
    });
    await this.audit.record({ entity: 'Invoice', entityId: invoiceId, action: 'update' as any, newValues: { kind: 'credit_issue', notes: dto.notes ?? null } });
    return { invoiceId, settlementStatus: 'unsettled', paymentMode: 'credit', receiptId: result.receiptId };
  }

  /**
   * F17 — is this org running one till for several servers? Off by default, so
   * a collection normally has to land in the taker's own drawer.
   */
  private async sharedDrawer(tx?: any): Promise<boolean> {
    const mod = await (tx ?? this.prisma.client).organizationModule.findUnique({
      where: { organizationId_moduleName: { organizationId: this.tenant.organizationId, moduleName: 'pos' } },
    });
    return (mod?.config as Record<string, unknown> | null)?.sharedDrawer === true;
  }

  /** Write off the outstanding balance (Dr bad-debt / Cr AR). */
  async writeOff(invoiceId: string, dto: WriteOffDto) {
    // A-030: re-read live roles instead of trusting the (possibly 12h-stale)
    // POS-token claims — a revoked pos:write_off must bite immediately.
    const perms = await currentPermissions(this as any, this.tenant.userId);
    if (!perms.includes('pos:write_off')) throw new BadRequestException('Write-off permission is required');
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to write off an invoice');
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', invoiceId, orgId);
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      const residual = dec(invoice.amountResidual);
      if (residual.lessThanOrEqualTo(0.001)) throw new BadRequestException('Nothing to write off');

      const badDebtAccount = await this.determination.mapped('bad_debt', tx);
      const arAccount = invoice.receivableAccountId;
      if (!arAccount) throw new BadRequestException('Verify the original invoice receivable account before writing off a legacy invoice');
      await this.posting.post({
        journalCode: 'GEN',
        date: new Date().toISOString(),
        description: `Write-off ${invoice.invoiceNumber} — ${dto.reason}`,
        sourceType: 'pos_invoice_writeoff',
        sourceId: invoice.id,
        branchId: invoice.branchId ?? undefined,
        lines: [
          { accountId: badDebtAccount, debit: residual.toString() },
          { accountId: arAccount, credit: residual.toString(), partnerId: invoice.partnerId },
        ],
      } as any, tx);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { settlementStatus: 'written_off', amountResidual: 0, version: { increment: 1 } },
      });
      const affected = await tx.order.findMany({ where: { invoiceId }, select: { tableId: true } });
      await tx.order.updateMany({ where: { invoiceId }, data: { status: 'closed', closedAt: new Date() } });
      // Closing the order(s) can leave the table with no active items — free it.
      for (const o of affected) await recomputeTableStatus(tx, o.tableId);
      await this.audit.recordInTx(tx, { entity: 'Invoice', entityId: invoiceId, action: 'update', newValues: { kind: 'write_off', reason: dto.reason, amount: residual.toString() } });
      this.events.publish(EVENTS.PosInvoiceWrittenOff, { organizationId: orgId, invoiceId, invoiceNumber: invoice.invoiceNumber, amount: residual.toString() });
      const outcome = { invoiceId, settlementStatus: 'written_off', amount: residual.toString() };
      await recordBusinessOutcome(tx, outcome, true);
      return outcome;
    });
  }

  async refund(invoiceId: string, reason?: string, opts?: RefundOptions) {
    return refundInvoice(this, invoiceId, reason, opts);
  }

  /** Read an invoice with items (public — used by controllers). */
  findInvoice(invoiceId: string) {
    return this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, organizationId: this.tenant.organizationId },
      include: { items: { orderBy: { lineNumber: 'asc' } }, receipts: true },
    });
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async sequenceInvoiceNumber(year: number, tx?: any): Promise<string> {
    // Reuse the shared sales-invoice sequence so POS + manual invoices share INV-
    // series. `tx` reserves the number in the same unit as the invoice write.
    return this.sequence.next(`invoice:${year}`, { prefix: `INV-${year}-`, padding: 6 }, tx);
  }

  /**
   * H3: deplete/return stock for a line's paid modifiers + accompaniments.
   * Modifiers link to a product via `Modifier.inventoryItemId`; accompaniments via
   * `AccompanimentOption.inventoryItemId` (resolved from the persisted option ids).
   * `dir` = 'issue' on sale, 'receive' on refund. Best-effort per unit: a missing
   * link or stock error is logged, never thrown (mirrors "never block sales").
   */
  private async issueLineExtras(db: any, item: any, lineQty: number, warehouseId: string, reference: string): Promise<LineExtraFailure[]> {
    return this.moveLineExtras(db, 'issue', item, lineQty, warehouseId, reference);
  }

  /**
   * F15 — returns the components that could not move instead of swallowing them
   * into the log. The caller records each as an InventoryException and counts it
   * toward the job's "needs review" total, so an un-deducted extra shot is a
   * visible work item rather than a silent stock drift.
   */
  private async moveLineExtras(
    db: any, dir: 'issue' | 'receive', item: any, lineQty: number, warehouseId: string, reference: string,
  ): Promise<LineExtraFailure[]> {
    const failures: LineExtraFailure[] = [];
    if (!(lineQty > 0)) return failures;
    // F14 — one selection consumes `consumptionQty` of its linked product in
    // `consumptionUomId` (falling back to the product's stock unit), scaled by
    // the line quantity. "Extra milk" can now mean 30 ml × N drinks, not N whole
    // units. consumptionQty defaults to 1, so unconfigured options are unchanged.
    const move = async (productId: string, componentId: string, consumptionQty: number, uomId?: string | null) => {
      const qty = lineQty * (Number.isFinite(consumptionQty) && consumptionQty > 0 ? consumptionQty : 1);
      // Deterministic per-component movement id: a retry of the same job cannot
      // book the same extra twice, and the ledger row traces back to the option.
      const args = {
        productId, locationId: warehouseId, quantity: qty, reference, uomId: uomId ?? undefined,
        sourceType: 'pos_invoice_extra', sourceId: `${item.id}:${componentId}`,
      } as any;
      if (dir === 'issue') await this.stock.issue(args, db);
      else await this.stock.receiveReturn(args, db);
    };
    // Modifiers (structured on the line).
    for (const m of (item.modifiers ?? []) as any[]) {
      if (!m.modifierId) continue;
      try {
        const mod = await db.modifier.findFirst({ where: { id: m.modifierId }, select: { inventoryItemId: true, consumptionQty: true, consumptionUomId: true } });
        if (mod?.inventoryItemId) await move(mod.inventoryItemId, m.modifierId, Number(mod.consumptionQty ?? 1), mod.consumptionUomId);
      } catch (e: any) {
        this.logger.error(`[stock] modifier extra ${dir} failed (${m.modifierId}) on ${reference} (kept): ${e?.message ?? e}`);
        failures.push({ componentId: m.modifierId, componentType: 'modifier', productId: null, error: e });
      }
    }
    // Accompaniment options (resolved from the persisted ids).
    const accIds: string[] = item.accompanimentOptionIds ?? [];
    if (accIds.length) {
      try {
        const opts = await db.accompanimentOption.findMany({ where: { id: { in: accIds } }, select: { id: true, inventoryItemId: true, consumptionQty: true, consumptionUomId: true } });
        for (const o of opts as any[]) {
          if (!o.inventoryItemId) continue;
          try { await move(o.inventoryItemId, o.id, Number(o.consumptionQty ?? 1), o.consumptionUomId); }
          catch (e: any) {
            this.logger.error(`[stock] accompaniment extra ${dir} failed on ${reference} (kept): ${e?.message ?? e}`);
            failures.push({ componentId: o.id, componentType: 'accompaniment_option', productId: o.inventoryItemId, error: e });
          }
        }
      } catch (e: any) {
        this.logger.error(`[stock] accompaniment lookup failed on ${reference} (kept): ${e?.message ?? e}`);
        failures.push({ componentId: accIds.join(','), componentType: 'accompaniment_option', productId: null, error: e });
      }
    }
    return failures;
  }

  /** Post the discounted sale to AR; actual payment journals move cash or electronic funds. */
  private async postInvoiceGl(
    tx: any, invoice: any, items: any[],
    dimensions?: Record<string, string>,
  ): Promise<string> {
    // Revenue and output tax use the same net discounted amounts the customer pays.
    const glSource = { partnerId: invoice.partnerId, lines: items };
    const { counterAccount: defaultCounter, itemByAccount, taxByAccount } = await this.builder.groupForPosting(tx, glSource, 'sales');

    const counterAccount = defaultCounter;
    await tx.invoice.update({ where: { id: invoice.id }, data: { receivableAccountId: counterAccount } });

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
      postingType: 'primary',
      postingKey: `pos_invoice:${invoice.id}:primary`,
      branchId: invoice.branchId ?? undefined,
      dimensions,
      lines,
    } as any, tx);
    return entry.id;
  }

  private normalizeTenders(dto: ReceivePaymentDto, residual: number, opts?: { allowPartial?: boolean }): TenderDto[] {
    if (dto.tenders?.length) {
      // D2: every leg must be a positive, finite amount (defence-in-depth for
      // internal callers that bypass the HTTP validation pipe).
      for (const t of dto.tenders) {
        const amt = Number(t.amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new BadRequestException('Tender amounts must be positive finite numbers');
      }
      const sum = dto.tenders.reduce((s, t) => s + Number(t.amount), 0);
      // Overpayment is always rejected — cash change is handled via amountTendered.
      if (sum > residual + 0.000001) throw new BadRequestException(`Tenders sum ${sum} exceeds amount due ${residual}`);
      // D1: underpayment is only allowed when the caller opts into partial settlement.
      if (sum < residual - 0.000001 && !opts?.allowPartial) throw new BadRequestException(`Tenders sum ${sum} does not match amount due ${residual}`);
      return dto.tenders;
    }
    // No explicit tenders → settle the whole residual with a single method.
    return [{ method: dto.paymentMethod ?? 'cash', amount: residual } as TenderDto];
  }

  /**
   * Hold billed quantities against ATP for the window between billing and the
   * async stock deduction.
   *
   * Gated by the `inventory.reservationMode` setting, which defaults to 'none'
   * — a single-location café has no use for available-to-promise, while a school
   * store or a warehouse issuing against requisitions very much does. Modes:
   *   'none'    → no reservations at all
   *   'invoice' → reserve once the bill is raised (implemented here)
   *   'order'   → same, plus reserved earlier at order-save (superset)
   *
   * Reservations are declarative per (sourceType, sourceId, product, variant,
   * location), so a re-bill of the same invoice sets quantities rather than
   * stacking them.
   */
  private async reserveForInvoice(invoice: any, orderId: string | null): Promise<void> {
    const mode = await this.reservations.mode();
    if (mode === 'none') return;

    const orgId = this.tenant.organizationId;
    const warehouse = await resolvePosStockLocation(this.prisma, orgId);
    if (!warehouse) return;

    const items = orderId
      ? await this.prisma.client.orderItem.findMany({ where: { orderId, cancelled: false } })
      : [];

    // Roll up per product: one order can carry the same product on several lines
    // (different modifiers), and a menu item explodes into shared ingredients.
    const byProduct = new Map<string, number>();
    const add = (productId: string, qty: number) => {
      if (!(qty > 0)) return;
      byProduct.set(productId, (byProduct.get(productId) ?? 0) + qty);
    };

    for (const it of items as any[]) {
      // Rental lines never hold ATP: rented stock is moved by the rental
      // posting service (internal transfer), not by the POS sale path, and the
      // rental booking calendar owns availability. Repair part lines are the
      // same: parts are relieved by the repair parts service (StockService.issue
      // at issue-time), so a repair invoice line must never reserve again. A
      // defensive re-filter so a mixed cart can never double-reserve.
      if (it.rentalAgreementLineId || it.repairOrderLineId) continue;
      const lineQty = Number(it.quantity);
      if (it.menuItemId) {
        const menuItem = await this.prisma.client.menuItem.findUnique({
          where: { id: it.menuItemId },
          select: { isInventoryTracked: true },
        });
        if (!menuItem?.isInventoryTracked) continue;
        const recipe = await this.prisma.client.menuProduct.findMany({
          where: { menuItemId: it.menuItemId, organizationId: orgId },
        });
        for (const ing of recipe as any[]) add(ing.productId, Number(ing.quantity) * lineQty);
      } else if (it.productId) {
        const product = await this.prisma.client.product.findFirst({ where: { id: it.productId } });
        if (product?.trackInventory && (product.productType === 'stockable' || product.productType === 'consumable')) {
          add(it.productId, lineQty);
        }
      }
    }

    for (const [productId, quantity] of byProduct) {
      await this.reservations.reserve({
        productId,
        locationId: warehouse.id,
        quantity,
        sourceType: 'invoice',
        sourceId: invoice.id,
        reason: `POS bill ${invoice.invoiceNumber}`,
      });
    }
  }

  /**
   * Phase 1 — process one durable StockPostingJob. Runs inside the worker's
   * tenant scope. A whole-run failure (e.g. no active warehouse — nothing was
   * deducted) is retried with backoff and, once exhausted, becomes a `failed`
   * job + a whole_invoice InventoryException that an admin can retry after
   * fixing config. Per-line failures are recorded as InventoryException rows and
   * do NOT fail the job (re-issuing a partially-deducted recipe would double-count).
   */
  async processStockPostingJob(jobId: string): Promise<void> {
    const job = await this.prisma.client.stockPostingJob.findFirst({ where: { id: jobId } });
    if (!job || job.status === 'done') return;
    const ctx: StockPostingCtx = { invoiceId: job.invoiceId, invoiceNumber: job.invoiceNumber, orderId: job.orderId };
    try {
      // Process the whole job atomically: every line's stock issue AND the final
      // status flip commit together, or not at all. Previously each line ran in
      // its own transaction with a separate status update, so a crash after some
      // lines committed left the job 'processing' — and the 60s stale-reclaim
      // then re-issued every line → double decrement + double COGS. One
      // transaction, fronted by a FOR UPDATE lock on the job row (so a reclaim of
      // a slow-but-alive worker serialises and sees 'done' instead of racing),
      // makes processing exactly-once. This is background work off the cashier's
      // path, so the wider lock span only affects queue-drain speed (monitored).
      const outcome = await this.prisma.client.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ status: string }[]>`
            SELECT "status" FROM "StockPostingJob" WHERE "id" = ${job.id} FOR UPDATE`;
          if (!locked.length || locked[0].status === 'done') return null; // finished by a racing worker
          const items = job.orderId
            ? await tx.orderItem.findMany({
                where: { orderId: job.orderId, cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true },
              })
            : [];
          const failures = await this.issueStockForItems(items, ctx, tx);
          await tx.stockPostingJob.update({
            where: { id: job.id },
            data: {
              status: 'done', processedAt: new Date(), claimToken: null, claimedAt: null,
              lastError: failures > 0 ? `${failures} line(s) need review` : null,
            },
          });
          return { failures };
        },
        { timeout: 30_000 },
      );
      if (outcome === null) return; // a concurrent worker already completed this job
      // The sale is final either way, but an un-deducted line is real stock
      // drift — surface it while the shift can still act on it (F-08).
      if (outcome.failures > 0) {
        await this.alertStockPostingFailure(ctx, `${outcome.failures} line(s) could not be deducted`, outcome.failures);
      }
      // The hold has served its purpose — the quantities are now decremented for
      // real, so leaving the reservation active would double-count against ATP.
      // Best-effort and idempotent, so kept OUT of the money transaction above: a
      // reservation hiccup must not roll back posted COGS. Reservations are keyed
      // on the invoice, so a pre-invoice trigger (no invoiceId) has none to clear.
      if (job.invoiceId) {
        await this.reservations
          .consume('invoice', job.invoiceId)
          .catch((e: any) => this.logger.warn(`reservation consume failed for ${job.invoiceNumber}: ${e?.message ?? e}`));
      }
    } catch (e: any) {
      const attempts = job.attempts + 1;
      const msg = (e?.message ?? String(e)).slice(0, 500);
      if (attempts >= job.maxAttempts) {
        await this.prisma.client.stockPostingJob.update({
          where: { id: job.id },
          data: { status: 'failed', attempts, lastError: msg, claimToken: null, claimedAt: null, processedAt: new Date() },
        });
        // The deduction will never happen on its own now, so the hold would sit
        // against ATP indefinitely. Release it — the InventoryException raised
        // below is the durable record that this stock still needs correcting.
        // Pre-invoice triggers hold no invoice-keyed reservation.
        if (job.invoiceId) {
          await this.reservations
            .release('invoice', job.invoiceId)
            .catch((e: any) => this.logger.warn(`reservation release failed for ${job.invoiceNumber}: ${e?.message ?? e}`));
        }
        await this.recordInventoryException(ctx, {
          kind: 'whole_invoice', productId: null, menuItemId: null, description: 'whole-invoice stock deduction',
          quantity: 0, locationId: null, reason: msg, stackTrace: e?.stack ?? null, payload: null,
        });
        // Audit F-08 — an exhausted job used to produce a log line and a row on
        // a page nobody has open. On-hand then drifts from reality for the rest
        // of the shift with nothing to say so. Put it in front of a human.
        await this.alertStockPostingFailure(ctx, msg);
      } else {
        // Exponential-ish backoff, capped at 15 min.
        const backoffMs = Math.min(60_000 * attempts, 15 * 60_000);
        await this.prisma.client.stockPostingJob.update({
          where: { id: job.id },
          data: { status: 'pending', attempts, lastError: msg, claimToken: null, claimedAt: null, nextRetryAt: new Date(Date.now() + backoffMs) },
        });
      }
    }
  }

  // Deduct stock for a billed order's lines. Throws only on a SYSTEMIC failure
  // (no active warehouse — nothing deducted, so the job may retry safely). Each
  // line is isolated: a per-line failure is recorded as an InventoryException and
  // counted, never thrown, so one un-stocked ingredient can't stop the rest and
  // the sale (already final) is never affected. Returns the number of line failures.
  private async issueStockForItems(items: any[], ctx: StockPostingCtx, tx: any): Promise<number> {
    const orgId = this.tenant.organizationId;
    const db = tx ?? this.prisma.client;
    const warehouse = await resolvePosStockLocation(this.prisma, orgId, db);
    if (!warehouse) throw new Error('No active warehouse configured — cannot deduct stock');
    const reference = ctx.invoiceNumber;
    const ref = `POS bill ${reference}`;
    let failures = 0;
    for (const it of items) {
      // Rental lines never enqueue a stock issue: checkout moved the unit via
      // the rental posting service's internal transfer (RENT-STOCK →
      // RENT-OUT). Repair part lines are the same: the repair parts service
      // issues the part through StockService.issue at issue-time, so the
      // invoice must not issue it a second time. Without this filter the worker
      // would issue the product again, booking double COGS + double relief.
      if (it.rentalAgreementLineId || it.repairOrderLineId) continue;
      try {
        if (it.menuItemId) {
          failures += await this.issueMenuItemRecipe(it.menuItemId, Number(it.quantity), warehouse.id, ctx, tx, it.variantId ?? null);
        } else if (it.productId) {
          const product = await db.product.findFirst({ where: { id: it.productId } });
          if (product?.trackInventory && (product.productType === 'stockable' || product.productType === 'consumable')) {
            // Sell-in-sales-unit: line qty is in the product's sales unit → convert to base.
            await this.stock.issue({ productId: it.productId, locationId: warehouse.id, quantity: Number(it.quantity), uomId: product.salesUomId ?? undefined, reference: ref, sourceType: 'pos_invoice', sourceId: ctx.invoiceId } as any, tx);
          }
        }
      } catch (e: any) {
        failures++;
        this.logger.error(`[stock] issue failed for "${it.description ?? it.productId ?? it.menuItemId}" on ${reference} (sale kept): ${e?.message ?? e}`);
        await this.recordInventoryException(ctx, {
          kind: it.menuItemId ? 'menu_recipe' : 'product',
          productId: it.productId ?? null, menuItemId: it.menuItemId ?? null, description: it.description ?? null,
          quantity: Number(it.quantity), locationId: warehouse.id, reason: e?.message ?? String(e), stackTrace: e?.stack ?? null,
          payload: { orderItemId: it.id, reference },
        }, tx);
      }
      // H3: deplete paid modifiers + accompaniments. A failure here never blocks
      // the (already final) sale, but it IS counted and recorded like any other
      // un-deducted line so the back office sees the drift.
      for (const f of await this.issueLineExtras(db, it, Number(it.quantity), warehouse.id, ref)) {
        failures++;
        await this.recordInventoryException(ctx, {
          kind: 'line_extras',
          productId: f.productId, menuItemId: it.menuItemId ?? null,
          description: `${f.componentType} on ${it.description ?? it.productId ?? it.menuItemId}`,
          quantity: Number(it.quantity), locationId: warehouse.id,
          reason: f.error?.message ?? String(f.error), stackTrace: f.error?.stack ?? null,
          payload: { orderItemId: it.id, reference, componentId: f.componentId, componentType: f.componentType },
        }, tx);
      }
    }
    return failures;
  }

  /**
   * F-08 — tell somebody that stock posting is behind reality.
   *
   * Rate-limited to one notification per organization per hour so a systemic
   * fault (a missing warehouse, say) raises one alert rather than one per sale.
   * Never throws: an alerting hiccup must not fail an already-final sale.
   */
  private async alertStockPostingFailure(ctx: StockPostingCtx, reason: string, lines = 0): Promise<void> {
    const orgId = this.tenant.organizationId;
    try {
      const hourAgo = new Date(Date.now() - 60 * 60_000);
      const recent = await this.prisma.raw.notification.findFirst({
        where: { organizationId: orgId, category: 'inventory', createdAt: { gte: hourAgo }, title: { startsWith: 'Stock posting' } },
        orderBy: { createdAt: 'desc' },
      });
      if (recent) return;
      const open = await this.prisma.client.inventoryException.count({ where: { organizationId: orgId, status: 'open' } });
      await this.notifications.send({
        organizationId: orgId,
        channel: 'in_app',
        category: 'inventory',
        title: 'Stock posting needs review',
        body: `${reason}${ctx.invoiceNumber ? ` on ${ctx.invoiceNumber}` : ''}. On-hand is behind actual sales until this is resolved — ${open} open exception(s) in the Posting Monitor.`,
        payload: { kind: 'stock_posting_failed', invoiceId: ctx.invoiceId, invoiceNumber: ctx.invoiceNumber, orderId: ctx.orderId, lines, openExceptions: open },
      });
    } catch (err) {
      this.logger.error(`[stock] failed to raise a posting-failure alert: ${String(err)}`);
    }
  }

  /**
   * Phase 1 — record a structured InventoryException (replaces the dead
   * `stock_reconcile_needed` audit marker). A back-office work-queue item: a
   * specific sale line whose stock could not be issued, awaiting a human decision.
   * Never throws — recording drift must not break an already-final sale.
   */
  private async recordInventoryException(ctx: StockPostingCtx, f: StockLineFailure, tx?: any): Promise<void> {
    try {
      await (tx ?? this.prisma.client).inventoryException.create({
        data: {
          organizationId: this.tenant.organizationId,
          invoiceId: ctx.invoiceId ?? null,
          invoiceNumber: ctx.invoiceNumber ?? null,
          locationId: f.locationId ?? null,
          productId: f.productId ?? null,
          menuItemId: f.menuItemId ?? null,
          description: f.description ?? null,
          quantity: f.quantity ?? 0,
          kind: f.kind,
          reason: (f.reason ?? '').slice(0, 1000),
          stackTrace: f.stackTrace ?? null,
          payload: (f.payload ?? undefined) as any,
          status: 'open',
        },
      });
    } catch (err) {
      this.logger.error(`[stock] failed to record InventoryException for ${ctx.invoiceNumber}: ${String(err)}`);
    }
  }

  /**
   * M4 — fiscalization adapter seam. Default 'none' = disabled (no behavior
   * change). Set FISCAL_PROVIDER to a real device/EFD integration (e.g. 'efris')
   * and implement the sign + persist below. Until then, when a provider is
   * configured we record an auditable "pending" marker so operators can see the
   * invoice was expected to be fiscally signed but no adapter is wired yet.
   */
  private async fiscalizeInvoice(invoice: any): Promise<void> {
    const provider = (process.env.FISCAL_PROVIDER ?? 'none').toLowerCase();
    if (provider === 'none') return;
    // A real fiscal-device adapter goes here: sign the invoice, then persist the
    // returned code/QR with fiscalStatus 'signed'. Until one is wired, mark the
    // invoice 'pending' ON THE INVOICE (not just an audit log) so the gap is
    // queryable and reportable — an operator can list unsigned invoices instead
    // of discovering the hole at audit time. Setting FISCAL_PROVIDER is NOT a
    // compliance solution; see docs/audit/FISCALIZATION.md.
    await this.prisma.client.invoice.update({
      where: { id: invoice.id },
      data: { fiscalStatus: 'pending' },
    }).catch(() => undefined);
    await this.audit.record({
      entity: 'Invoice', entityId: invoice.id, action: 'update' as any,
      newValues: { kind: 'fiscalization_pending', provider, invoiceNumber: invoice.invoiceNumber },
    });
    this.logger.warn(`[fiscal] provider '${provider}' set but no adapter wired — invoice ${invoice.invoiceNumber} not fiscally signed`);
  }

  /** Issue a menu item's recipe BOM. Returns the count of ingredients that failed
   *  (each recorded as an InventoryException). Never throws — a bad ingredient
   *  can't stop the rest, and the sale is already final. */
  private async issueMenuItemRecipe(menuItemId: string, lineQty: number, warehouseId: string, ctx: StockPostingCtx, tx: any, variantId?: string | null): Promise<number> {
    const db = tx ?? this.prisma.client;
    const menuItem = await db.menuItem.findUnique({
      where: { id: menuItemId },
      select: { isInventoryTracked: true, name: true },
    });
    if (!menuItem?.isInventoryTracked) return 0;
    // F14 — a size variant can consume more (or less) of the base recipe. The
    // multiplier is independent of price: a "Large" priced +30% may still use
    // 1.5× the ingredients (or the same). Defaults to 1 when unset.
    let recipeMultiplier = 1;
    if (variantId) {
      const variant = await db.menuItemVariant.findFirst({ where: { id: variantId, menuItemId }, select: { qtyMultiplier: true } });
      const m = variant?.qtyMultiplier != null ? Number(variant.qtyMultiplier) : 1;
      if (Number.isFinite(m) && m > 0) recipeMultiplier = m;
    }
    const effectiveLineQty = lineQty * recipeMultiplier;
    const recipe = await db.menuProduct.findMany({ where: { menuItemId, organizationId: this.tenant.organizationId } });
    const reference = ctx.invoiceNumber;
    const ref = `POS bill ${reference}`;

    // A menu item flagged inventory-tracked but with NO recipe (BOM) relieves no
    // stock and posts no COGS. This used to return 0 silently, so the sale booked
    // full revenue at zero cost and gross margin was overstated with nothing to
    // flag it. Surface it as an InventoryException so it lands in the Posting
    // Monitor and can be corrected (add a recipe, or turn inventory tracking off
    // for this item). Counts as one failure so the job's lastError reflects it.
    // Never blocks the sale.
    if ((recipe as any[]).length === 0) {
      this.logger.warn(`[stock] menu item ${menuItemId} (${menuItem.name ?? ''}) is inventory-tracked but has no recipe on ${reference} — no COGS relieved (sale kept)`);
      await this.recordInventoryException(ctx, {
        kind: 'menu_recipe', productId: null, menuItemId, description: menuItem.name ?? 'menu item',
        quantity: lineQty, locationId: warehouseId,
        reason: 'Menu item is inventory-tracked but has no recipe (BOM); COGS was not relieved. Add a recipe or turn off inventory tracking for this item.',
        stackTrace: null, payload: { menuItemId, lineQty, reference },
      }, tx);
      return 1;
    }

    let failures = 0;
    for (const ing of recipe as any[]) {
      const qty = Number(ing.quantity) * effectiveLineQty;
      if (!(qty > 0)) continue;
      try {
        // A-024: stamp the recipe issue with the owning menu item + invoice so
        // the ledger row is traceable (referenceType/referenceId), and keep the
        // human-readable `reference` for the notes/reference column.
        await this.stock.issue({
          productId: ing.productId,
          locationId: warehouseId,
          quantity: qty,
          uomId: ing.uomId ?? undefined,
          reference: ref,
          sourceType: 'menu_recipe',
          sourceId: ctx.invoiceId,
          notes: `${menuItem.name ?? 'menu item'} → ${ref}`,
        } as any, tx);
      } catch (e: any) {
        failures++;
        this.logger.error(`[stock] recipe issue failed (menuItem ${menuItemId}, product ${ing.productId}) on ${reference} (sale kept): ${e?.message ?? e}`);
        await this.recordInventoryException(ctx, {
          kind: 'menu_recipe', productId: ing.productId, menuItemId, description: 'recipe ingredient',
          quantity: qty, locationId: warehouseId, reason: e?.message ?? String(e), stackTrace: e?.stack ?? null,
          payload: { menuItemId, ingredientProductId: ing.productId, quantity: qty, reference },
        }, tx);
      }
    }
    return failures;
  }

  private async receiveMenuItemRecipe(tx: any, menuItemId: string, lineQty: number, warehouseId: string, reference: string): Promise<void> {
    const menuItem = await tx.menuItem.findUnique({
      where: { id: menuItemId },
      select: { isInventoryTracked: true },
    });
    if (!menuItem?.isInventoryTracked) return;
    const recipe = await tx.menuProduct.findMany({ where: { menuItemId, organizationId: this.tenant.organizationId } });
    for (const ing of recipe as any[]) {
      const qty = Number(ing.quantity) * lineQty;
      if (!(qty > 0)) continue;
      await this.stock.receiveReturn({ productId: ing.productId, locationId: warehouseId, quantity: qty, uomId: ing.uomId ?? undefined, reference, sourceType: 'pos_refund', sourceId: reference }, tx);
    }
  }

  /** Create a Receipt + ReceiptItems on the given executor (a tx, or the base client). */
  private async createReceipt(db: any, invoice: any, type: string, paymentId: string | null) {
    const orgId = this.tenant.organizationId;
    const receiptNumber = await this.sequence.next('receipt', { prefix: 'RCT-', padding: 6 }, db);
    const receipt = await db.receipt.create({
      data: { organizationId: orgId, invoiceId: invoice.id, receiptNumber, type: type as any, paymentId: paymentId ?? null, printedById: this.tenant.userId ?? null },
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
    if (order.status !== 'closed') {
      // Through the engine so the transition is validated and an AuditLog row +
      // domain event are written (ADR-007). `close` carries no permission — this
      // is settlement-driven, and its route is already gated.
      await this.workflows.transition({
        entityType: 'order', entityId: order.id, action: 'close',
        entity: order, payload: { invoiceId }, externalTx: db,
      });
    }
    await db.order.update({ where: { id: order.id }, data: { closedAt: new Date() } });
    // Close the table↔order occupancy link. The floor-map card reads the OPEN
    // link (its openedAt drives the dining-minutes timer, the joined order's
    // totalAmount drives the running bill). Closing the Order alone frees the
    // table (status recomputes to available) but leaves the link open, so the
    // mins + bill amount would linger on the card. Setting closedAt drops it
    // from the "open" filter — resetting the timer and total — while preserving
    // the row (and its openedAt) for dining-time reports.
    if (order.tableId) {
      await db.posTableOrder.updateMany({
        where: { organizationId: orgId, tableId: order.tableId, orderId: order.id, closedAt: null },
        data: { closedAt: new Date() },
      });
    }
    // Settlement is the one release that leaves a table needing a wipe-down.
    await this.freeTableIfEmpty(db, order.tableId, { dirtyOnRelease: true });
    return { orderId: order.id, tableId: order.tableId };
  }

  private async freeTableIfEmpty(
    db: any, tableId?: string | null, opts: { dirtyOnRelease?: boolean } = {},
  ): Promise<void> {
    // Derived from the active-item count: a table with a billed-but-unpaid
    // order (status 'completed', items intact) stays occupied; it frees only
    // once the settled order goes 'closed' and no active items remain.
    await recomputeTableStatus(db, tableId, opts);
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

  /**
   * Gate a credit issue against the customer's credit control.
   *
   * D3: serialise concurrent credit issues for the SAME partner by locking the
   * customer-tab row before reading outstanding balance. Lock order is always
   * Invoice → CustomerTab (settleCredit takes the invoice lock first), so no
   * deadlock cycle with receivePayment (which only locks the invoice).
   */
  async assertCreditAllowed(partnerId: string, amount: number, db: any = this.prisma.client): Promise<void> {
    const orgId = this.tenant.organizationId;
    const status = await resolveCreditStatus(db, orgId, partnerId, { lock: true });
    if (status.creditHold) {
      throw new BadRequestException('This customer is on credit hold — new credit sales are blocked');
    }
    if (status.creditLimit <= 0) return; // no limit configured
    if (status.outstanding + amount > status.creditLimit + 0.01) {
      throw new BadRequestException(
        `Credit limit exceeded: outstanding ${status.outstanding} + ${amount} > limit ${status.creditLimit}`,
      );
    }
  }
}
