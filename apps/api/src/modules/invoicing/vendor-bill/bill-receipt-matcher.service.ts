import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZERO = new Prisma.Decimal(0);

/**
 * What a single bill line matched against open goods receipts.
 *
 * Quantities are all in the same unit as the bill line and the receipt line —
 * the product's purchase UoM. Conversion to base units is the stock engine's
 * job, not the matcher's.
 */
export interface BillLineMatch {
  /**
   * Quantity already received AND already vouchered to AP by the receipt
   * itself. Only the PO-driven receive path does this: it posts
   * `postReceiptVoucher` (Dr GRNI + Dr Input Tax / Cr AP) in the same
   * transaction as the stock-in, so the supplier is already owed for these
   * goods. The bill is a confirming document — it must post no GL and receive
   * no stock, or AP doubles.
   */
  voucheredQuantity: Prisma.Decimal;
  /**
   * Quantity already received but left sitting in GRNI (ad-hoc goods receipt,
   * no PO). This is the accrual the bill exists to clear: post
   * Dr GRNI / Cr AP, but do NOT receive the goods again.
   */
  accruedQuantity: Prisma.Decimal;
  /**
   * Quantity the bill is claiming that no posted receipt covers — the
   * bill-before-goods case. This is the only portion that may move stock.
   */
  unmatchedQuantity: Prisma.Decimal;
  /** Receipt lines whose open quantity was consumed, oldest receipt first. */
  consumptions: {
    goodsReceiptLineId: string;
    purchaseOrderLineId: string | null;
    quantity: Prisma.Decimal;
    vouchered: boolean;
    /** What the receipt capitalised these units at, per purchase unit. */
    receiptUnitCost: Prisma.Decimal;
  }[];
  /**
   * Value the receipt credited to GRNI for the `accruedQuantity` share, at the
   * cost the goods were actually received at. The bill debits GRNI at the
   * invoice price; the gap between the two is purchase price variance, and
   * without it the difference silently rots in the accrual forever.
   */
  accruedReceiptValue: Prisma.Decimal;
  /** Location the matched goods physically landed in, if the receipts agree. */
  locationId: string | null;
}

/**
 * Matches vendor-bill lines against open (received-but-unbilled) goods
 * receipts.
 *
 * Before this existed, posting a vendor bill called
 * `StockService.receiveFromBill` for every stockable line unconditionally. The
 * bill had no link to the GoodsReceiptNote that had already brought the
 * delivery in, so the ordinary AP workflow
 *
 *     PO -> goods receipt -> supplier invoice arrives -> post bill
 *
 * booked one physical delivery into stock twice, doubled the moving average's
 * basis, doubled AP and left GRNI permanently dirty. Nothing errored.
 *
 * The cursor is `GoodsReceiptLine.billedQuantity`: each posted bill consumes
 * open receipt quantity oldest-first and stamps what it took, so a second bill
 * for the same delivery finds nothing left to match and a partial bill matches
 * only its share.
 */
