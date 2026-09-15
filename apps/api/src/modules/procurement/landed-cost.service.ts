import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dec, ZERO } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { StockPostingService } from '../inventory/posting/stock-posting.service';
import { CreateLandedCostDto } from './landed-cost.dto';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Decimal = Prisma.Decimal;
const SIX = 6;

/**
 * Landed cost (INV-P2-02): freight, duty, insurance and handling capitalised
 * onto the goods of one posted goods receipt.
 *
 * Posting allocates the charges over the receipt's stock movements (by value,
 * quantity or equally) and, per movement:
 *   - the share of the received units STILL ON HAND raises that stock's cost
 *     layer — the receipt's own lot (FIFO / batch), its serials (SPECIFIC), or
 *     the location running average (AVCO) — and is debited to Stock Valuation;
 *   - the share already consumed (sold, wasted, transferred on) can no longer be
 *     capitalised and is expensed to COGS.
 * STANDARD-cost items keep their standard: the whole share is expensed.
 * Credit: the account the user chose (freight accrual, AP clearing, bank…).
 *
 * The allocation rows are the audit trail; the inventory ledger stays
 * quantity-truthful (no zero-quantity value rows), and valuation reports read
 * current layer cost, so the subledger ↔ GL tie-out holds after posting.
 */
@Injectable()
export class LandedCostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly stockPosting: StockPostingService,
  ) {}

  private get org(): string {
    return this.tenant.organizationId;
  }

  list(goodsReceiptId?: string) {
    return this.prisma.client.landedCost.findMany({
      where: goodsReceiptId ? { goodsReceiptId } : {},
      orderBy: { createdAt: 'desc' },
      include: { charges: true, allocations: true },
      take: 200,
    });
  }

  async get(id: string) {
    const lc = await this.prisma.client.landedCost.findFirst({ where: { id }, include: { charges: true, allocations: true } });
    if (!lc) throw new NotFoundException('Landed cost not found');
    return lc;
  }

  async create(dto: CreateLandedCostDto) {
    const grn = await this.prisma.client.goodsReceiptNote.findFirst({ where: { id: dto.goodsReceiptId } });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (grn.status !== 'posted') throw new BadRequestException(`Landed cost can only be added to a posted goods receipt (${grn.receiptNumber} is ${grn.status})`);
    await this.assertCreditAccount(dto.creditAccountId);
    const total = dto.charges.reduce((s, c) => s.plus(dec(c.amount)), ZERO);
    if (total.lte(ZERO)) throw new BadRequestException('Landed cost charges must total more than zero');
    const code = await this.seq.next('landed_cost', { prefix: 'LC-', padding: 5 });
    const lc = await this.prisma.client.landedCost.create({
      data: {
        organizationId: this.org,
        code,
        goodsReceiptId: grn.id,
        allocationMethod: dto.allocationMethod ?? 'value',
        creditAccountId: dto.creditAccountId,
        date: dto.date ? new Date(dto.date) : new Date(),
        notes: dto.notes ?? null,
        totalAmount: total,
        createdBy: this.tenant.userId ?? null,
        charges: {
          create: dto.charges.map((c) => ({
            organizationId: this.org,
            kind: c.kind,
            description: c.description ?? null,
            amount: dec(c.amount),
          })),
        },
      },
    });
    return this.get(lc.id);
  }

  async cancel(id: string) {
    const upd = await this.prisma.client.landedCost.updateMany({
      where: { id, status: 'draft' },
      data: { status: 'cancelled', updatedBy: this.tenant.userId ?? null },
    });
    if (upd.count === 0) throw new BadRequestException('Only a draft landed cost can be cancelled');
    return this.get(id);
  }

  private async assertCreditAccount(accountId: string, tx?: any) {
    const db = tx ?? this.prisma.client;
    const acc = await db.account.findFirst({
      where: { id: accountId },
      select: { id: true, isActive: true, isPostable: true, deprecatedAt: true, code: true, name: true },
    });
    if (!acc) throw new BadRequestException('Credit account not found');
    if (!acc.isActive || !acc.isPostable || acc.deprecatedAt) {
      throw new BadRequestException(`Account ${acc.code} ${acc.name} cannot receive postings`);
    }
  }

  async post(id: string) {
    return this.prisma.client.$transaction(
      async (tx: any) => {
        const claim = await tx.landedCost.updateMany({
          where: { id, organizationId: this.org, status: 'draft' },
          data: { status: 'posted', postedAt: new Date(), postedById: this.tenant.userId ?? null },
        });
        if (claim.count === 0) throw new ConflictException('Landed cost is not a draft (already posted or cancelled)');
        const lc = await tx.landedCost.findFirst({ where: { id }, include: { charges: true } });
        await this.assertCreditAccount(lc.creditAccountId, tx);

        const grn = await tx.goodsReceiptNote.findFirst({ where: { id: lc.goodsReceiptId }, include: { lines: true } });
        if (!grn || grn.status !== 'posted' || grn.reversedAt) {
          throw new BadRequestException('The goods receipt is no longer posted; landed cost cannot be applied');
        }
        await this.assertPeriodOpen(tx, lc.date);

        // What the receipt actually put into stock, per (product, variant, location, lot).
        const rows = await tx.inventoryLedger.findMany({
          where: { organizationId: this.org, referenceType: 'goods_receipt', referenceId: grn.id, quantityChange: { gt: 0 } },
          include: { product: { select: { id: true, name: true, costingMethod: true, batchTracking: true, serialTracking: true } } },
          orderBy: { createdAt: 'asc' },
        });
        if (rows.length === 0) throw new BadRequestException(`${grn.receiptNumber} put no goods into stock; nothing to allocate to`);

        const groups = new Map<string, { product: any; variantId: string | null; locationId: string; batchId: string | null; qty: Decimal; value: Decimal }>();
        for (const r of rows) {
          const key = `${r.productId}:${r.variantId ?? ''}:${r.locationId}:${r.batchId ?? ''}`;
          const g = groups.get(key) ?? { product: r.product, variantId: r.variantId, locationId: r.locationId, batchId: r.batchId, qty: ZERO, value: ZERO };
          g.qty = g.qty.plus(dec(r.quantityChange));
          g.value = g.value.plus(dec(r.totalValue));
          groups.set(key, g);
        }
        const list = [...groups.values()];
        const basisOf = (g: (typeof list)[number]) =>
          lc.allocationMethod === 'quantity' ? g.qty : lc.allocationMethod === 'equal' ? dec(1) : g.value;
        const basisTotal = list.reduce((s, g) => s.plus(basisOf(g)), ZERO);
        if (basisTotal.lte(ZERO)) {
          throw new BadRequestException(`${grn.receiptNumber} has no ${lc.allocationMethod} to allocate by (zero-cost receipt?) — use quantity or equal allocation`);
        }

        const total = dec(lc.totalAmount);
        let allocatedSoFar = ZERO;
        let capitalizedTotal = ZERO;
        let expensedTotal = ZERO;
        const glLines: Array<{ productId: string; capitalized: Decimal; expensed: Decimal }> = [];

        for (let i = 0; i < list.length; i++) {
          const g = list[i];
          // Largest-remainder free: the last group absorbs rounding so Σ = total exactly.
          const allocated =
            i === list.length - 1 ? total.minus(allocatedSoFar) : total.times(basisOf(g)).dividedBy(basisTotal).toDecimalPlaces(SIX);
          allocatedSoFar = allocatedSoFar.plus(allocated);

          const applied = await this.applyToLayer(tx, grn.id, g, allocated);
          capitalizedTotal = capitalizedTotal.plus(applied.capitalized);
          expensedTotal = expensedTotal.plus(allocated.minus(applied.capitalized));
          glLines.push({ productId: g.product.id, capitalized: applied.capitalized, expensed: allocated.minus(applied.capitalized) });

          const batchNumber = g.batchId
            ? (await tx.inventoryBatch.findFirst({ where: { id: g.batchId }, select: { batchNumber: true } }))?.batchNumber
            : null;
          const grnLine =
            grn.lines.find((l: any) => l.productId === g.product.id && batchNumber && l.batchNumber === batchNumber) ??
            grn.lines.find((l: any) => l.productId === g.product.id);
          await tx.landedCostAllocation.create({
            data: {
              organizationId: this.org,
              landedCostId: lc.id,
              goodsReceiptLineId: grnLine?.id ?? '',
              productId: g.product.id,
              locationId: g.locationId,
              batchId: g.batchId,
              receivedQty: g.qty,
              onHandQty: applied.onHand,
              basisValue: basisOf(g),
              allocatedAmount: allocated,
              capitalizedAmount: applied.capitalized,
              expensedAmount: allocated.minus(applied.capitalized),
              unitCostBefore: applied.unitBefore,
              unitCostAfter: applied.unitAfter,
            },
          });
        }

        const je = await this.stockPosting.postLandedCost({
          lines: glLines,
          creditAccountId: lc.creditAccountId,
          date: lc.date,
          sourceType: 'landed_cost',
          sourceId: lc.code,
          description: `Landed cost ${lc.code} · GRN ${grn.receiptNumber}`,
          tx,
        });

        await tx.landedCost.update({
          where: { id: lc.id },
          data: { capitalizedAmount: capitalizedTotal, expensedAmount: expensedTotal, journalEntryId: je?.id ?? null },
        });
        await this.audit.recordInTx(tx, {
          entity: 'LandedCost',
          entityId: lc.id,
          action: 'update',
          newValues: { kind: 'landed_cost_posted', code: lc.code, goodsReceiptId: grn.id, total: total.toString(), capitalized: capitalizedTotal.toString(), expensed: expensedTotal.toString() },
        });
        return tx.landedCost.findFirst({ where: { id: lc.id }, include: { charges: true, allocations: true } });
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Raise the cost of whatever part of one receipt movement is still on hand.
   * Returns the capitalised amount (the rest is expensed by the caller).
   */
  private async applyToLayer(
    tx: any,
    grnId: string,
    g: { product: any; variantId: string | null; locationId: string; batchId: string | null; qty: Decimal },
    allocated: Decimal,
  ): Promise<{ capitalized: Decimal; onHand: Decimal; unitBefore: Decimal; unitAfter: Decimal }> {
    const none = { capitalized: ZERO, onHand: ZERO, unitBefore: ZERO, unitAfter: ZERO };
    if (allocated.lte(ZERO) || g.qty.lte(ZERO)) return none;
    const variantKey = g.variantId ?? '';

    if (g.product.serialTracking) {
      const serials: Array<{ id: string; unitCost: any }> = await tx.$queryRawUnsafe(
        `SELECT id, "unitCost" FROM "InventorySerial"
          WHERE "organizationId" = $1 AND "productId" = $2 AND "receiptRef" = $3 AND status = 'in_stock'
          FOR UPDATE`,
        this.org,
        g.product.id,
        `goods_receipt:${grnId}`,
      );
      const perUnit = allocated.dividedBy(g.qty);
      const onHand = Prisma.Decimal.min(dec(serials.length), g.qty);
      const first = serials[0] ? dec(serials[0].unitCost ?? 0) : ZERO;
      for (const s of serials.slice(0, onHand.toNumber())) {
        await tx.inventorySerial.update({ where: { id: s.id }, data: { unitCost: dec(s.unitCost ?? 0).plus(perUnit) } });
      }
      return { capitalized: perUnit.times(onHand).toDecimalPlaces(SIX), onHand, unitBefore: first, unitAfter: first.plus(perUnit) };
    }

    if (g.batchId) {
      const [batch] = await tx.$queryRawUnsafe(
        `SELECT id, quantity, "unitCost" FROM "InventoryBatch" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        g.batchId,
        this.org,
      );
      if (!batch) return none;
      const onHand = Prisma.Decimal.max(ZERO, Prisma.Decimal.min(dec(batch.quantity), g.qty));
      if (onHand.lte(ZERO)) return { ...none, unitBefore: dec(batch.unitCost ?? 0), unitAfter: dec(batch.unitCost ?? 0) };
      const capitalized = allocated.times(onHand).dividedBy(g.qty).toDecimalPlaces(SIX);
      const before = dec(batch.unitCost ?? 0);
      // Spread over the lot's remaining units (= onHand; a lot never exceeds its receipt).
      const after = before.plus(capitalized.dividedBy(dec(batch.quantity)));
      // Batch-tracked items issue at lot cost (the stock engine's layer path), so
      // the lot is the only cost carrier to raise.
      await tx.inventoryBatch.update({ where: { id: batch.id }, data: { unitCost: after } });
      return { capitalized, onHand, unitBefore: before, unitAfter: after };
    }

    if (g.product.costingMethod === 'STANDARD') {
      return none; // standard cost is not rebased by a single receipt's freight
    }

    // AVCO quant: the same advisory lock the stock engine takes for its average.
    return this.bumpAverage(tx, g, variantKey, allocated);
  }

  private async bumpAverage(
    tx: any,
    g: { product: any; locationId: string; qty: Decimal },
    variantKey: string,
    amount: Decimal,
  ): Promise<{ capitalized: Decimal; onHand: Decimal; unitBefore: Decimal; unitAfter: Decimal }> {
    const lockKey = `avco:${this.org}:${g.product.id}:${variantKey}:${g.locationId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    const [item] = await tx.$queryRawUnsafe(
      `SELECT id, quantity, "runningAverageCost" FROM "StockItem"
        WHERE "organizationId" = $1 AND "productId" = $2 AND "variantKey" = $3 AND "locationId" = $4 FOR UPDATE`,
      this.org,
      g.product.id,
      variantKey,
      g.locationId,
    );
    const zero = { capitalized: ZERO, onHand: ZERO, unitBefore: ZERO, unitAfter: ZERO };
    if (!item) return zero;
    const qty = dec(item.quantity);
    const before = dec(item.runningAverageCost);
    if (qty.lte(ZERO)) return { ...zero, unitBefore: before, unitAfter: before };
    // Units of this receipt assumed still on hand: at most what is on hand now.
    const onHand = Prisma.Decimal.min(qty, g.qty);
    const capitalized = amount.times(onHand).dividedBy(g.qty).toDecimalPlaces(SIX);
    const after = before.plus(capitalized.dividedBy(qty));
    await tx.stockItem.update({ where: { id: item.id }, data: { runningAverageCost: after } });
    return { capitalized, onHand, unitBefore: before, unitAfter: after };
  }

  private async assertPeriodOpen(tx: any, date: Date) {
    const org = await tx.organization.findUnique({ where: { id: this.org }, select: { booksLockDate: true } });
    if (org?.booksLockDate && date.getTime() <= new Date(org.booksLockDate).getTime()) {
      throw new BadRequestException(`Books are locked through ${new Date(org.booksLockDate).toISOString().slice(0, 10)}`);
    }
  }
}
