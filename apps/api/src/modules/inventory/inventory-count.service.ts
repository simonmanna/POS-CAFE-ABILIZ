import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { dec } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { StockDocService } from './stock-doc.service';
import { SaveCountDraftDto, StartCountDto } from './dto/inventory-count.dto';

/**
 * Inventory Count Sessions — guided physical stock count (opening / closing).
 *
 * The supervisor counts items; nothing touches stock until Submit. On submit,
 * the variance lines are turned into a {@link StockDocService} adjustment which
 * posts ADJUSTMENT_IN/OUT to the ledger (the single audit-safe write path — we
 * never overwrite quants directly). The count itself is a permanent record of
 * "what was physically found, by whom, when, and why".
 */
@Injectable()
export class InventoryCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly stockDoc: StockDocService,
  ) {}

  private get org(): string {
    return this.tenant.organizationId;
  }

  private async location(id: string) {
    const loc = await this.prisma.client.inventoryLocation.findFirst({ where: { id } });
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  /** Full session with lines, ordered for display. */
  async get(id: string) {
    const session = await this.prisma.client.inventoryCountSession.findFirst({
      where: { id },
      include: { lines: { orderBy: { productName: 'asc' } }, location: true },
    });
    if (!session) throw new NotFoundException('Count session not found');
    return session;
  }

  /** Session headers (most recent first) for the history list. */
  async list() {
    return this.prisma.client.inventoryCountSession.findMany({
      orderBy: { startedAt: 'desc' },
      include: { location: true, _count: { select: { lines: true } } },
      take: 100,
    });
  }

  /**
   * Start a new count, or resume the open draft for this location + type. Loads
   * every active, inventory-tracked product and snapshots its current on-hand.
   */
  async start(dto: StartCountDto) {
    await this.location(dto.locationId);
    const countType = dto.countType ?? 'opening';

    const existing = await this.prisma.client.inventoryCountSession.findFirst({
      where: { locationId: dto.locationId, countType, status: 'draft' },
    });
    if (existing) return this.get(existing.id);

    const products = await this.prisma.client.product.findMany({
      where: { trackInventory: true, isActive: true, hasVariants: false },
      select: { id: true, name: true, uom: { select: { code: true } } },
      orderBy: { name: 'asc' },
    });

    // Snapshot system on-hand for every product at this location in one query.
    const stockItems = await this.prisma.client.stockItem.findMany({
      where: { locationId: dto.locationId, productId: { in: products.map((p) => p.id) }, variantKey: '' },
      select: { productId: true, quantity: true },
    });
    const onHand = new Map(stockItems.map((s) => [s.productId, s.quantity]));

    const countCode = await this.seq.next('inv_count', { prefix: 'CNT-', padding: 5 });
    const session = await this.prisma.client.inventoryCountSession.create({
      data: {
        organizationId: this.org,
        countCode,
        locationId: dto.locationId,
        countType,
        status: 'draft',
        notes: dto.notes ?? null,
        startedById: this.tenant.userId ?? null,
        createdBy: this.tenant.userId ?? null,
        lines: {
          create: products.map((p) => ({
            organizationId: this.org,
            productId: p.id,
            productName: p.name,
            unit: p.uom?.code ?? null,
            systemQty: onHand.get(p.id) ?? dec(0),
            countedQty: null,
            variance: dec(0),
          })),
        },
      },
    });
    return this.get(session.id);
  }

  private async assertDraft(id: string) {
    const session = await this.prisma.client.inventoryCountSession.findFirst({ where: { id } });
    if (!session) throw new NotFoundException('Count session not found');
    if (session.status !== 'draft') {
      throw new BadRequestException(`Cannot modify a ${session.status} count`);
    }
    return session;
  }

  /** Persist the supervisor's in-progress counts (upsert per line, recompute variance). */
  async saveDraft(id: string, dto: SaveCountDraftDto) {
    await this.assertDraft(id);
    const lines = await this.prisma.client.inventoryCountLine.findMany({
      where: { sessionId: id },
      select: { id: true, systemQty: true },
    });
    const sysById = new Map(lines.map((l) => [l.id, l.systemQty]));

    for (const l of dto.lines) {
      if (!sysById.has(l.lineId)) continue; // ignore lines not in this session
      const counted = l.countedQty === null || l.countedQty === undefined ? null : dec(l.countedQty);
      const variance = counted === null ? dec(0) : counted.minus(dec(sysById.get(l.lineId)!));
      await this.prisma.client.inventoryCountLine.updateMany({
        where: { id: l.lineId, sessionId: id },
        data: {
          countedQty: counted,
          variance,
          reason: l.reason ?? null,
          countedById: counted === null ? null : this.tenant.userId ?? null,
          countedAt: counted === null ? null : new Date(),
        },
      });
    }

    if (dto.notes !== undefined) {
      await this.prisma.client.inventoryCountSession.update({
        where: { id },
        data: { notes: dto.notes, updatedBy: this.tenant.userId ?? null },
      });
    }
    return this.get(id);
  }

  /**
   * Finalise the count. Requires a reason on every variance line, then turns the
   * variances into a StockAdjustment and posts it. Zero-variance counts submit
   * cleanly with no adjustment.
   */
  async submit(id: string) {
    await this.assertDraft(id);
    const lines = await this.prisma.client.inventoryCountLine.findMany({ where: { sessionId: id } });
    const counted = lines.filter((l) => l.countedQty !== null);
    if (counted.length === 0) {
      throw new BadRequestException('Nothing counted yet — enter at least one physical count.');
    }

    const varianceLines = counted.filter((l) => !dec(l.variance).isZero());
    const missingReason = varianceLines.filter((l) => !l.reason || !l.reason.trim());
    if (missingReason.length > 0) {
      throw new BadRequestException(
        `A reason is required for ${missingReason.length} line(s) with a variance.`,
      );
    }

    const session = await this.get(id);
    let adjustmentId: string | null = null;

    if (varianceLines.length > 0) {
      const adj = await this.stockDoc.createAdjustment({
        locationId: session.locationId,
        reason: 'cycle_count',
        notes: `${session.countType} count ${session.countCode}`,
        items: varianceLines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId ?? undefined,
          unit: l.unit ?? undefined,
          qtyActual: Number(l.countedQty),
        })),
      });
      await this.stockDoc.approveAdjustment(adj.id);
      adjustmentId = adj.id;
    }

    await this.prisma.client.inventoryCountSession.update({
      where: { id },
      data: {
        status: 'submitted',
        submittedById: this.tenant.userId ?? null,
        submittedAt: new Date(),
        adjustmentId,
      },
    });
    return this.get(id);
  }

  /** Abandon a draft count (soft delete) without touching stock. */
  async cancel(id: string) {
    await this.assertDraft(id);
    await this.prisma.client.inventoryCountSession.update({
      where: { id },
      data: { status: 'cancelled', updatedBy: this.tenant.userId ?? null },
    });
    return { ok: true };
  }
}
