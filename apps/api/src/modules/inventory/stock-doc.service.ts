import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { dec, ZERO } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { ApprovalsService } from '../../kernel/approvals/approvals.service';
import { StockService, type InternalIssueInput } from './stock.service';
import { StockPostingService } from './posting/stock-posting.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { assertActiveStaff } from './staff-attribution';
import {
  CreateStockOutDto,
  CreateWasteDto,
  CreateStockAdjustmentDto,
  CreateStockTransferDto,
  ReceiveStockTransferDto,
  WasteQueryDto,
} from './dto/stock-doc.dto';

/** Quantities within this of each other are equal (Decimal(20,6) columns). */
const QTY_EPSILON = dec('0.000001');

/**
 * F.8 — Document wrappers around the stock engine. Each header carries lines and
 * a {@link StockDocStatus}. Posting to the ledger happens once, on approve, by
 * delegating to {@link StockService} inside a single $transaction (idempotent via
 * `postedAt`). The engine remains the single source of truth for quants, batches,
 * AVCO and GL — these wrappers only add an auditable, approvable paper trail.
 */
@Injectable()
export class StockDocService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly stock: StockService,
    private readonly approvals: ApprovalsService,
    private readonly stockPosting: StockPostingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Gate a stock document behind the approval engine. Returns when it is safe to
   * post (no policy, or an approved request exists); throws when a pending
   * request must be decided first. Backward-compatible: with no ApprovalPolicy
   * for `entityType`, checkOrRequestApproval returns null and posting proceeds.
   */
  private async gateApproval(
    entityType: string,
    entityId: string,
    snapshot: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    const gate = await this.approvals.checkOrRequestApproval({ entityType, entityId, snapshot });
    if (gate?.needsApproval) {
      throw new BadRequestException(
        `Approval required before posting ${label}. Pending approval request ${gate.requestId}.`,
      );
    }
  }

  private get org(): string {
    return this.tenant.organizationId;
  }

  /** Snapshot product names for the given ids → { id: name }. */
  private async productNames(ids: string[]): Promise<Record<string, string>> {
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return Object.fromEntries(products.map((p) => [p.id, p.name]));
  }

  private async location(id: string) {
    const loc = await this.prisma.client.inventoryLocation.findFirst({ where: { id } });
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  // ===========================================================================
  // StockOut — internal use / testing / sample / comp (posts ISSUE)
  // ===========================================================================

  async createStockOut(dto: CreateStockOutDto) {
    await this.location(dto.locationId);
    await assertActiveStaff(this.prisma.client, this.org, { responsibleById: dto.responsibleById, approvedById: dto.approvedById });
    const names = await this.productNames(dto.items.map((i) => i.productId));
    const outCode = await this.seq.next('stock_out', { prefix: 'SO-', padding: 5 });
    return this.prisma.client.stockOut.create({
      data: {
        organizationId: this.org,
        outCode,
        locationId: dto.locationId,
        category: dto.category ?? 'general_use',
        status: 'pending',
        reason: dto.reason ?? null,
        notes: dto.notes ?? null,
        performedById: this.tenant.userId ?? null,
        responsibleById: dto.responsibleById,
        approvedById: dto.approvedById,
        createdBy: this.tenant.userId ?? null,
        items: {
          create: dto.items.map((i) => ({
            organizationId: this.org,
            productId: i.productId,
            variantId: i.variantId ?? null,
            productName: names[i.productId] ?? 'Unknown',
            unit: i.unit ?? null,
            qty: dec(i.qty),
            batchNumber: i.batchNumber ?? null,
            distStrategy: i.distStrategy ?? 'FEFO',
          })),
        },
      },
      include: { items: true },
    });
  }

  async approveStockOut(id: string) {
    const doc = await this.prisma.client.stockOut.findFirst({ where: { id }, include: { items: true } });
    if (!doc) throw new NotFoundException('Stock-out not found');
    this.assertPostable(doc.status, doc.postedAt);
    await this.gateApproval(
      'stock_out',
      doc.id,
      { amount: Number(doc.totalValue ?? 0), lines: doc.items.length, category: doc.category },
      'stock-out',
    );

    return this.prisma.client.$transaction(async (tx: any) => {
      // Claim inside the tx (same pattern as approveWaste): two concurrent
      // approvals must not both issue the stock and double-post the GL.
      const claim = await tx.stockOut.updateMany({
        where: { id: doc.id, postedAt: null, status: { in: ['pending', 'draft'] } },
        data: { status: 'approved' },
      });
      if (claim.count === 0) throw new BadRequestException('Stock-out was posted or cancelled concurrently');

      let total = ZERO;
      for (const item of doc.items) {
        // Map StockOutCategory to StockMoveType for correct GL posting.
        // sample/comp → promo_sample; internal_use/testing/training → internal_use;
        // damaged/waste → waste; expired → expiry_write_off; general_use/other → issue
        const catToMove: Record<string, string> = {
          sample: 'promo_sample',
          complimentary: 'promo_sample',
          kitchen_testing: 'internal_use',
          training: 'internal_use',
          damaged: 'waste',
          expired: 'expiry_write_off',
        };
        const mt = (catToMove[doc.category] ?? 'issue') as any;
        const res = await this.stock.issue(
          {
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            locationId: doc.locationId,
            quantity: Number(item.qty),
            moveType: mt,
            distStrategy: (item.distStrategy as any) ?? 'FEFO',
            batchNumber: item.batchNumber ?? undefined,
            sourceType: 'stock_out',
            sourceId: doc.outCode,
            notes: doc.reason ?? undefined,
            responsibleById: doc.responsibleById ?? undefined,
            approvedById: this.tenant.userId ?? doc.approvedById ?? undefined,
          },
          tx,
        );
        const lineTotal = dec(res.totalValue);
        total = total.plus(lineTotal);
        await tx.stockOutItem.update({
          where: { id: item.id },
          data: { unitCost: dec(res.unitCost), totalCost: lineTotal },
        });
      }
      return tx.stockOut.update({
        where: { id: doc.id },
        data: {
          status: 'completed',
          approvedById: this.tenant.userId ?? null,
          approvedAt: new Date(),
          postedAt: new Date(),
          totalValue: total,
        },
        include: { items: true },
      });
    });
  }

  // ===========================================================================
  // WasteRecord — spoilage / expiry / breakage (posts WASTE / EXPIRY_WRITE_OFF)
  // ===========================================================================

  async createWaste(dto: CreateWasteDto) {
    await this.location(dto.locationId);
    await assertActiveStaff(this.prisma.client, this.org, { responsibleById: dto.responsibleById, approvedById: dto.approvedById });
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: [...new Set(dto.items.map((i) => i.productId))] } },
      select: { id: true, name: true, costPrice: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = dto.items.find((i) => !byId.has(i.productId));
    if (missing) throw new NotFoundException(`Product ${missing.productId} not found`);

    // Estimated value at the current running average (product cost as fallback).
    // Posting re-values each line from the real cost layers; the estimate exists so
    // pending records show a value and amount-banded approval policies can fire —
    // a zero totalValue made every `minAmount` waste policy silently inert.
    const stockItems = await this.prisma.client.stockItem.findMany({
      where: { locationId: dto.locationId, productId: { in: products.map((p) => p.id) } },
      select: { productId: true, variantKey: true, runningAverageCost: true },
    });
    const avg = new Map(stockItems.map((s) => [`${s.productId}:${s.variantKey}`, dec(s.runningAverageCost)]));

    let total = ZERO;
    const lines = dto.items.map((i) => {
      const product = byId.get(i.productId)!;
      const qty = dec(i.qty);
      const avgCost = avg.get(`${i.productId}:${i.variantId ?? ''}`);
      const unitCost = avgCost && avgCost.gt(ZERO) ? avgCost : dec(product.costPrice ?? ZERO);
      const totalCost = unitCost.times(qty);
      total = total.plus(totalCost);
      return {
        organizationId: this.org,
        productId: i.productId,
        variantId: i.variantId ?? null,
        productName: product.name,
        unit: i.unit ?? null,
        qty,
        unitCost,
        totalCost,
        batchNumber: i.batchNumber?.trim() || null,
        isExpiry: i.isExpiry ?? false,
      };
    });

    const wasteCode = await this.seq.next('waste_doc', { prefix: 'WST-', padding: 5 });
    return this.prisma.client.wasteRecord.create({
      data: {
        organizationId: this.org,
        wasteCode,
        locationId: dto.locationId,
        category: dto.category ?? 'other',
        status: 'pending',
        notes: dto.notes ?? null,
        reportedById: this.tenant.userId ?? null,
        responsibleById: dto.responsibleById,
        approvedById: dto.approvedById,
        createdBy: this.tenant.userId ?? null,
        totalValue: total,
        items: { create: lines },
      },
      include: { items: true, location: true },
    });
  }

  async approveWaste(id: string) {
    const doc = await this.prisma.client.wasteRecord.findFirst({ where: { id }, include: { items: true } });
    if (!doc) throw new NotFoundException('Waste record not found');
    this.assertPostable(doc.status, doc.postedAt);
    await this.gateApproval(
      'waste',
      doc.id,
      { amount: Number(doc.totalValue ?? 0), lines: doc.items.length, category: doc.category },
      `waste ${doc.wasteCode}`,
    );

    return this.prisma.client.$transaction(async (tx: any) => {
      // Claim the document inside the tx so two concurrent approvals cannot both
      // issue the stock and double-post the GL. Rolled back with everything else
      // if any line fails.
      const claim = await tx.wasteRecord.updateMany({
        where: { id: doc.id, postedAt: null, status: { in: ['pending', 'draft'] } },
        data: { status: 'approved' },
      });
      if (claim.count === 0) throw new BadRequestException('Waste record was posted or cancelled concurrently');

      let total = ZERO;
      for (const item of doc.items) {
        const res = await this.stock.issue(
          {
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            locationId: doc.locationId,
            quantity: Number(item.qty),
            moveType: item.isExpiry ? 'expiry_write_off' : 'waste',
            distStrategy: item.batchNumber ? 'MANUAL' : 'FEFO',
            batchNumber: item.batchNumber ?? undefined,
            sourceType: 'waste',
            sourceId: doc.wasteCode,
            notes: doc.notes ?? undefined,
            responsibleById: doc.responsibleById ?? undefined,
            approvedById: this.tenant.userId ?? doc.approvedById ?? undefined,
          },
          tx,
        );
        const lineTotal = dec(res.totalValue);
        total = total.plus(lineTotal);
        await tx.wasteItem.update({
          where: { id: item.id },
          data: { unitCost: dec(res.unitCost), totalCost: lineTotal },
        });
      }
      return tx.wasteRecord.update({
        where: { id: doc.id },
        data: {
          status: 'completed',
          approvedById: this.tenant.userId ?? null,
          approvedAt: new Date(),
          postedAt: new Date(),
          totalValue: total,
        },
        include: { items: true, location: true },
      });
    });
  }

  /** Discard a not-yet-posted waste record. Posted records are immutable (reverse via stock-in). */
  async cancelWaste(id: string) {
    const doc = await this.prisma.client.wasteRecord.findFirst({ where: { id } });
    if (!doc) throw new NotFoundException('Waste record not found');
    this.assertPostable(doc.status, doc.postedAt);
    const upd = await this.prisma.client.wasteRecord.updateMany({
      where: { id, postedAt: null, status: { in: ['pending', 'draft'] } },
      data: { status: 'cancelled', updatedBy: this.tenant.userId ?? null },
    });
    if (upd.count === 0) throw new BadRequestException('Waste record was posted or cancelled concurrently');
    return this.prisma.client.wasteRecord.findFirst({ where: { id }, include: { items: true, location: true } });
  }

  private wasteWhere(q: WasteQueryDto, dateField: 'createdAt' | 'postedAt') {
    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.category) where.category = q.category;
    if (q.locationId) where.locationId = q.locationId;
    if (q.from || q.to) {
      where[dateField] = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        // A bare date "to" is inclusive of that whole day.
        ...(q.to ? { lt: q.to.length <= 10 ? new Date(new Date(q.to).getTime() + 86_400_000) : new Date(q.to) } : {}),
      };
    }
    return where;
  }

  listWaste(q: WasteQueryDto) {
    return this.prisma.client.wasteRecord.findMany({
      where: this.wasteWhere(q, 'createdAt'),
      orderBy: { createdAt: 'desc' },
      include: { items: true, location: { select: { id: true, code: true, name: true } } },
      take: 500,
    });
  }

  /** One record with its stock-ledger rows and the GL journal entries it posted. */
  async getWaste(id: string) {
    const doc = await this.prisma.client.wasteRecord.findFirst({
      where: { id },
      include: { items: true, location: { select: { id: true, code: true, name: true } } },
    });
    if (!doc) throw new NotFoundException('Waste record not found');
    const [journalEntries, ledger] = doc.postedAt
      ? await Promise.all([
          this.prisma.client.journalEntry.findMany({
            where: { sourceType: { in: ['waste', 'waste_reversal'] }, sourceId: doc.wasteCode },
            select: {
              id: true, entryNumber: true, postingDate: true, status: true, description: true,
              lines: { select: { debit: true, credit: true, account: { select: { code: true, name: true } } } },
            },
            orderBy: { entryNumber: 'asc' },
          }),
          this.prisma.client.inventoryLedger.findMany({
            where: { referenceType: { in: ['waste', 'waste_reversal'] }, referenceId: doc.wasteCode },
            select: { id: true, ledgerCode: true, productId: true, type: true, quantityChange: true, balanceAfter: true, unitCost: true, totalValue: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
        ])
      : [[], []];
    return { ...doc, journalEntries, ledger };
  }

  /**
   * Posted (completed) damages & waste within the period, valued at the actual
   * posted cost, plus what is still pending. Filtered on postedAt.
   */
  async wasteSummary(q: WasteQueryDto) {
    const { status: _ignored, ...rest } = q;
    const posted = await this.prisma.client.wasteRecord.findMany({
      where: { ...this.wasteWhere(rest, 'postedAt'), status: 'completed' },
      select: {
        category: true, totalValue: true, locationId: true,
        location: { select: { code: true, name: true } },
        items: { select: { productId: true, productName: true, unit: true, qty: true, totalCost: true, isExpiry: true } },
      },
    });
    const pending = await this.prisma.client.wasteRecord.aggregate({
      where: { ...this.wasteWhere({ category: q.category, locationId: q.locationId }, 'createdAt'), status: { in: ['pending', 'draft'] } },
      _count: { _all: true },
      _sum: { totalValue: true },
    });

    const byCategory = new Map<string, { category: string; records: number; value: number }>();
    const byLocation = new Map<string, { locationId: string; code: string; name: string; records: number; value: number }>();
    const byProduct = new Map<string, { productId: string; productName: string; unit: string | null; qty: number; value: number; lines: number }>();
    let totalValue = 0;
    let expiryValue = 0;

    for (const r of posted) {
      const value = Number(r.totalValue);
      totalValue += value;
      const c = byCategory.get(r.category) ?? { category: r.category, records: 0, value: 0 };
      c.records += 1; c.value += value; byCategory.set(r.category, c);
      const l = byLocation.get(r.locationId) ?? { locationId: r.locationId, code: r.location.code, name: r.location.name, records: 0, value: 0 };
      l.records += 1; l.value += value; byLocation.set(r.locationId, l);
      for (const it of r.items) {
        const p = byProduct.get(it.productId) ?? { productId: it.productId, productName: it.productName, unit: it.unit, qty: 0, value: 0, lines: 0 };
        p.qty += Number(it.qty); p.value += Number(it.totalCost); p.lines += 1;
        byProduct.set(it.productId, p);
        if (it.isExpiry) expiryValue += Number(it.totalCost);
      }
    }

    const desc = <T extends { value: number }>(a: T, b: T) => b.value - a.value;
    return {
      period: { from: q.from ?? null, to: q.to ?? null },
      postedRecords: posted.length,
      totalValue,
      expiryValue,
      pendingRecords: pending._count._all,
      pendingValue: Number(pending._sum.totalValue ?? 0),
      byCategory: [...byCategory.values()].sort(desc),
      byLocation: [...byLocation.values()].sort(desc),
      topProducts: [...byProduct.values()].sort(desc).slice(0, 10),
    };
  }

  // ===========================================================================
  // StockAdjustment — cycle count (posts ADJUSTMENT_IN / ADJUSTMENT_OUT)
  // ===========================================================================

  async createAdjustment(dto: CreateStockAdjustmentDto, externalTx?: any) {
    await this.location(dto.locationId);
    // Embedded callers (count / bottle-count submit) derive attribution from the
    // session themselves; only client-supplied ids need proving.
    if (!externalTx) {
      await assertActiveStaff(this.prisma.client, this.org, { responsibleById: dto.responsibleById, approvedById: dto.approvedById });
    }
    // One line per product/variant: approval counts each line to qtyActual in
    // turn, so a duplicate would silently overwrite the earlier count.
    const seen = new Set<string>();
    for (const i of dto.items) {
      const key = `${i.productId}:${i.variantId ?? ''}`;
      if (seen.has(key)) throw new BadRequestException('Each product can appear only once in an adjustment');
      seen.add(key);
    }
    const names = await this.productNames(dto.items.map((i) => i.productId));
    const missing = dto.items.find((i) => !names[i.productId]);
    if (missing) throw new NotFoundException(`Product ${missing.productId} not found`);
    const adjCode = await this.seq.next('stock_adj', { prefix: 'ADJ-', padding: 5 });

    // Snapshot system on-hand per line at creation time.
    const lines = await Promise.all(
      dto.items.map(async (i) => {
        const variantKey = i.variantId ?? '';
        const si = await this.prisma.client.stockItem.findFirst({
          where: { productId: i.productId, variantKey, locationId: dto.locationId },
          select: { quantity: true },
        });
        const qtySystem = si ? dec(si.quantity) : ZERO;
        const qtyActual = dec(i.qtyActual);
        return {
          organizationId: this.org,
          productId: i.productId,
          variantId: i.variantId ?? null,
          productName: names[i.productId] ?? 'Unknown',
          unit: i.unit ?? null,
          qtySystem,
          qtyActual,
          qtyDiff: qtyActual.minus(qtySystem),
          batchNumber: i.batchNumber ?? null,
        };
      }),
    );

    const run = async (tx: any) =>
      tx.stockAdjustment.create({
        data: {
          organizationId: this.org,
          adjCode,
          locationId: dto.locationId,
          reason: dto.reason ?? 'cycle_count',
          status: 'pending',
          notes: dto.notes ?? null,
          performedById: this.tenant.userId ?? null,
          responsibleById: dto.responsibleById,
          approvedById: dto.approvedById,
          createdBy: this.tenant.userId ?? null,
          items: { create: lines },
        },
        include: { items: true },
      });
    return externalTx ? run(externalTx) : this.prisma.client.$transaction(run);
  }

  async approveAdjustment(id: string, externalTx?: any, opts: { force?: boolean; forceReason?: string } = {}) {
    // Standalone approval is gated by the approval engine. When embedded in another
    // flow (externalTx present, e.g. guided count submit) the caller owns approval.
    if (!externalTx) {
      const pre = await this.prisma.client.stockAdjustment.findFirst({
        where: { id },
        include: { items: true },
      });
      if (!pre) throw new NotFoundException('Adjustment not found');
      const magnitude = pre.items.reduce((s, it) => s + Math.abs(Number(it.qtyDiff)), 0);
      await this.gateApproval(
        'stock_adjustment',
        pre.id,
        { amount: magnitude, adjCode: pre.adjCode, reason: pre.reason },
        `adjustment ${pre.adjCode}`,
      );
    }
    const run = async (tx: any) => {
      const doc = await tx.stockAdjustment.findFirst({ where: { id }, include: { items: true } });
      if (!doc) throw new NotFoundException('Adjustment not found');
      if (doc.postedAt) throw new BadRequestException('Document already posted');
      if (doc.status !== 'pending' && doc.status !== 'draft') {
        throw new BadRequestException(`Cannot approve a ${doc.status} document`);
      }
      // The read above is not a lock: claim the document before moving stock so a
      // concurrent approval cannot post the same lines a second time.
      const claim = await tx.stockAdjustment.updateMany({
        where: { id: doc.id, postedAt: null, status: { in: ['pending', 'draft'] } },
        data: { status: 'approved' },
      });
      if (claim.count === 0) throw new BadRequestException('Adjustment was posted or cancelled concurrently');

      // Drift guard (standalone approvals only; embedded count flows run their own
      // stale-count check). Each line counts to qtyActual, so if stock moved since
      // the document snapshotted qtySystem, approving would silently fold those
      // sales / receipts into the variance. Refuse unless explicitly forced.
      if (!externalTx) {
        const drifted: string[] = [];
        for (const item of doc.items) {
          const si = await tx.stockItem.findFirst({
            where: { organizationId: this.org, productId: item.productId, variantKey: item.variantId ?? '', locationId: doc.locationId },
            select: { quantity: true },
          });
          const nowQty = si ? dec(si.quantity) : ZERO;
          if (!nowQty.eq(dec(item.qtySystem))) {
            drifted.push(`${item.productName} (counted against ${dec(item.qtySystem).toString()}, now ${nowQty.toString()})`);
          }
        }
        if (drifted.length > 0 && !opts.force) {
          throw new ConflictException({
            code: 'ADJUSTMENT_STOCK_DRIFT',
            message:
              `Stock moved after this adjustment was created: ${drifted.slice(0, 5).join('; ')}` +
              `${drifted.length > 5 ? ` …and ${drifted.length - 5} more` : ''}. ` +
              'Re-create the adjustment, or approve with force and a reason to set the counted quantities anyway.',
            drifted,
          });
        }
        if (drifted.length > 0 && !opts.forceReason?.trim()) {
          throw new BadRequestException('A reason is required to force-approve an adjustment over stock that moved.');
        }
        if (drifted.length > 0) {
          await tx.stockAdjustment.update({
            where: { id: doc.id },
            data: { notes: [doc.notes, `Force-approved over drift: ${opts.forceReason!.trim()}`].filter(Boolean).join(' · ') },
          });
        }
      }

      for (const item of doc.items) {
        // adjust() re-reads current on-hand and counts to qtyActual — robust to
        // drift between creation and approval.
        await this.stock.adjust(
          {
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            locationId: doc.locationId,
            countedQuantity: Number(item.qtyActual),
            notes: `${doc.adjCode} · ${doc.reason}`,
            batchNumber: item.batchNumber ?? undefined,
            sourceType: 'stock_adjustment',
            sourceId: doc.adjCode,
            responsibleById: doc.responsibleById ?? undefined,
            approvedById: this.tenant.userId ?? doc.approvedById ?? undefined,
          },
          tx,
        );
      }
      return tx.stockAdjustment.update({
        where: { id: doc.id },
        data: {
          status: 'completed',
          approvedById: this.tenant.userId ?? null,
          approvedAt: new Date(),
          postedAt: new Date(),
        },
        include: { items: true },
      });
    };
    return externalTx ? run(externalTx) : this.prisma.client.$transaction(run);
  }

  /** Discard a not-yet-posted adjustment. Posted documents are immutable. */
  async cancelAdjustment(id: string) {
    const doc = await this.prisma.client.stockAdjustment.findFirst({ where: { id } });
    if (!doc) throw new NotFoundException('Adjustment not found');
    this.assertPostable(doc.status, doc.postedAt);
    const upd = await this.prisma.client.stockAdjustment.updateMany({
      where: { id, postedAt: null, status: { in: ['pending', 'draft'] } },
      data: { status: 'cancelled', updatedBy: this.tenant.userId ?? null },
    });
    if (upd.count === 0) throw new BadRequestException('Adjustment was posted or cancelled concurrently');
    return this.prisma.client.stockAdjustment.findFirst({ where: { id }, include: { items: true, location: true } });
  }

  // ===========================================================================
  // StockTransfer — inter-location (posts TRANSFER_OUT / TRANSFER_IN)
  // ===========================================================================

  async createTransfer(dto: CreateStockTransferDto) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('Source and destination must differ');
    }
    const fromLoc = await this.location(dto.fromLocationId);
    const toLoc = await this.location(dto.toLocationId);
    if (fromLoc.type === 'transit' || toLoc.type === 'transit') {
      throw new BadRequestException('The transit location is system-managed; use a transit transfer instead of moving stock into or out of it directly');
    }
    for (const i of dto.items) {
      if (!(Number(i.qtyRequested) > 0)) throw new BadRequestException('Every transfer line needs a positive quantity');
    }
    await assertActiveStaff(this.prisma.client, this.org, { responsibleById: dto.responsibleById, approvedById: dto.approvedById });
    const names = await this.productNames(dto.items.map((i) => i.productId));
    const transferCode = await this.seq.next('stock_transfer', { prefix: 'TRF-', padding: 5 });
    return this.prisma.client.stockTransfer.create({
      data: {
        organizationId: this.org,
        transferCode,
        fromLocId: dto.fromLocationId,
        toLocId: dto.toLocationId,
        status: 'pending',
        mode: dto.mode ?? 'immediate',
        notes: dto.notes ?? null,
        performedById: this.tenant.userId ?? null,
        responsibleById: dto.responsibleById,
        approvedById: dto.approvedById,
        createdBy: this.tenant.userId ?? null,
        items: {
          create: dto.items.map((i) => ({
            organizationId: this.org,
            productId: i.productId,
            variantId: i.variantId ?? null,
            productName: names[i.productId] ?? 'Unknown',
            unit: i.unit ?? null,
            qtyRequested: dec(i.qtyRequested),
            batchNumber: i.batchNumber ?? null,
            distStrategy: i.distStrategy ?? 'FEFO',
          })),
        },
      },
      include: { items: true },
    });
  }

  async approveTransfer(id: string) {
    const doc = await this.prisma.client.stockTransfer.findFirst({ where: { id }, include: { items: true } });
    if (!doc) throw new NotFoundException('Transfer not found');
    this.assertPostable(doc.status, doc.postedAt);

    const magnitude = doc.items.reduce((s, it) => s + Number(it.qtyRequested), 0);
    await this.gateApproval(
      'stock_transfer',
      doc.id,
      { amount: magnitude, transferCode: doc.transferCode },
      `transfer ${doc.transferCode}`,
    );

    if (doc.mode === 'transit') {
      // Transit: approval authorises the movement but moves nothing. Stock leaves
      // the source only when it is physically dispatched.
      const claim = await this.prisma.client.stockTransfer.updateMany({
        where: { id: doc.id, postedAt: null, status: { in: ['pending', 'draft'] } },
        data: { status: 'approved', approvedById: this.tenant.userId ?? null, approvedAt: new Date() },
      });
      if (claim.count === 0) throw new BadRequestException('Transfer was approved or cancelled concurrently');
      return this.getTransfer(doc.id);
    }

    return this.prisma.client.$transaction(async (tx: any) => {
      const claim = await tx.stockTransfer.updateMany({
        where: { id: doc.id, postedAt: null, status: { in: ['pending', 'draft'] }, mode: 'immediate' },
        data: { status: 'approved' },
      });
      if (claim.count === 0) throw new BadRequestException('Transfer was posted or cancelled concurrently');

      for (const item of doc.items) {
        await this.stock.transfer(
          {
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            fromLocationId: doc.fromLocId,
            toLocationId: doc.toLocId,
            quantity: Number(item.qtyRequested),
            sourceType: 'stock_transfer',
            sourceId: doc.transferCode,
            notes: doc.notes ?? undefined,
            responsibleById: doc.responsibleById ?? undefined,
            approvedById: this.tenant.userId ?? doc.approvedById ?? undefined,
          },
          tx,
        );
        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: { qtyTransferred: item.qtyRequested },
        });
      }
      return tx.stockTransfer.update({
        where: { id: doc.id },
        data: {
          status: 'completed',
          approvedById: this.tenant.userId ?? null,
          approvedAt: new Date(),
          postedAt: new Date(),
          completedAt: new Date(),
        },
        include: { items: true },
      });
    });
  }

  // ===========================================================================
  // Transit transfers (INV-P1-04): approve → dispatch → receive (partial, with
  // damage / shortage) → completed; recall returns what is still on the road.
  //
  // Goods on the road sit in a system `transit` location, so every stage reuses
  // the stock engine (quants, lots, serials, AVCO carry, ledger chain, GL) and the
  // in-transit balance is real, valued, reportable stock — never "already at the
  // destination" before anyone has received it.
  // ===========================================================================

  async getTransfer(id: string) {
    const doc = await this.prisma.client.stockTransfer.findFirst({
      where: { id },
      include: { items: true, receipts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!doc) throw new NotFoundException('Transfer not found');
    return doc;
  }

  /** The org's transit location, created on first use. Runs outside a tx so a P2002 race can retry. */
  private async ensureTransitLocation(): Promise<{ id: string }> {
    const find = () =>
      this.prisma.client.inventoryLocation.findFirst({
        where: { type: 'transit', isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
    const existing = await find();
    if (existing) return existing;
    for (const code of ['TRANSIT', 'TRANSIT-SYS']) {
      try {
        return await this.prisma.client.inventoryLocation.create({
          data: { organizationId: this.org, code, name: 'Goods in transit', type: 'transit', createdBy: this.tenant.userId ?? null },
          select: { id: true },
        });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        const raced = await find();
        if (raced) return raced;
      }
    }
    throw new ConflictException('Could not create the transit location (codes TRANSIT and TRANSIT-SYS are used by other locations)');
  }

  /** Row-lock the transfer header for the rest of the tx and return it with fresh items. */
  private async lockTransfer(tx: any, id: string) {
    await tx.$queryRawUnsafe(`SELECT id FROM "StockTransfer" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`, id, this.org);
    const doc = await tx.stockTransfer.findFirst({ where: { id, organizationId: this.org }, include: { items: true } });
    if (!doc) throw new NotFoundException('Transfer not found');
    if (doc.mode !== 'transit') {
      throw new BadRequestException(`${doc.transferCode} is an immediate transfer; it has no dispatch or receipt stages`);
    }
    return doc;
  }

  private outstanding(item: any) {
    return dec(item.qtyDispatched)
      .minus(dec(item.qtyReceived))
      .minus(dec(item.qtyDamaged))
      .minus(dec(item.qtyShort))
      .minus(dec(item.qtyRecalled));
  }

  /** Dispatch an approved transit transfer: source → transit for every line. */
  async dispatchTransfer(id: string) {
    const transit = await this.ensureTransitLocation();
    return this.prisma.client.$transaction(
      async (tx: any) => {
        const doc = await this.lockTransfer(tx, id);
        if (doc.status !== 'approved' || doc.dispatchedAt) {
          throw new BadRequestException(`Only an approved, undispatched transfer can be dispatched (${doc.transferCode} is ${doc.status})`);
        }
        // Deterministic lock order across lines (same as direct stock-out).
        const items = [...doc.items].sort((a: any, b: any) =>
          `${a.productId}:${a.variantId ?? ''}`.localeCompare(`${b.productId}:${b.variantId ?? ''}`),
        );
        for (const item of items) {
          await this.stock.transfer(
            {
              productId: item.productId,
              variantId: item.variantId ?? undefined,
              fromLocationId: doc.fromLocId,
              toLocationId: transit.id,
              quantity: Number(item.qtyRequested),
              sourceType: 'stock_transfer_dispatch',
              sourceId: doc.transferCode,
              notes: doc.notes ?? undefined,
              responsibleById: doc.responsibleById ?? undefined,
              approvedById: doc.approvedById ?? undefined,
            },
            tx,
          );
          await tx.stockTransferItem.update({ where: { id: item.id }, data: { qtyDispatched: item.qtyRequested } });
        }
        const now = new Date();
        await tx.stockTransfer.update({
          where: { id: doc.id },
          data: {
            status: 'in_transit',
            transitLocId: transit.id,
            dispatchedAt: now,
            dispatchedById: this.tenant.userId ?? null,
            postedAt: now,
            updatedBy: this.tenant.userId ?? null,
          },
        });
        await this.audit.recordInTx(tx, {
          entity: 'StockTransfer',
          entityId: doc.id,
          action: 'update',
          newValues: { kind: 'transfer_dispatched', transferCode: doc.transferCode, transitLocId: transit.id },
        });
        return tx.stockTransfer.findFirst({ where: { id: doc.id }, include: { items: true, receipts: true } });
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Record one destination receipt. Each line splits (part of) the outstanding
   * in-transit quantity into received (transit → destination), damaged (waste
   * write-off from transit) and short (loss write-off from transit). Repeatable
   * until every dispatched unit is accounted for.
   */
  async receiveTransfer(id: string, dto: ReceiveStockTransferDto) {
    return this.prisma.client.$transaction(
      async (tx: any) => {
        const doc = await this.lockTransfer(tx, id);
        if (doc.status !== 'in_transit' && doc.status !== 'partially_received') {
          throw new BadRequestException(`${doc.transferCode} is ${doc.status}; only in-transit transfers can be received`);
        }
        const byId = new Map<string, any>(doc.items.map((i: any) => [i.id, i]));
        const seen = new Set<string>();
        const plan: Array<{ item: any; received: ReturnType<typeof dec>; damaged: ReturnType<typeof dec>; short: ReturnType<typeof dec> }> = [];
        for (const line of dto.lines) {
          const item = byId.get(line.itemId);
          if (!item) throw new BadRequestException(`Line ${line.itemId} does not belong to ${doc.transferCode}`);
          if (seen.has(line.itemId)) throw new BadRequestException(`${item.productName} appears more than once in the receipt`);
          seen.add(line.itemId);
          const received = dec(line.received ?? 0);
          const damaged = dec(line.damaged ?? 0);
          const short = dec(line.short ?? 0);
          const total = received.plus(damaged).plus(short);
          if (total.isZero()) continue;
          const open = this.outstanding(item);
          if (total.gt(open.plus(QTY_EPSILON))) {
            throw new BadRequestException(
              `${item.productName}: received ${received} + damaged ${damaged} + short ${short} exceeds the ${open} still in transit`,
            );
          }
          plan.push({ item, received, damaged, short });
        }
        if (plan.length === 0) throw new BadRequestException('Enter a received, damaged or short quantity on at least one line');

        const receiptCode = await this.seq.next('stock_transfer_receipt', { prefix: 'TRR-', padding: 5 }, tx);
        const transitLocId = doc.transitLocId as string;
        const reference = `${doc.transferCode} ${receiptCode}`;
        for (const { item, received, damaged, short } of plan) {
          const base = { productId: item.productId, variantId: item.variantId ?? undefined };
          if (received.gt(ZERO)) {
            await this.stock.transfer(
              {
                ...base,
                fromLocationId: transitLocId,
                toLocationId: doc.toLocId,
                quantity: Number(received),
                sourceType: 'stock_transfer_receipt',
                sourceId: doc.transferCode,
                notes: [receiptCode, dto.notes].filter(Boolean).join(' · '),
                responsibleById: doc.responsibleById ?? undefined,
                approvedById: this.tenant.userId ?? undefined,
              },
              tx,
            );
          }
          if (damaged.gt(ZERO)) {
            await this.stock.issue(
              {
                ...base,
                locationId: transitLocId,
                quantity: Number(damaged),
                moveType: 'waste',
                sourceType: 'stock_transfer_loss',
                sourceId: doc.transferCode,
                reference: `${reference} damaged in transit`,
                requireAvailable: true,
                approvedById: this.tenant.userId ?? undefined,
              } as InternalIssueInput,
              tx,
            );
          }
          if (short.gt(ZERO)) {
            // Quantity-only issue, then the loss journal at the exact moved value.
            const res = await this.stock.issue(
              {
                ...base,
                locationId: transitLocId,
                quantity: Number(short),
                moveType: 'adjustment_out',
                sourceType: 'stock_transfer_loss',
                sourceId: doc.transferCode,
                reference: `${reference} short on arrival`,
                requireAvailable: true,
                skipGlPosting: true,
                approvedById: this.tenant.userId ?? undefined,
              } as InternalIssueInput,
              tx,
            );
            await this.stockPosting.postAdjustment({
              productId: item.productId,
              delta: -1,
              unitCost: dec(res.totalValue),
              date: new Date(),
              sourceType: 'stock_transfer_loss',
              sourceId: doc.transferCode,
              description: `Transit shortage · ${item.productName} · ${short} · ${reference}`,
              tx,
            });
          }
          await tx.stockTransferItem.update({
            where: { id: item.id },
            data: {
              qtyReceived: { increment: received },
              qtyDamaged: { increment: damaged },
              qtyShort: { increment: short },
              qtyTransferred: { increment: received },
            },
          });
        }

        await tx.stockTransferReceipt.create({
          data: {
            organizationId: this.org,
            transferId: doc.id,
            receiptCode,
            kind: 'receipt',
            receivedById: this.tenant.userId ?? null,
            notes: dto.notes ?? null,
            lines: plan.map((p) => ({
              itemId: p.item.id,
              productId: p.item.productId,
              received: p.received.toString(),
              damaged: p.damaged.toString(),
              short: p.short.toString(),
            })),
          },
        });
        const done = await this.finaliseTransit(tx, doc.id, false);
        await this.audit.recordInTx(tx, {
          entity: 'StockTransfer',
          entityId: doc.id,
          action: 'update',
          newValues: { kind: 'transfer_received', transferCode: doc.transferCode, receiptCode, status: done.status },
        });
        return done;
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Recall everything still in transit back to the source (delivery aborted,
   * goods turned back). Before dispatch, cancel the document instead.
   */
  async recallTransfer(id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required to recall a transfer');
    return this.prisma.client.$transaction(
      async (tx: any) => {
        const doc = await this.lockTransfer(tx, id);
        if (doc.status !== 'in_transit' && doc.status !== 'partially_received') {
          throw new BadRequestException(`${doc.transferCode} is ${doc.status}; only goods still in transit can be recalled`);
        }
        const receiptCode = await this.seq.next('stock_transfer_receipt', { prefix: 'TRR-', padding: 5 }, tx);
        const lines: Array<Record<string, string>> = [];
        for (const item of doc.items) {
          const open = this.outstanding(item);
          if (open.lte(QTY_EPSILON)) continue;
          await this.stock.transfer(
            {
              productId: item.productId,
              variantId: item.variantId ?? undefined,
              fromLocationId: doc.transitLocId as string,
              toLocationId: doc.fromLocId,
              quantity: Number(open),
              sourceType: 'stock_transfer_recall',
              sourceId: doc.transferCode,
              notes: `${receiptCode} recall: ${reason.trim()}`,
              approvedById: this.tenant.userId ?? undefined,
            },
            tx,
          );
          await tx.stockTransferItem.update({ where: { id: item.id }, data: { qtyRecalled: { increment: open } } });
          lines.push({ itemId: item.id, productId: item.productId, recalled: open.toString() });
        }
        if (lines.length === 0) throw new BadRequestException(`${doc.transferCode} has nothing left in transit`);
        await tx.stockTransferReceipt.create({
          data: {
            organizationId: this.org,
            transferId: doc.id,
            receiptCode,
            kind: 'recall',
            receivedById: this.tenant.userId ?? null,
            notes: reason.trim(),
            lines,
          },
        });
        const done = await this.finaliseTransit(tx, doc.id, true);
        await this.audit.recordInTx(tx, {
          entity: 'StockTransfer',
          entityId: doc.id,
          action: 'update',
          newValues: { kind: 'transfer_recalled', transferCode: doc.transferCode, receiptCode, reason: reason.trim(), status: done.status },
        });
        return done;
      },
      { timeout: 60_000 },
    );
  }

  /** Cancel a transfer that has not moved any stock yet (pending, or approved but undispatched). */
  async cancelTransfer(id: string) {
    const doc = await this.getTransfer(id);
    const upd = await this.prisma.client.stockTransfer.updateMany({
      where: { id: doc.id, postedAt: null, dispatchedAt: null, status: { in: ['draft', 'pending', 'approved'] } },
      data: { status: 'cancelled', updatedBy: this.tenant.userId ?? null },
    });
    if (upd.count === 0) {
      throw new BadRequestException(`${doc.transferCode} has already moved stock; recall or reverse it instead`);
    }
    return this.getTransfer(id);
  }

  /** Settle the header status after a receipt or recall. */
  private async finaliseTransit(tx: any, id: string, recalled: boolean) {
    const items = await tx.stockTransferItem.findMany({ where: { transferId: id } });
    const allAccounted = items.every((i: any) => this.outstanding(i).lte(QTY_EPSILON));
    const anyDelivered = items.some((i: any) => dec(i.qtyReceived).plus(dec(i.qtyDamaged)).plus(dec(i.qtyShort)).gt(ZERO));
    const now = new Date();
    const status = !allAccounted ? 'partially_received' : anyDelivered ? 'completed' : 'cancelled';
    await tx.stockTransfer.update({
      where: { id },
      data: {
        status,
        ...(recalled ? {} : { lastReceivedAt: now }),
        ...(status === 'completed' ? { completedAt: now } : {}),
        updatedBy: this.tenant.userId ?? null,
      },
    });
    return tx.stockTransfer.findFirst({ where: { id }, include: { items: true, receipts: { orderBy: { createdAt: 'asc' } } } });
  }

  // ===========================================================================
  // Shared helpers + list/get
  // ===========================================================================

  private assertPostable(status: string, postedAt: Date | null): void {
    if (postedAt) throw new BadRequestException('Document already posted');
    if (status !== 'pending' && status !== 'draft') {
      throw new BadRequestException(`Cannot approve a ${status} document`);
    }
  }

  list(kind: 'out' | 'waste' | 'adjustment' | 'transfer', status?: string) {
    const where = status ? { status: status as any } : {};
    const order = { createdAt: 'desc' as const };
    switch (kind) {
      case 'out':
        return this.prisma.client.stockOut.findMany({ where, orderBy: order, include: { items: true } });
      case 'waste':
        return this.prisma.client.wasteRecord.findMany({ where, orderBy: order, include: { items: true } });
      case 'adjustment':
        return this.prisma.client.stockAdjustment.findMany({ where, orderBy: order, include: { items: true, location: true } });
      case 'transfer':
        return this.prisma.client.stockTransfer.findMany({ where, orderBy: order, include: { items: true, receipts: { orderBy: { createdAt: 'asc' } } } });
    }
  }
}
