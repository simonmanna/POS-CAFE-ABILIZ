import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { BadRequestException, ForbiddenException, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import type { WorkflowDefinition } from '@erp/shared';
import { WorkflowRegistry } from '../../../kernel/workflow/workflow.registry';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { PostingService } from '../../accounting/posting/posting.service';
import { StockService } from '../../inventory/stock.service';
import { DocumentBuilderService } from '../document/document-builder.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';
import { JournalService } from '../../accounting/journal/journal.service';
import { BillReceiptMatcherService, BillLineMatch } from '../vendor-bill/bill-receipt-matcher.service';
import { Prisma } from '@prisma/client';

/**
 * Registers the workflows for invoicing-side documents (ADR-007): invoice,
 * credit note, vendor bill, payment. Each module owns its workflows so the
 * kernel layer stays free of business dependencies.
 */
@Injectable()
export class InvoicingWorkflowsInitializer implements OnModuleInit {
  private readonly logger = new Logger('InvoicingWorkflows');

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly stock: StockService,
    private readonly builder: DocumentBuilderService,
        private readonly determination: AccountDeterminationService,
        private readonly journals: JournalService,
        private readonly matcher: BillReceiptMatcherService,
      ) {}

  onModuleInit(): void {
    this.registry.register(this.invoiceWorkflow());
    this.registry.register(this.creditNoteWorkflow());
    this.registry.register(this.vendorBillWorkflow());
    this.registry.register(this.paymentWorkflow());
  }

  // ───────────────────── invoice ─────────────────────
  private invoiceWorkflow(): WorkflowDefinition {
    return {
      documentType: 'invoice',
      initial: 'draft',
      transitions: [
        {
          from: 'draft', to: 'posted', action: 'post',
          permission: 'invoice:post',
          guard: (ctx) => {
            const doc = ctx.entity as any;
            if (doc?.status === 'posted' || doc?.status === 'paid') return false;
            if (doc?.status === 'cancelled') return false;
            return true;
          },
          sideEffect: async (ctx, tx) => {
            const doc = ctx.entity as any;
            const productIds = (doc.lines ?? []).map((l: any) => l.productId).filter(Boolean);
            const products = await tx.product.findMany({
              where: { id: { in: productIds } },
              include: { category: true },
            });
            const productById = new Map(products.map((p: any) => [p.id, p]));
            for (const line of doc.lines ?? []) {
              const product: any = line.productId ? productById.get(line.productId) : null;
              if (product?.trackInventory && line.productId) {
                const location = await tx.inventoryLocation.findFirst({
                  where: { organizationId: ctx.organizationId, type: 'warehouse', isActive: true },
                  orderBy: { createdAt: 'asc' },
                });
                if (!location) throw new Error(`No warehouse location for stockable line ${product.name}`);
                await this.stock.issue({
                  productId: line.productId,
                  locationId: location.id,
                  quantity: Number(line.quantity),
                  date: doc.issueDate.toISOString(),
                  sourceType: 'sales_invoice',
                  sourceId: doc.id,
                  notes: `Auto-issue for invoice ${doc.documentNumber}`,
                });
              }
            }
            const fullDoc = await tx.document.findFirst({ where: { id: doc.id }, include: { lines: true } });
            fullDoc.lines = fullDoc.lines.map((l: any) => ({ ...l, product: l.productId ? productById.get(l.productId) : null }));
            const { counterAccount, itemByAccount, taxByAccount } = await this.builder.groupForPosting(tx, fullDoc, 'sales');
            const lines: any[] = [
              { accountId: counterAccount, debit: fullDoc.totalAmount.toString(), partnerId: fullDoc.partnerId, description: `Invoice ${fullDoc.documentNumber}` },
            ];
            for (const [accountId, amount] of itemByAccount) {
              lines.push({ accountId, credit: amount.toString(), partnerId: fullDoc.partnerId, description: 'Revenue' });
            }
            for (const [accountId, amount] of taxByAccount) {
              lines.push({ accountId, credit: amount.toString(), description: 'Output tax' });
            }
            // Journal resolution: the invoice's Invoicing Journal → the org
                        // Default Sales Journal setting → legacy `SALES` → first sales journal.
                        const journal = await this.journals.resolveSalesJournal(tx, fullDoc.invoicingJournalId);
                        const entry = await this.posting.post({
                          journalCode: journal.code,
                          date: fullDoc.issueDate,
                          description: `Invoice ${fullDoc.documentNumber}`,
              currencyId: fullDoc.currencyId ?? undefined,
              exchangeRate: Number(fullDoc.exchangeRate),
              sourceType: 'invoice',
              sourceId: fullDoc.id,
              lines,
            }, tx);
            await tx.document.updateMany({
              where: { id: fullDoc.id },
              data: { journalEntryId: entry.id, amountResidual: fullDoc.totalAmount, paymentStatus: 'not_paid' },
            });
          },
        },
        {
          from: 'posted', to: 'cancelled', action: 'cancel',
          permission: 'invoice:cancel',
          guard: (ctx) => {
            const doc = ctx.entity as any;
            return !(Number(doc?.amountPaid) > 0);
          },
          sideEffect: async (ctx, tx) => {
            const doc = ctx.entity as any;
            if (doc.journalEntryId) {
              await this.posting.reverse(doc.journalEntryId, { description: `Cancellation of ${doc.documentNumber}` }, tx);
            }
            await tx.document.updateMany({
              where: { id: doc.id },
              data: { amountResidual: 0, paymentStatus: 'not_paid' },
            });
          },
        },
      ],
    };
  }

  // ───────────────────── credit note ─────────────────────
  private creditNoteWorkflow(): WorkflowDefinition {
    return {
      documentType: 'credit_note',
      initial: 'draft',
      transitions: [
        {
          from: 'draft', to: 'posted', action: 'post',
          permission: 'credit_note:post',
          sideEffect: async (ctx, tx) => {
            const doc = ctx.entity as any;
            const fullDoc = await tx.document.findFirst({ where: { id: doc.id }, include: { lines: true } });
            const { counterAccount, itemByAccount, taxByAccount } = await this.builder.groupForPosting(tx, fullDoc, 'sales');
            const lines: any[] = [
              { accountId: counterAccount, credit: fullDoc.totalAmount.toString(), partnerId: fullDoc.partnerId, description: `Credit note ${fullDoc.documentNumber}` },
            ];
            for (const [accountId, amount] of itemByAccount) {
              lines.push({ accountId, debit: amount.toString(), partnerId: fullDoc.partnerId, description: 'Revenue reversal' });
            }
            for (const [accountId, amount] of taxByAccount) {
              lines.push({ accountId, debit: amount.toString(), description: 'Output tax reversal' });
            }
            await this.posting.post({
              journalCode: 'SALES',
              date: fullDoc.issueDate,
              description: `Credit note ${fullDoc.documentNumber}`,
              currencyId: fullDoc.currencyId ?? undefined,
              exchangeRate: Number(fullDoc.exchangeRate),
              sourceType: 'credit_note',
              sourceId: fullDoc.id,
              lines,
            }, tx);
          },
        },
      ],
    };
  }

  /**
   * Purchase price variance account. Falls back to Stock Adjustment Expense for
   * organisations created before the `purchase_price_variance` mapping key
   * existed — a missing PPV account must never stop a bill from posting.
   */
  private async resolvePriceVarianceAccount(tx: any): Promise<string> {
    try {
      return await this.determination.mapped('purchase_price_variance', tx);
    } catch {
      return this.determination.mapped('stock_adjustment_expense', tx);
    }
  }

  // ───────────────────── vendor bill ─────────────────────
  private vendorBillWorkflow(): WorkflowDefinition {
    return {
      documentType: 'vendor_bill',
      initial: 'draft',
      transitions: [
        {
          from: 'draft', to: 'posted', action: 'post',
          permission: 'expense:post',
          /**
           * Posting a bill used to receive every stockable line into stock
           * unconditionally, with no link to the goods receipt that had already
           * brought the delivery in - so the ordinary AP workflow (PO -> GRN ->
           * supplier invoice) booked one delivery twice and left GRNI dirty.
           *
           * Each stockable line is now matched against open (received but
           * unbilled) receipt quantity for the same supplier + product, and
           * splits three ways:
           *
           *   vouchered  - a PO-driven receive already posted Dr GRNI + Dr Input
           *                Tax / Cr AP for these goods. The bill is a confirming
           *                document: no stock, no GL, or AP doubles.
           *   accrued    - an ad-hoc receipt left GRNI open on purpose. Post
           *                Dr GRNI / Cr AP, but receive nothing.
           *   unmatched  - no receipt covers it (bill before goods). Receive it,
           *                which posts Dr Stock / Cr GRNI, and the bill's own
           *                GRNI debit nets it back out.
           */
          sideEffect: async (ctx, tx) => {
            const doc = ctx.entity as any;
            const products = await tx.product.findMany({
              where: { id: { in: doc.lines.map((l: any) => l.productId).filter(Boolean) } },
            });
            const productById = new Map(products.map((p: any) => [p.id, p]));
            const fullDoc = await tx.document.findFirst({ where: { id: doc.id }, include: { lines: true } });
            fullDoc.lines = fullDoc.lines.map((l: any) => ({ ...l, product: l.productId ? productById.get(l.productId) : null }));

            // 1. Match every stockable line against open receipts, and build the
            //    postable view of the bill: the vouchered share carries no GL.
            const matchByLine = new Map<string, BillLineMatch>();
            const postableLines: any[] = [];
            let postableTotal = new Prisma.Decimal(0);
            // Invoice price minus the cost the goods were received at, over the
            // quantity that matched an open accrual. Positive = the supplier
            // billed more than the receipt capitalised.
            let priceVariance = new Prisma.Decimal(0);
            for (const line of fullDoc.lines) {
              const stockable = Boolean(line.product?.trackInventory && line.productId);
              const qty = new Prisma.Decimal(line.quantity ?? 0);
              if (!stockable || qty.lte(0)) {
                postableLines.push(line);
                postableTotal = postableTotal.plus(line.total ?? 0);
                continue;
              }
              const match = await this.matcher.matchLine(tx, {
                organizationId: ctx.organizationId,
                partnerId: fullDoc.partnerId,
                productId: line.productId,
                quantity: qty,
              });
              matchByLine.set(line.id, match);

              if (match.accruedQuantity.greaterThan(0)) {
                const billUnitPrice = new Prisma.Decimal(line.subtotal ?? 0).dividedBy(qty);
                priceVariance = priceVariance
                  .plus(billUnitPrice.times(match.accruedQuantity))
                  .minus(match.accruedReceiptValue);
              }

              const postableQty = qty.minus(match.voucheredQuantity);
              if (postableQty.lte(0)) continue; // fully covered by the receipt voucher
              if (postableQty.equals(qty)) {
                postableLines.push(line);
                postableTotal = postableTotal.plus(line.total ?? 0);
                continue;
              }
              const factor = postableQty.dividedBy(qty);
              postableLines.push({
                ...line,
                quantity: postableQty,
                subtotal: new Prisma.Decimal(line.subtotal ?? 0).times(factor),
                taxAmount: new Prisma.Decimal(line.taxAmount ?? 0).times(factor),
                total: new Prisma.Decimal(line.total ?? 0).times(factor),
              });
              postableTotal = postableTotal.plus(new Prisma.Decimal(line.total ?? 0).times(factor));
            }

            // 2. GL. A bill whose every line was already vouchered by its PO
            //    receipt posts nothing at all - the payable exists already.
            let entryId: string | null = null;
            if (postableTotal.greaterThan(0)) {
              const grniAccountId = await this.determination.mapped('grni_accrued', tx);
              const { counterAccount, itemByAccount, taxByAccount } = await this.builder.groupForPosting(
                tx,
                { ...fullDoc, lines: postableLines },
                'purchase',
                grniAccountId,
              );
              const lines: any[] = [];
              for (const [accountId, amount] of itemByAccount) {
                lines.push({ accountId, debit: amount.toString(), partnerId: fullDoc.partnerId, description: accountId === grniAccountId ? 'GRNI clearing' : 'Expense' });
              }
              for (const [accountId, amount] of taxByAccount) {
                lines.push({ accountId, debit: amount.toString(), description: 'Input tax' });
              }
              // Purchase price variance. The GRNI debit above is at the invoice
              // price, but the receipt only credited GRNI at the cost the goods
              // landed at. Move the gap to PPV so the accrual actually clears
              // instead of leaving a residual nobody ever reconciles.
              if (!priceVariance.isZero()) {
                const ppvAccountId = await this.resolvePriceVarianceAccount(tx);
                const grniLine = lines.find((l: any) => l.accountId === grniAccountId && l.debit);
                if (grniLine) {
                  grniLine.debit = new Prisma.Decimal(grniLine.debit).minus(priceVariance).toString();
                }
                if (priceVariance.greaterThan(0)) {
                  lines.push({ accountId: ppvAccountId, debit: priceVariance.toString(), description: 'Purchase price variance' });
                } else {
                  lines.push({ accountId: ppvAccountId, credit: priceVariance.negated().toString(), description: 'Purchase price variance' });
                }
              }
              lines.push({
                accountId: counterAccount,
                credit: postableTotal.toString(),
                partnerId: fullDoc.partnerId,
                description: `Bill ${fullDoc.documentNumber}`,
              });
              const entry = await this.posting.post({
                journalCode: 'PURCH',
                date: fullDoc.issueDate,
                description: `Bill ${fullDoc.documentNumber}`,
                currencyId: fullDoc.currencyId ?? undefined,
                exchangeRate: Number(fullDoc.exchangeRate),
                sourceType: 'vendor_bill',
                sourceId: fullDoc.id,
                // Idempotency: a retried post replays the existing entry instead
                // of raising the payable a second time.
                postingKey: `vendor_bill:${fullDoc.id}`,
                lines,
              }, tx);
              entryId = entry.id;
            }

            // 3. Stock. Only the unmatched remainder moves - everything else is
            //    already physically on the shelf.
            for (const line of fullDoc.lines) {
              if (!(line.product?.trackInventory && line.productId)) continue;
              const match = matchByLine.get(line.id);
              const qty = new Prisma.Decimal(line.quantity ?? 0);
              if (match) {
                await this.matcher.consume(
                  tx,
                  { organizationId: ctx.organizationId, vendorBillId: fullDoc.id, documentLineId: line.id },
                  match,
                );
              }
              const toReceive = match ? match.unmatchedQuantity : qty;
              if (toReceive.lte(0)) continue;

              // Land the goods where the matched receipts did; only fall back to
              // "some warehouse" when nothing tells us better.
              const locationId =
                match?.locationId ??
                (
                  await tx.inventoryLocation.findFirst({
                    where: { organizationId: ctx.organizationId, type: 'warehouse', isActive: true },
                    orderBy: { createdAt: 'asc' },
                  })
                )?.id;
              if (!locationId) throw new Error(`No warehouse location for stockable line ${line.product.name}`);

              // Value the receipt at the bill line's NET unit price, not the
              // product's standard cost. Two reasons: the GRNI credit raised
              // here must equal the GRNI debit the bill JE posts or the accrual
              // never nets to zero; and receiving at a stale costPrice means the
              // moving average never learns the real purchase price.
              const unitCost = qty.greaterThan(0)
                ? new Prisma.Decimal(line.subtotal ?? 0).dividedBy(qty).toNumber()
                : 0;
              await this.stock.receiveFromBill(
                {
                  productId: line.productId,
                  locationId,
                  quantity: toReceive.toNumber(),
                  unitCost,
                  // Bill quantities are in the product's purchase unit (a case,
                  // a carton). Without this the engine treats 10 cases as 10
                  // base units and the valuation is out by the pack factor.
                  uomId: line.product.purchaseUomId ?? undefined,
                  billId: fullDoc.id,
                  billDate: fullDoc.issueDate.toISOString(),
                  notes: `Auto-receive for bill ${fullDoc.documentNumber}`,
                } as any,
                tx,
              );
            }

            await tx.document.updateMany({
              where: { id: fullDoc.id },
              data: {
                journalEntryId: entryId,
                // The residual is what this bill actually put on AP. The share
                // the PO receipt already vouchered is owed against that voucher,
                // not against this document - counting it here would double the
                // supplier's balance in AP aging.
                amountResidual: postableTotal,
                paymentStatus: 'not_paid',
              },
            });
          },
        },
        {
          from: 'posted', to: 'cancelled', action: 'cancel',
          permission: 'expense:cancel',
          guard: (ctx) => !(Number((ctx.entity as any)?.amountPaid) > 0),
          sideEffect: async (ctx, tx) => {
            const doc = ctx.entity as any;
            if (doc.journalEntryId) {
              await this.posting.reverse(doc.journalEntryId, { description: `Void of ${doc.documentNumber}` }, tx);
            }
            // Give the receipt quantity back, or the corrected bill would find
            // nothing to match and receive the same delivery all over again.
            await this.matcher.releaseForBill(tx, ctx.organizationId, doc.id);
            await tx.document.updateMany({
              where: { id: doc.id },
              data: { amountResidual: 0, paymentStatus: 'not_paid' },
            });
          },
        },
      ],
    };
  }

  // ───────────────────── payment ─────────────────────
  private paymentWorkflow(): WorkflowDefinition {
    return {
      documentType: 'payment',
      initial: 'posted',
      transitions: [
        {
          from: 'posted', to: 'cancelled', action: 'void',
          permission: 'payment:void',
          sideEffect: async (ctx, tx) => {
            const payload = (ctx.payload ?? {}) as { reason?: string; correctionSessionId?: string };
            const reason = String(payload.reason ?? '').trim();
            if (!reason) throw new BadRequestException('A reason is required to void a payment');
            await tx.$queryRawUnsafe('SELECT id FROM "Payment" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', ctx.entityId, ctx.organizationId);
            const payment = await tx.payment.findFirst({ where: { id: ctx.entityId, organizationId: ctx.organizationId }, include: { allocations: true } });
            if (!payment || payment.status !== 'posted') throw new BadRequestException('Only a posted payment can be voided');
            const drawerMovements = await tx.cashMovement.findMany({
              where: { paymentId: payment.id, organizationId: ctx.organizationId },
            });

            // Resolve where the drawer reversal lands BEFORE touching the ledger.
            // Same shift while it is open; otherwise a linked correction in the
            // caller's current shift on the same drawer. The closed shift and its
            // Z report are never modified.
            const targets: Array<{ movement: any; sessionId: string; correctionOf: string | null }> = [];
            for (const movement of drawerMovements) {
              await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', movement.cashSessionId, ctx.organizationId);
              const original = await tx.cashSession.findFirst({ where: { id: movement.cashSessionId, organizationId: ctx.organizationId } });
              if (original?.status === 'open') {
                targets.push({ movement, sessionId: original.id, correctionOf: null });
                continue;
              }
              if (!payload.correctionSessionId) {
                throw new BadRequestException('This cash payment belongs to a closed shift. Choose your current open shift on the same register to post the correction.');
              }
              if (!ctx.permissions.includes('cash_session:correct')) throw new ForbiddenException('Correcting a closed shift requires cash_session:correct');
              await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', payload.correctionSessionId, ctx.organizationId);
              const current = await tx.cashSession.findFirst({ where: { id: payload.correctionSessionId, organizationId: ctx.organizationId } });
              if (!current || current.status !== 'open') throw new BadRequestException('The correction shift must be open');
              if (current.userId !== ctx.userId) throw new ForbiddenException('Post corrections only into your own open shift');
              if ((current.drawerAccountId ?? null) !== (original?.drawerAccountId ?? payment.accountId)) {
                throw new BadRequestException('The correction must be posted on the same register drawer that took the payment');
              }
              targets.push({ movement, sessionId: current.id, correctionOf: movement.cashSessionId });
            }
            for (const t of targets) {
              if (t.movement.movementType !== 'sale') continue; // voiding a refund puts cash back
              const moves = await tx.cashMovement.findMany({ where: { cashSessionId: t.sessionId } });
              const session = await tx.cashSession.findFirst({ where: { id: t.sessionId } });
              const expected = moves.reduce((sum: any, m: any) => ['sale', 'pay_in', 'adjustment'].includes(m.movementType) ? sum.plus(m.amount) : sum.minus(m.amount), session.openingFloat);
              if (expected.lt(t.movement.amount)) throw new BadRequestException('The drawer does not contain enough cash to return this payment');
            }

            let reversal: any = null;
            if (payment.journalEntryId) {
              reversal = await this.posting.reverse(payment.journalEntryId, { description: `Void of ${payment.paymentNumber}: ${reason}` }, tx);
            }
            // Financial evidence is append-only: keep the original sale/refund
            // and append the opposite drawer effect, linked to it.
            for (const t of targets) {
              await tx.cashMovement.create({ data: {
                organizationId: ctx.organizationId,
                cashSessionId: t.sessionId,
                movementType: 'adjustment',
                amount: t.movement.movementType === 'sale' ? t.movement.amount.negated() : t.movement.amount,
                reason: `Void of ${payment.paymentNumber}: ${reason}`,
                counterpartAccountId: t.movement.counterpartAccountId,
                journalEntryId: reversal?.id ?? null,
                reversalOfMovementId: t.movement.id,
                correctionOfSessionId: t.correctionOf,
                performedBy: ctx.userId,
              } });
            }
            // Snapshot the settlement before releasing it; the trigger refuses
            // an allocation delete without this evidence on the payment.
            await tx.payment.updateMany({
              where: { id: payment.id },
              data: {
                voidedAt: new Date(),
                voidedById: ctx.userId,
                voidReason: reason,
                voidedAllocations: JSON.parse(JSON.stringify(payment.allocations ?? [])),
              },
            });
            for (const alloc of payment.allocations ?? []) {
              // R2: allocation may target a POS Invoice (separate from Document).
              if (alloc.invoiceId) {
                const inv = await tx.invoice.findFirst({ where: { id: alloc.invoiceId } });
                if (inv) {
                  const newPaid = (inv.amountPaid as any).minus(alloc.amount);
                  const newResidual = (inv.amountResidual as any).plus(alloc.amount);
                  const paymentStatus = newResidual.lessThanOrEqualTo(0) ? 'paid' : (newResidual.lessThan(inv.totalAmount) ? 'partial' : 'not_paid');
                  const status = inv.status === 'paid' && newResidual.greaterThan(0) ? 'posted' : inv.status;
                  await tx.invoice.updateMany({ where: { id: inv.id }, data: { amountPaid: newPaid, amountResidual: newResidual, paymentStatus, status } });
                }
                await tx.paymentAllocation.deleteMany({ where: { id: alloc.id } });
                continue;
              }
              const doc = await tx.document.findFirst({ where: { id: alloc.documentId } });
              if (doc) {
                const newPaid = (doc.amountPaid as any).minus(alloc.amount);
                const newResidual = (doc.amountResidual as any).plus(alloc.amount);
                const paymentStatus = newResidual.lessThanOrEqualTo(0) ? 'paid' : (newResidual.lessThan(doc.totalAmount) ? 'partial' : 'not_paid');
                const status = doc.status === 'paid' && newResidual.greaterThan(0) ? 'posted' : doc.status;
                await tx.document.updateMany({
                  where: { id: doc.id },
                  data: { amountPaid: newPaid, amountResidual: newResidual, paymentStatus, status },
                });
              }
              await tx.paymentAllocation.deleteMany({ where: { id: alloc.id } });
            }
            await tx.payment.updateMany({
              where: { id: payment.id },
              data: { allocatedAmount: 0, unallocatedAmount: 0 },
            });
            await recordBusinessOutcome(tx, { id: payment.id, voided: true }, true);
          },
        },
      ],
    };
  }
}
