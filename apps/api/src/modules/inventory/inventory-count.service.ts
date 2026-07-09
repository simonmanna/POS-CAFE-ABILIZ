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

  /** Full session with lines, ordered for display (parents first, then variants). */
  async get(id: string) {
    const session = await this.prisma.client.inventoryCountSession.findFirst({
      where: { id },
      include: {
        lines: { orderBy: [{ parentProductId: 'asc' }, { productName: 'asc' }] },
        location: true,
      },
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
   * Start a fresh count session. Any existing draft for this location + type is
   * cancelled first, so the count always reflects the latest product list.
   *
   * Non-variant products → one flat row per product.
   * Variant parents      → one row per child variant, grouped under the parent.
   *
   * A partial unique index on (org, locationId, countType) WHERE status = 'draft'
   * prevents two users from creating duplicate sessions concurrently — the rare
   * collision is caught and the existing draft is returned transparently.
   */
  async start(dto: StartCountDto) {
    await this.location(dto.locationId);
    const countType = dto.countType ?? 'opening';

    // Cancel any existing draft for this location + type so the new count is
    // always fresh (picks up new products, removes deactivated ones, etc.).
    await this.prisma.client.inventoryCountSession.updateMany({
      where: { locationId: dto.locationId, countType, status: 'draft' },
      data: { status: 'cancelled', updatedBy: this.tenant.userId ?? null },
    });

    const products = await this.prisma.client.product.findMany({
      where: {},
      select: { id: true, name: true, hasVariants: true, uom: { select: { code: true } } },
      orderBy: { name: 'asc' },
    });
    const parentById = new Map(products.map((p) => [p.id, p]));

    const nonVariant = products.filter((p) => !p.hasVariants);
    const variantParents = products.filter((p) => p.hasVariants);

    // Fetch all variants for variant parents.
    const variants = await this.prisma.client.productVariant.findMany({
      where: { productId: { in: variantParents.map((p) => p.id) }, isActive: true },
      select: { id: true, productId: true, name: true },
      orderBy: { name: 'asc' },
    });

    // Build line definitions.
    const lines: Array<{
      organizationId: string;
      productId: string;
      variantId: string | null;
      productName: string;
      parentProductId: string | null;
      parentProductName: string | null;
      unit: string | null;
      systemQty: any;
      countedQty: null;
      variance: any;
    }> = [];

    for (const p of nonVariant) {
      lines.push({
        organizationId: this.org,
        productId: p.id,
        variantId: null,
        productName: p.name,
        parentProductId: null,
        parentProductName: null,
        unit: p.uom?.code ?? null,
        systemQty: dec(0),
        countedQty: null,
        variance: dec(0),
      });
    }

    for (const v of variants) {
      const parent = parentById.get(v.productId);
      lines.push({
        organizationId: this.org,
        productId: v.productId,
        variantId: v.id,
        productName: v.name,
        parentProductId: v.productId,
        parentProductName: parent?.name ?? null,
        unit: parent?.uom?.code ?? null,
        systemQty: dec(0),
        countedQty: null,
        variance: dec(0),
      });
    }

    // Snapshot on-hand: non-variant (variantKey = '') + variant stock.
    const variantIds = variants.map((v) => v.id);
    const stockItems = await this.prisma.client.stockItem.findMany({
      where: {
        locationId: dto.locationId,
        productId: { in: products.map((p) => p.id) },
        variantKey: { in: ['', ...variantIds] },
      },
      select: { productId: true, variantId: true, quantity: true },
    });
    const onHand = new Map<string, any>();
    for (const si of stockItems) {
      onHand.set(`${si.productId}::${si.variantId ?? ''}`, si.quantity);
    }
    for (const ln of lines) {
      ln.systemQty = onHand.get(`${ln.productId}::${ln.variantId ?? ''}`) ?? dec(0);
    }

    const countCode = await this.seq.next('inv_count', { prefix: 'CNT-', padding: 5 });
    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateStr = `${months[now.getMonth()]} ${String(now.getDate()).padStart(2,'0')}, ${now.getFullYear()}`;
    const autoName = `${countType === 'opening' ? 'Opening' : 'Closing'} Count – ${dateStr}`;
    try {
      const session = await this.prisma.client.inventoryCountSession.create({
        data: {
          organizationId: this.org,
          countCode,
          name: autoName,
          locationId: dto.locationId,
          countType,
          status: 'draft',
          notes: dto.notes ?? null,
          startedById: this.tenant.userId ?? null,
          createdBy: this.tenant.userId ?? null,
          lines: { create: lines as any },
        },
      });
      return this.get(session.id);
    } catch (err: any) {
      // P2002 = unique constraint violation (concurrent draft creation).
      // Fall back to returning the existing draft.
      if (err?.code === 'P2002') {
        const existing = await this.prisma.client.inventoryCountSession.findFirst({
          where: { locationId: dto.locationId, countType, status: 'draft' },
        });
        if (existing) return this.get(existing.id);
      }
      throw err;
    }
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

    const updateData: Record<string, any> = { updatedBy: this.tenant.userId ?? null };
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.notes !== undefined) updateData.notes = dto.notes;
    if (dto.name !== undefined || dto.notes !== undefined) {
      await this.prisma.client.inventoryCountSession.update({ where: { id }, data: updateData });
    }
    return this.get(id);
  }

  /**
   * Finalise the count. Requires a reason on every variance line, then turns the
   * variances into a StockAdjustment and posts it. Zero-variance counts submit
   * cleanly with no adjustment.
   *
   * The adjustment creation + approval + session update are wrapped in a single
   * $transaction so a crash mid-submit cannot orphan a completed adjustment
   * while leaving the session in draft (which would cause double-adjust on
   * retry).
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

    if (varianceLines.length === 0) {
      // No variances — no adjustment needed, submit directly.
      await this.prisma.client.inventoryCountSession.update({
        where: { id },
        data: {
          status: 'submitted',
          submittedById: this.tenant.userId ?? null,
          submittedAt: new Date(),
        },
      });
      return this.get(id);
    }

    // Atomic: create adjustment + approve + mark session submitted in one tx.
    // If any step fails the entire operation rolls back — no orphaned adjustments.
    return this.prisma.client.$transaction(async (tx: any) => {
      // Re-assert draft inside the tx so a concurrent submit/cancel can't race.
      const session = await tx.inventoryCountSession.findFirst({
        where: { id },
        include: { lines: { orderBy: [{ parentProductId: 'asc' }, { productName: 'asc' }] }, location: true },
      });
      if (!session || session.status !== 'draft') {
        throw new BadRequestException('Session was modified; please retry.');
      }

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
      }, tx);

      await this.stockDoc.approveAdjustment(adj.id, tx);

      await tx.inventoryCountSession.update({
        where: { id },
        data: {
          status: 'submitted',
          submittedById: this.tenant.userId ?? null,
          submittedAt: new Date(),
          adjustmentId: adj.id,
        },
      });

      return tx.inventoryCountSession.findFirst({
        where: { id },
        include: { lines: { orderBy: [{ parentProductId: 'asc' }, { productName: 'asc' }] }, location: true },
      });
    });
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