@Injectable()
export class BillReceiptMatcherService {
  /**
   * Read-only: how a bill line splits across already-received and not-yet-received
   * quantity. Call {@link consume} to actually take the matched quantity.
   */
  async matchLine(
    tx: any,
    input: {
      organizationId: string;
      partnerId: string | null;
      productId: string;
      quantity: Prisma.Decimal | number;
    },
  ): Promise<BillLineMatch> {
    const wanted = new Prisma.Decimal(input.quantity ?? 0);
    const empty: BillLineMatch = {
      voucheredQuantity: ZERO,
      accruedQuantity: ZERO,
      unmatchedQuantity: wanted,
      consumptions: [],
      accruedReceiptValue: ZERO,
      locationId: null,
    };
    if (wanted.lte(ZERO) || !input.partnerId) return empty;

    // Open receipt lines for this supplier + product, oldest delivery first.
    // A GRN only counts once posted — a draft receipt has moved no stock.
    const lines = await tx.goodsReceiptLine.findMany({
      where: {
        organizationId: input.organizationId,
        productId: input.productId,
        receipt: {
          organizationId: input.organizationId,
          status: 'posted',
          partnerId: input.partnerId,
        },
      },
      include: { receipt: { select: { purchaseOrderId: true, warehouseId: true, receivedAt: true } } },
      orderBy: [{ receipt: { receivedAt: 'asc' } }, { lineNumber: 'asc' }],
    });

    let remaining = wanted;
    let vouchered = ZERO;
    let accrued = ZERO;
    let accruedReceiptValue = ZERO;
    const consumptions: BillLineMatch['consumptions'] = [];
    let locationId: string | null = null;

    for (const line of lines) {
      if (remaining.lte(ZERO)) break;
      const open = new Prisma.Decimal(line.quantity).minus(new Prisma.Decimal(line.billedQuantity ?? 0));
      if (open.lte(ZERO)) continue;
      const take = Prisma.Decimal.min(open, remaining);
      // A PO-linked receipt already ran postReceiptVoucher: AP is raised and
      // GRNI is back at zero for these goods. An ad-hoc receipt deliberately
      // left the accrual open for this bill to clear.
      const isVouchered = Boolean(line.receipt?.purchaseOrderId);
      const receiptUnitCost = new Prisma.Decimal(line.unitCost ?? 0);
      consumptions.push({
        goodsReceiptLineId: line.id,
        purchaseOrderLineId: line.purchaseOrderLineId ?? null,
        quantity: take,
        vouchered: isVouchered,
        receiptUnitCost,
      });
      if (isVouchered) {
        vouchered = vouchered.plus(take);
      } else {
        accrued = accrued.plus(take);
        accruedReceiptValue = accruedReceiptValue.plus(receiptUnitCost.times(take));
      }
      if (!locationId && line.receipt?.warehouseId) locationId = line.receipt.warehouseId;
      remaining = remaining.minus(take);
    }

    return {
      voucheredQuantity: vouchered,
      accruedQuantity: accrued,
      unmatchedQuantity: remaining.lte(ZERO) ? ZERO : remaining,
      consumptions,
      accruedReceiptValue,
      locationId,
    };
  }

  /**
   * Stamp the consumed quantity onto the receipt lines and record the claim so
   * a later cancel can give it back. Must run inside the bill's transaction.
   */
  async consume(
    tx: any,
    ctx: { organizationId: string; vendorBillId: string; documentLineId: string },
    match: BillLineMatch,
  ): Promise<void> {
    for (const c of match.consumptions) {
      await tx.goodsReceiptLine.update({
        where: { id: c.goodsReceiptLineId },
        data: { billedQuantity: { increment: c.quantity } },
      });
      // Keep PurchaseOrderLine.billedQuantity honest too — it is what makes a
      // PO's billed-vs-received position readable without re-deriving it.
      if (c.purchaseOrderLineId) {
        await tx.purchaseOrderLine.update({
          where: { id: c.purchaseOrderLineId },
          data: { billedQuantity: { increment: c.quantity } },
        });
      }
      await tx.vendorBillReceiptMatch.create({
        data: {
          organizationId: ctx.organizationId,
          vendorBillId: ctx.vendorBillId,
          documentLineId: ctx.documentLineId,
          goodsReceiptLineId: c.goodsReceiptLineId,
          quantity: c.quantity,
          vouchered: c.vouchered,
        },
      });
    }
  }

  /**
   * Give back everything a posted bill claimed — used when the bill is
   * cancelled, so the delivery is open for the corrected bill to match against
   * instead of being received a second time.
   */
  async releaseForBill(tx: any, organizationId: string, vendorBillId: string): Promise<void> {
    const claims = await tx.vendorBillReceiptMatch.findMany({
      where: { organizationId, vendorBillId },
      include: { receiptLine: { select: { purchaseOrderLineId: true } } },
    });
    for (const c of claims) {
      await tx.goodsReceiptLine.update({
        where: { id: c.goodsReceiptLineId },
        data: { billedQuantity: { decrement: c.quantity } },
      });
      if (c.receiptLine?.purchaseOrderLineId) {
        await tx.purchaseOrderLine.update({
          where: { id: c.receiptLine.purchaseOrderLineId },
          data: { billedQuantity: { decrement: c.quantity } },
        });
      }
    }
    await tx.vendorBillReceiptMatch.deleteMany({ where: { organizationId, vendorBillId } });
  }
}
