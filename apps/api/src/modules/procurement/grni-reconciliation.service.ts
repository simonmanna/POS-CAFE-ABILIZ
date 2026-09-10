import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AccountDeterminationService } from '../accounting/posting/account-determination.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZERO = new Prisma.Decimal(0);

export interface GrniOpenPosition {
  goodsReceiptLineId: string;
  receiptNumber: string;
  receivedAt: Date;
  ageDays: number;
  partnerId: string | null;
  partnerName: string | null;
  purchaseOrderId: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string;
  receivedQuantity: string;
  billedQuantity: string;
  openQuantity: string;
  unitCost: string;
  openValue: string;
  /** True when the PO receipt already vouchered AP — no bill is owed for it. */
  vouchered: boolean;
}

/**
 * GRNI reconciliation: what is sitting in "goods received, not invoiced" and
 * why.
 *
 * GRNI (2150) is the accrual raised when stock lands and cleared when the
 * supplier's bill posts. Nothing reported on it before, so a stale accrual — a
 * delivery nobody ever billed, or a bill posted at a price the receipt did not
 * expect — was invisible until someone read the trial balance and could not
 * explain the number.
 *
 * The subledger side is derived from open receipt quantity
 * (`GoodsReceiptLine.quantity - billedQuantity`), which is the same cursor
 * vendor-bill posting consumes, so the report and the posting path can never
 * disagree about what is still open.
 */
@Injectable()
export class GrniReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly determination: AccountDeterminationService,
  ) {}

  async report(query: { partnerId?: string; asOf?: string; minAgeDays?: number } = {}) {
    const orgId = this.tenant.organizationId;
    const asOf = query.asOf ? new Date(query.asOf) : new Date();
    const minAgeDays = Number(query.minAgeDays ?? 0);

    const lines = await this.prisma.client.goodsReceiptLine.findMany({
      where: {
        receipt: {
          status: 'posted',
          receivedAt: { lte: asOf },
          ...(query.partnerId ? { partnerId: query.partnerId } : {}),
        },
      },
      include: {
        receipt: {
          select: {
            receiptNumber: true,
            receivedAt: true,
            partnerId: true,
            purchaseOrderId: true,
          },
        },
      },
      orderBy: [{ receipt: { receivedAt: 'asc' } }, { lineNumber: 'asc' }],
    });

    const partnerIds = [...new Set(lines.map((l: any) => l.receipt?.partnerId).filter(Boolean))] as string[];
    const productIds = [...new Set(lines.map((l: any) => l.productId).filter(Boolean))] as string[];
    const [partners, products] = await Promise.all([
      partnerIds.length
        ? this.prisma.client.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      productIds.length
        ? this.prisma.client.product.findMany({ where: { id: { in: productIds } }, select: { id: true, code: true, name: true } })
        : Promise.resolve([]),
    ]);
    const partnerById = new Map(partners.map((p: any) => [p.id, p]));
    const productById = new Map(products.map((p: any) => [p.id, p]));

    const positions: GrniOpenPosition[] = [];
    let openValue = ZERO;
    let voucheredValue = ZERO;
    for (const line of lines as any[]) {
      const received = new Prisma.Decimal(line.quantity);
      const billed = new Prisma.Decimal(line.billedQuantity ?? 0);
      const open = received.minus(billed);
      if (open.lte(ZERO)) continue;

      const ageDays = Math.floor((asOf.getTime() - new Date(line.receipt.receivedAt).getTime()) / 86_400_000);
      if (ageDays < minAgeDays) continue;

      const unitCost = new Prisma.Decimal(line.unitCost ?? 0);
      const value = unitCost.times(open);
      const vouchered = Boolean(line.receipt.purchaseOrderId);
      // A PO-driven receipt vouchered AP in the same transaction, so its GRNI
      // leg is already closed in the GL even though the quantity is still open
      // for matching. Keeping the two figures apart is the whole point of the
      // report: only the un-vouchered share should tie to the 2150 balance.
      if (vouchered) voucheredValue = voucheredValue.plus(value);
      else openValue = openValue.plus(value);

      const product = line.productId ? productById.get(line.productId) : null;
      positions.push({
        goodsReceiptLineId: line.id,
        receiptNumber: line.receipt.receiptNumber,
        receivedAt: line.receipt.receivedAt,
        ageDays,
        partnerId: line.receipt.partnerId ?? null,
        partnerName: line.receipt.partnerId ? (partnerById.get(line.receipt.partnerId)?.name ?? null) : null,
        purchaseOrderId: line.receipt.purchaseOrderId ?? null,
        productId: line.productId ?? null,
        productCode: product?.code ?? null,
        productName: product?.name ?? line.description,
        receivedQuantity: received.toString(),
        billedQuantity: billed.toString(),
        openQuantity: open.toString(),
        unitCost: unitCost.toString(),
        openValue: value.toString(),
        vouchered,
      });
    }

    const glBalance = await this.grniGlBalance(orgId, asOf);
    const difference = glBalance.minus(openValue);

    return {
      asOf,
      /** Un-vouchered open receipts — what the 2150 credit balance should be. */
      subledgerOpenValue: openValue.toString(),
      /** Open receipt value whose AP was already raised by the receipt voucher. */
      voucheredOpenValue: voucheredValue.toString(),
      glBalance: glBalance.toString(),
      /**
       * GL minus subledger. Anything non-zero is a real reconciling item:
       * historically, price differences between the receipt cost and the bill
       * price that had nowhere to go before purchase price variance existed.
       */
      difference: difference.toString(),
      reconciled: difference.abs().lte(new Prisma.Decimal('0.01')),
      ageBuckets: this.bucket(positions),
      positions,
    };
  }

  /** GRNI is a liability: a credit balance is what we owe. Returned positive. */
  private async grniGlBalance(organizationId: string, asOf: Date): Promise<Prisma.Decimal> {
    let accountId: string;
    try {
      accountId = await this.determination.mapped('grni_accrued');
    } catch {
      return ZERO;
    }
    const agg = await this.prisma.client.journalLine.aggregate({
      where: {
        organizationId,
        accountId,
        entry: { status: { in: ['posted', 'reversed'] }, postingDate: { lte: asOf } },
      },
      _sum: { debit: true, credit: true },
    });
    const debit = new Prisma.Decimal(agg._sum?.debit ?? 0);
    const credit = new Prisma.Decimal(agg._sum?.credit ?? 0);
    return credit.minus(debit);
  }

  private bucket(positions: GrniOpenPosition[]) {
    const buckets = [
      { label: '0-30', min: 0, max: 30, value: ZERO, count: 0 },
      { label: '31-60', min: 31, max: 60, value: ZERO, count: 0 },
      { label: '61-90', min: 61, max: 90, value: ZERO, count: 0 },
      { label: '90+', min: 91, max: Number.MAX_SAFE_INTEGER, value: ZERO, count: 0 },
    ];
    for (const p of positions) {
      if (p.vouchered) continue;
      const b = buckets.find((x) => p.ageDays >= x.min && p.ageDays <= x.max);
      if (!b) continue;
      b.value = b.value.plus(p.openValue);
      b.count += 1;
    }
    return buckets.map((b) => ({ label: b.label, value: b.value.toString(), count: b.count }));
  }
}
