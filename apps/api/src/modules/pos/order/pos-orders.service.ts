import { businessOperation, recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { discountedLines } from '../pricing-policy';
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { EVENTS } from '@erp/shared';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { SequenceService } from '../../../kernel/sequence/sequence.service';
import { DocumentBuilderService } from '../../invoicing/document/document-builder.service';
import { PosVariantService } from '../pos-variant.service';
import { PosAccompanimentService } from '../pos-accompaniment.service';
import { PosModifiersService } from '../pos-modifiers.service';
import { PosKdsService } from '../pos-kds.service';
import { PosReceiptsService } from '../pos-receipts.service';
import { dec } from '../../../kernel/common/money';
import { recomputeTableStatus, TABLE_HELD_ORDER_STATUSES } from '../table-status.util';
import { toCanonicalOrderStatus, withLegacyOrderStatus } from '../order-status.util';
import { WorkflowService } from '../../../kernel/workflow/workflow.service';
import { MilestoneService } from '../../../kernel/milestones/milestone.service';
import type { CreateOrderDto, SaveOrderItemsDto, AddOrderItemsDto, OrderLineDto } from './dto/order.dto';

/** A cart line resolved to ledger-ready values (modifiers/variant folded into unitPrice). */
interface ResolvedLine {
  productId: string | null;
  menuItemId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxId: string | null;
  discountPercent: number;
  /** 'percentage' (default) or 'fixed_amount'. */
  discountType?: 'percentage' | 'fixed_amount';
  /** Total fixed discount for this line (in currency). */
  discountAmount?: number;
  discountReason?: string | null;
  note: string | null;
  taxInclusive: boolean | undefined;
  modifiers: Array<{ modifierId: string; name: string; priceDelta: number }>;
  variantId?: string;
  variantName?: string;
  accompanimentNames: string[];
  accompanimentOptionIds: string[];
  station: 'bar' | 'kitchen' | 'cafe';
  /** P5 course grouping (1=starter, 2=main, …). */
  course?: number | null;
}

/**
 * Operational Order aggregate (the restaurant-ops layer of the Order→Invoice→
 * Receipt split). Owns the draft/open lifecycle, item editing, the per-item
 * kitchen flow (KOT), and table/waiter assignment. No GL/stock/cash effect
 * happens here — that is deferred to PosBillingService at bill generation.
 */
@Injectable()
export class PosOrdersService {
  private readonly logger = new Logger('PosOrdersService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly sequence: SequenceService,
    private readonly builder: DocumentBuilderService,
    private readonly variants: PosVariantService,
    private readonly accompaniments: PosAccompanimentService,
    private readonly modifiers: PosModifiersService,
    private readonly kds: PosKdsService,
    private readonly receipts: PosReceiptsService,
    private readonly workflows: WorkflowService,
    private readonly milestones: MilestoneService,
  ) {}

  async quote(input: { lines: OrderLineDto[]; transactionDiscountType?: string; transactionDiscountAmount?: number; transactionDiscountPercent?: number }) {
    await this.validateLines(input.lines, false);
    const resolved = await this.resolveLines(input.lines);
    const totals = await this.builder.prepareLines(this.prisma.client, discountedLines(resolved, input));
    return { baseLines: resolved, pricingVersion: 1, subtotal: Number(totals.subtotal), discountTotal: Number(totals.discountTotal), taxAmount: Number(totals.taxAmount), total: Number(totals.total), lines: totals.prepared };
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async getOrder(orderId: string) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.order.findFirst({
      where: { id: orderId, organizationId: orgId },
      include: { items: { where: { cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true } }, invoice: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Milestone timeline for an order, projected from the event ledger (Phase B). */
  async getMilestones(orderId: string) {
    // Validates existence + tenant scope; throws 404 for an unknown order.
    await this.getOrder(orderId);
    return this.milestones.forEntity('order', orderId);
  }

  /** The current open (un-billed) order on a table, or null. */
  async getOpenOrderForTable(tableId: string) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.order.findFirst({
      where: { organizationId: orgId, tableId, status: { in: TABLE_HELD_ORDER_STATUSES as any }, invoiceId: null },
      orderBy: { openedAt: 'desc' },
      include: { items: { where: { cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true } } },
    });
  }

  async list(filter: { status?: string; tableId?: string; cashSessionId?: string } = {}) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.order.findMany({
      where: {
        organizationId: orgId,
        // Accept legacy status spellings from in-field Android APKs.
        ...(filter.status ? { status: toCanonicalOrderStatus(filter.status) as any } : {}),
        ...(filter.tableId ? { tableId: filter.tableId } : {}),
        ...(filter.cashSessionId ? { cashSessionId: filter.cashSessionId } : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: 200,
      include: { items: { where: { cancelled: false }, orderBy: { lineNumber: 'asc' } } },
    });
  }

  /**
   * Live open-orders feed for the Odoo-style Orders panel: every un-billed order
   * (any type — dine-in, takeaway, delivery, tableless walk-in/retail) with
   * table / waiter / customer names resolved. Cheap: reads the Order.totalAmount
   * snapshot only (no items), index-backed by [organizationId, status]. Returns
   * `{ count, rows }` so the nav badge and the panel share one query.
   */
  async listOpenOrders(filter: { orderType?: string; cashSessionId?: string; branchId?: string; search?: string } = {}) {
    const orgId = this.tenant.organizationId;
    const orders = await this.prisma.client.order.findMany({
      where: {
        organizationId: orgId,
        status: { in: TABLE_HELD_ORDER_STATUSES as any },
        invoiceId: null,
        ...(filter.orderType ? { orderType: filter.orderType as any } : {}),
        ...(filter.cashSessionId ? { cashSessionId: filter.cashSessionId } : {}),
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
        ...(filter.search ? { orderNumber: { contains: filter.search, mode: 'insensitive' as any } } : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: 200,
    });

    const tableIds = new Set(orders.map((o: any) => o.tableId).filter(Boolean));
    const waiterIds = new Set(orders.map((o: any) => o.waiterId).filter(Boolean));
    const partnerIds = new Set(orders.map((o: any) => o.partnerId).filter(Boolean));
    const [tables, waiters, partners] = await Promise.all([
      tableIds.size ? this.prisma.client.posTable.findMany({ where: { id: { in: Array.from(tableIds) as string[] } }, select: { id: true, name: true } }) : Promise.resolve([]),
      waiterIds.size ? this.prisma.client.user.findMany({ where: { id: { in: Array.from(waiterIds) as string[] } }, select: { id: true, firstName: true, lastName: true } }) : Promise.resolve([]),
      partnerIds.size ? this.prisma.client.partner.findMany({ where: { id: { in: Array.from(partnerIds) as string[] } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const tableMap = new Map((tables as any[]).map((t) => [t.id, t.name]));
    const waiterMap = new Map((waiters as any[]).map((w) => [w.id, `${w.firstName}${w.lastName ? ' ' + w.lastName : ''}`]));
    const partnerMap = new Map((partners as any[]).map((p) => [p.id, p.name]));

    const rows = (orders as any[]).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderType: o.orderType ?? null,
      ...withLegacyOrderStatus(o.status),
      openedAt: o.openedAt ?? o.createdAt,
      tableId: o.tableId ?? null,
      tableName: o.tableId ? (tableMap.get(o.tableId) ?? null) : null,
      waiterName: o.waiterId ? (waiterMap.get(o.waiterId) ?? null) : null,
      partnerId: o.partnerId ?? null,
      customerName: o.partnerId ? (partnerMap.get(o.partnerId) ?? null) : null,
      guestCount: o.guestCount ?? null,
      totalAmount: Number(o.totalAmount ?? 0),
    }));
    return { count: rows.length, rows };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /** Create a new order. Number is assigned immediately. Items are optional. */
  async createOrder(dto: CreateOrderDto) {
    const orgId = this.tenant.organizationId;
    const partnerId = dto.partnerId ?? (await this.ensureWalkInCustomer(orgId));
    const bypassRequired = dto.overrideById ? await this.assertOverride(dto.overrideById) : false;
    if (dto.lines?.length) await this.validateLines(dto.lines, bypassRequired);
    const resolved = dto.lines?.length ? await this.resolveLines(dto.lines) : [];

    return this.prisma.client.$transaction(async (tx: any) => {
      // One active *un-billed* dine-in tab per table. The floor UI reuses the
      // open order via getOpenOrderForTable (which also filters invoiceId: null),
      // so this guard must match it — otherwise a billed-but-unpaid order (which
      // getOpenOrderForTable can't see) would block a brand-new round on the table
      // with a cryptic 409. A billed order settles on its own bill; a new round
      // starts a fresh order. We still block a second genuinely-editable tab.
      if ((dto.orderType ?? 'dine_in') === 'dine_in' && dto.tableId) {
        const held = await tx.order.findFirst({
          where: { tableId: dto.tableId, orderType: 'dine_in', invoiceId: null, status: { in: TABLE_HELD_ORDER_STATUSES as any } },
          select: { id: true, orderNumber: true },
        });
        if (held) throw new ConflictException(`Table already has an open order (${held.orderNumber})`);
      }
      if (dto.cashSessionId) {
        await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', dto.cashSessionId, orgId);
        const session = await tx.cashSession.findFirst({ where: { id: dto.cashSessionId, organizationId: orgId } });
        if (!session || session.status !== 'open') throw new BadRequestException('Select an open register session before creating an order');
      }
      const orderNumber = await this.nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          organizationId: orgId,
          orderNumber,
          clientOperationKey: businessOperation.getStore()?.key,
          orderType: dto.orderType ?? 'dine_in',
          status: 'confirmed',
          tableId: dto.tableId ?? null,
          partnerId,
          waiterId: dto.waiterId ?? this.tenant.userId ?? null,
          branchId: dto.branchId ?? null,
          cashSessionId: dto.cashSessionId ?? null,
          guestCount: dto.guestCount ?? null,
          notes: dto.notes ?? null,
          createdBy: this.tenant.userId ?? null,
        },
      });
      if (resolved.length) await this.writeItems(tx, order.id, resolved, dto);
      await this.syncTableOnOpen(tx, dto.tableId);
      const fresh = await this.reload(tx, order.id);
      await recordBusinessOutcome(tx, { orderId: order.id, orderNumber });
      this.events.publish(EVENTS.PosOrderCreated, {
        organizationId: orgId, orderId: order.id, orderNumber, tableId: dto.tableId,
      });
      await this.audit.recordInTx(tx, {
        entity: 'Order', entityId: order.id, action: 'create',
        newValues: { orderNumber, tableId: dto.tableId ?? null, lineCount: resolved.length },
      });
      return fresh;
    });
  }

  /**
   * Bridge: create an order from already-resolved/priced lines — no modifier
   * re-validation or price folding (the unitPrice is taken as-is). Used to
   * migrate a legacy draft-`Document` tab into the Order→Invoice pipeline at
   * settle time, where the lines were already validated when added to the tab.
   */
  async createOrderFromResolved(input: {
    orderType?: 'dine_in' | 'takeaway' | 'delivery';
    tableId?: string;
    partnerId?: string;
    cashSessionId?: string;
    branchId?: string;
    guestCount?: number;
    lines: Array<{
      productId?: string | null;
      menuItemId?: string | null;
      variantId?: string;
      variantName?: string;
      description: string;
      quantity: number;
      unitPrice: number;
      taxId?: string | null;
      discountPercent?: number;
      discountType?: 'percentage' | 'fixed_amount';
      discountAmount?: number;
      discountReason?: string | null;
      taxInclusive?: boolean;
      note?: string | null;
      accompanimentNames?: string[];
      accompanimentOptionIds?: string[];
      modifiers?: Array<{ modifierId: string; name: string; priceDelta: number }>;
      course?: number | null;
    }>;
  }, externalTx?: any) {
    const orgId = this.tenant.organizationId;
    const partnerId = input.partnerId ?? (await this.ensureWalkInCustomer(orgId));
    const resolved: ResolvedLine[] = input.lines.map((l) => ({
      productId: l.productId ?? null,
      menuItemId: l.menuItemId ?? null,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxId: l.taxId ?? null,
      discountPercent: l.discountPercent ?? 0,
      discountType: l.discountType,
      discountAmount: l.discountAmount,
      discountReason: l.discountReason ?? null,
      note: l.note ?? null,
      taxInclusive: l.taxInclusive,
      modifiers: l.modifiers ?? [],
      accompanimentNames: l.accompanimentNames ?? [],
      accompanimentOptionIds: l.accompanimentOptionIds ?? [],
      variantId: l.variantId ?? undefined,
      variantName: l.variantName ?? undefined,
      station: 'cafe',
      course: l.course ?? null,
    }));
    const run = async (tx: any) => {
      const orderNumber = await this.nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          organizationId: orgId,
          orderNumber,
          orderType: input.orderType ?? 'dine_in',
          status: 'confirmed',
          tableId: input.tableId ?? null,
          partnerId,
          waiterId: this.tenant.userId ?? null,
          branchId: input.branchId ?? null,
          cashSessionId: input.cashSessionId ?? null,
          guestCount: input.guestCount ?? null,
          createdBy: this.tenant.userId ?? null,
        },
      });
      if (resolved.length) await this.writeItems(tx, order.id, resolved);
      await this.syncTableOnOpen(tx, input.tableId);
      const fresh = await this.reload(tx, order.id);
      this.events.publish(EVENTS.PosOrderCreated, { organizationId: orgId, orderId: order.id, orderNumber, tableId: input.tableId });
      return fresh;
    };
    return externalTx ? run(externalTx) : this.prisma.client.$transaction(run);
  }

  /** Auto-save: replace the order's item set with EXACTLY these lines. */
  async saveItems(orderId: string, dto: SaveOrderItemsDto) {
    const orgId = this.tenant.organizationId;
    const bypassRequired = dto.overrideById ? await this.assertOverride(dto.overrideById) : false;
    if (dto.lines?.length) await this.validateLines(dto.lines, bypassRequired);
    const resolved = dto.lines?.length ? await this.resolveLines(dto.lines) : [];

    const saved = await this.prisma.client.$transaction(async (tx: any) => {
      const order = await this.lockOrder(tx, orderId);
      this.assertEditable(order);
      this.assertVersion(order, dto.expectedVersion);
      await this.writeItems(tx, orderId, resolved, { ...dto, replace: true });
      if (dto.guestCount != null || dto.partnerId) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            ...(dto.guestCount != null ? { guestCount: dto.guestCount } : {}),
            ...(dto.partnerId ? { partnerId: dto.partnerId } : {}),
          },
        });
      }
      // Deleting the last item (resolved = []) frees the table; adding the first
      // one occupies it. Derived from the item count in the same tx.
      await recomputeTableStatus(tx, order.tableId);
      const fresh = await this.reload(tx, orderId);
      this.events.publish(EVENTS.PosOrderUpdated, { organizationId: orgId, orderId, version: fresh.version });
      return fresh;
    });
    await this.autoSendRoutedLines(orderId);
    return saved;
  }

  /**
   * Auto-send: push un-fired lines that are pinned to a prep station
   * (`MenuItem.stationCode`) to the KDS, so configuring a station is all it
   * takes for an ordered item to appear on the kitchen board. Lines with no
   * station configured are left for the explicit "Send to Kitchen" action.
   *
   * Best-effort — the kitchen display must never fail a sale — and delta-based,
   * so re-running it sends nothing new.
   */
  async autoSendRoutedLines(orderId: string) {
    try {
      return await this.fireKitchen(orderId, { onlyRouted: true });
    } catch (e: any) {
      this.logger.warn(`auto-send to KDS failed for order ${orderId}: ${String(e?.message ?? e)}`);
      return null;
    }
  }

  /** Append a round of items to an order (creates none — order must exist). */
  async addItems(orderId: string, dto: AddOrderItemsDto) {
    const orgId = this.tenant.organizationId;
    const bypassRequired = dto.overrideById ? await this.assertOverride(dto.overrideById) : false;
    await this.validateLines(dto.lines, bypassRequired);
    const resolved = await this.resolveLines(dto.lines);

    const result = await this.prisma.client.$transaction(async (tx: any) => {
      const order = await this.lockOrder(tx, orderId);
      this.assertEditable(order);
      await this.writeItems(tx, orderId, resolved, { append: true, transactionDiscountPercent: dto.transactionDiscountPercent });
      if (dto.guestCount != null) await tx.order.update({ where: { id: orderId }, data: { guestCount: dto.guestCount } });
      await recomputeTableStatus(tx, order.tableId);
      return this.reload(tx, orderId);
    });

    if (dto.sendToKitchen) {
      await this.fireKitchen(orderId).catch((e) => this.logger.warn(`addItems fire-kitchen failed: ${String(e?.message ?? e)}`));
    } else {
      await this.autoSendRoutedLines(orderId);
    }
    return result;
  }

  /** Cancel the whole order (only while un-billed). */
  async cancelOrder(orderId: string, reason?: string, expectedVersion?: number) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.invoiceId) throw new ConflictException('Order already billed — refund/void the invoice instead');
      if (order.status === 'cancelled' || order.status === 'closed') return order;
      if (expectedVersion != null) this.assertVersion(order, expectedVersion);
      // The engine validates the transition and writes status + cancelledAt/By,
      // the AuditLog row and the domain event (ADR-007). Domain-specific columns
      // it does not know about are written after it, on the same tx.
      await this.workflows.transition({
        entityType: 'order', entityId: orderId, action: 'cancel',
        entity: order, payload: { reason: reason ?? null }, externalTx: tx,
      });
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { cancelReason: reason ?? null, version: { increment: 1 } },
      });
      await this.syncTableOnClose(tx, order.tableId);
      this.events.publish(EVENTS.PosOrderCancelled, { organizationId: orgId, orderId, reason });
      await this.audit.recordInTx(tx, { entity: 'Order', entityId: orderId, action: 'cancel', newValues: { reason: reason ?? null } });
      return updated;
    });
  }

  /** Reopen a cancelled order (un-billed only). */
  async reopenOrder(orderId: string) {
    return this.prisma.client.$transaction(async (tx: any) => {
      const order = await this.lockOrder(tx, orderId);
      if (order.invoiceId) throw new ConflictException('Billed orders cannot be reopened');
      if (order.status !== 'cancelled') throw new BadRequestException('Only a cancelled order can be reopened');
      await this.workflows.transition({
        entityType: 'order', entityId: orderId, action: 'reopen', entity: order, externalTx: tx,
      });
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { cancelledAt: null, cancelReason: null, cancelledBy: null, version: { increment: 1 } },
      });
      await this.syncTableOnOpen(tx, order.tableId);
      return updated;
    });
  }

  /** Move an open order to another table. */
  async moveTable(orderId: string, targetTableId: string) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const order = await this.lockOrder(tx, orderId);
      this.assertEditable(order);
      const target = await tx.posTable.findFirst({ where: { id: targetTableId, organizationId: orgId } });
      if (!target) throw new NotFoundException('Target table not found');
      if (target.status === 'out_of_service') throw new ConflictException('Target table is out of service');
      const sourceTableId = order.tableId;
      const updated = await tx.order.update({ where: { id: orderId }, data: { tableId: targetTableId, version: { increment: 1 } } });
      await this.syncTableOnClose(tx, sourceTableId);
      await this.syncTableOnOpen(tx, targetTableId);
      await this.audit.recordInTx(tx, { entity: 'Order', entityId: orderId, action: 'transfer', newValues: { from: sourceTableId, to: targetTableId } });
      return updated;
    });
  }

  /** Merge a source order's items into this (target) order; source is cancelled. */
  async mergeOrders(targetOrderId: string, sourceOrderId: string) {
    if (targetOrderId === sourceOrderId) throw new BadRequestException('Cannot merge an order into itself');
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const target = await this.lockOrder(tx, targetOrderId);
      const source = await this.lockOrder(tx, sourceOrderId);
      this.assertEditable(target);
      this.assertEditable(source);
      const srcItems = await tx.orderItem.findMany({
        where: { orderId: sourceOrderId, cancelled: false }, include: { modifiers: true }, orderBy: { lineNumber: 'asc' },
      });
      const tgtItems = await tx.orderItem.findMany({
        where: { orderId: targetOrderId, cancelled: false }, include: { modifiers: true }, orderBy: { lineNumber: 'asc' },
      });
      const merged: ResolvedLine[] = [...tgtItems, ...srcItems].map((it: any) => this.itemToResolved(it));
      await this.writeItems(tx, targetOrderId, merged, { replace: true });
      // `supersede`, not `cancel`: this route is gated on `tables:merge`, so the
      // transition must not additionally demand `pos:checkout`.
      await this.workflows.transition({
        entityType: 'order', entityId: sourceOrderId, action: 'supersede',
        entity: source, payload: { mergedInto: targetOrderId }, externalTx: tx,
      });
      await tx.order.update({
        where: { id: sourceOrderId },
        data: { cancelReason: `Merged into ${target.orderNumber}`, version: { increment: 1 } },
      });
      await this.syncTableOnClose(tx, source.tableId);
      await this.audit.recordInTx(tx, { entity: 'Order', entityId: targetOrderId, action: 'merge' as any, newValues: { sourceOrderId } });
      return this.reload(tx, targetOrderId);
    });
  }

  // ─── Kitchen (KOT) ───────────────────────────────────────────────────────────

  /**
   * Fire the order's un-printed item quantities (delta) to the KDS, one ticket
   * per station. Marks each item sent so re-firing only sends genuinely new qty.
   *
   * `opts.onlyRouted` restricts the fire to lines whose MenuItem carries an
   * explicit `stationCode`. That is what auto-send uses: an item configured with
   * a prep station reaches the KDS the moment it is ordered, while everything
   * else still waits for the cashier to press "Send to Kitchen".
   */
  async fireKitchen(orderId: string, opts: { course?: number | null; onlyRouted?: boolean } = {}) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.order.findFirst({ where: { id: orderId, organizationId: orgId } });
    if (!order) throw new NotFoundException('Order not found');

    const stationCache = new Map<string, string>();
    const prepCache = new Map<string, number | null>();

    // F11 — ticket creation AND the sent-counter bump commit together, fronted by
    // a FOR UPDATE lock on the order row. Two concurrent sends serialise: the
    // second re-reads the just-updated printed quantities inside the tx, sees
    // delta 0, and dispatches nothing. A crash between the two writes rolls both
    // back, so a retry recomputes the correct delta — dispatch is exactly-once.
    const result = await this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT id FROM "Order" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', orderId, orgId);
      const items = await tx.orderItem.findMany({
        where: { orderId, cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true },
      });

      const deltas: Array<{ item: any; delta: number }> = [];
      for (const it of items as any[]) {
        // A line reaches the kitchen if it maps to EITHER a stock product or a menu
        // item. Menu items carry `menuItemId` only (no single `productId`), so the
        // old `if (!it.productId) continue` silently dropped every menu-driven order
        // — the kitchen never saw it. Only lines with neither id are skipped.
        if (!it.productId && !it.menuItemId) continue;
        // P5 — "Fire course": when a course is given, only fire that course's lines
        // (leave earlier/later courses held). Uncoursed lines always fire.
        if (opts.course != null && it.course != null && it.course !== opts.course) continue;
        // Auto-send pass: only lines explicitly pinned to a station.
        if (opts.onlyRouted && !(await this.explicitStationFor(it, stationCache))) continue;
        const printed = Number(it.kitchenPrintedQty ?? 0);
        const delta = Number(it.quantity) - printed;
        if (delta > 0) deltas.push({ item: it, delta });
      }
      if (deltas.length === 0) return { ticketIds: [], deltas: [] as Array<{ item: any; delta: number }> };

      const kdsItems: Array<Record<string, any>> = [];
      for (const { item, delta } of deltas) {
        kdsItems.push({
          productId: item.productId ?? item.menuItemId,
          productName: item.description,
          quantity: delta,
          // Include the kitchen print name so the KDS shows the kitchen-facing
          // modifier label (parity with the pre-payment send-to-kitchen path).
          modifiers: (item.modifiers ?? []).map((m: any) => ({ name: m.name, kitchenPrintName: m.kitchenPrintName ?? null, priceDelta: Number(m.priceDelta) })),
          notes: item.note ?? null,
          station: await this.stationForOrderItem(item, stationCache),
          variantName: item.variantName ?? undefined,
          accompanimentNames: item.accompanimentNames ?? [],
          prepTime: await this.prepTimeForItem(item, prepCache),
          course: item.course ?? null,
        });
      }

      const ticketIds = await this.kds.createTicketsForSale({
        orderId,
        label: order.orderNumber,
        orderType: order.orderType,
        items: kdsItems as any,
      }, tx);

      const now = new Date();
      for (const { item } of deltas) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            kitchenPrintedQty: item.quantity,
            kitchenStatus: 'sent',
            kitchenPrintCount: { increment: 1 },
            kitchenLastPrintedAt: now,
            lastKitchenPrintedById: this.tenant.userId ?? null,
          },
        });
      }
      return { ticketIds, deltas };
    });

    if (result.deltas.length === 0) return { ticketIds: [], count: 0, message: 'No new items to send' };
    const { ticketIds, deltas } = result;

    // Firing the kitchen is the first fulfillment activity on the order.
    // (`open` is the legacy alias of `confirmed` — accepted during the Android
    // wire-compat window.) The transition emits `order.fulfillment_started`;
    // the former `Order.kitchenStartedAt/By` write is gone (zero readers, and
    // the milestone projection now serves the kitchen timeline — Phase B).
    if (order.status === 'confirmed' || order.status === 'open') {
      await this.workflows.transition({
        entityType: 'order', entityId: orderId, action: 'start_fulfillment', entity: order,
      });
    }
    await this.audit.record({ entity: 'Order', entityId: orderId, action: 'update' as any, newValues: { kind: 'fire_kitchen', tickets: ticketIds.length } });

    // Paper KOT on the thermal printer mirrors the KDS ticket. Best-effort —
    // printKotPaper never throws, so the fire succeeds even with the printer off.
    const paper = await this.receipts.printKotPaper(
      orderId,
      deltas.map(({ item, delta }) => ({ line: item, delta })),
    );

    return { ticketIds, count: ticketIds.length, paperKot: paper.backend, kotNumber: paper.kotNumber };
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  /** ORD-YYYYMMDD-NNNNNN. Date-keyed sequence so each day restarts at 1. */
  private async nextOrderNumber(tx: any): Promise<string> {
    const d = new Date();
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return this.sequence.next(`order:${ymd}`, { prefix: `ORD-${ymd}-`, padding: 6 }, tx);
  }

  /**
   * Resolve the KDS/kitchen station CODE for an order line. Precedence:
   *   1. MenuItem.stationCode override (explicit, wins),
   *   2. stock-product line → Product.station,
   *   3. menu-item line → primary station across the recipe's products,
   *   4. the org's default KitchenStation (fallback).
   * Codes are configurable per org (KitchenStation table). Results are cached
   * per invocation to avoid N+1 lookups.
   */
  private async stationForOrderItem(
    it: any,
    cache: Map<string, string>,
  ): Promise<string> {
    // 1. Explicit menu-item override.
    const override = await this.explicitStationFor(it, cache);
    if (override) return override;
    // 2. Stock product line.
    if (it.productId) {
      const key = `p:${it.productId}`;
      if (cache.has(key)) return cache.get(key)!;
      const p = await this.prisma.client.product.findFirst({ where: { id: it.productId }, select: { station: true } });
      const st = ((p as any)?.station || (await this.defaultStationCode(cache)));
      cache.set(key, st);
      return st;
    }
    // 3. Menu-item line derives from the recipe.
    if (it.menuItemId) {
      const key = `m:${it.menuItemId}`;
      if (cache.has(key)) return cache.get(key)!;
      const recipe = await this.prisma.client.menuProduct.findMany({
        where: { menuItemId: it.menuItemId, organizationId: this.tenant.organizationId },
        include: { product: { select: { station: true } } },
      });
      const stations = (recipe as any[]).map((r) => (r.product?.station ?? '') as string).filter(Boolean);
      const st = stations.length ? this.pickPrimaryStation(stations) : await this.defaultStationCode(cache);
      cache.set(key, st);
      return st;
    }
    return this.defaultStationCode(cache);
  }

  /**
   * The station a line is explicitly pinned to via `MenuItem.stationCode`, or ''
   * when it has none (then routing derives from the recipe / product / default).
   * Cached per pass under the same key `stationForOrderItem` uses.
   */
  private async explicitStationFor(it: any, cache: Map<string, string>): Promise<string> {
    if (!it.menuItemId) return '';
    const key = `mo:${it.menuItemId}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const mi = await this.prisma.client.menuItem.findFirst({ where: { id: it.menuItemId }, select: { stationCode: true } });
    const code = ((mi as any)?.stationCode ?? '') as string;
    cache.set(key, code);
    return code;
  }

  /** The org's default KitchenStation code (routing fallback). Cached per pass. */
  private async defaultStationCode(cache: Map<string, string>): Promise<string> {
    const k = '__default__';
    const cached = cache.get(k);
    if (cached !== undefined) return cached;
    // Wrap in the tenant transaction so app.org_id is set — the KitchenStation
    // tenant-isolation policy then resolves the default whether RLS is on or off.
    const def = await this.prisma.client.$transaction((tx: any) =>
      tx.kitchenStation.findFirst({ where: { isDefault: true }, select: { code: true } }));
    const code = ((def as any)?.code ?? 'cafe') as string;
    cache.set(k, code);
    return code;
  }

  /** Most-common station code across a menu item's recipe; ties → first seen. */
  private pickPrimaryStation(stations: string[]): string {
    if (!stations.length) return 'cafe';
    const counts = new Map<string, number>();
    for (const s of stations) counts.set(s, (counts.get(s) ?? 0) + 1);
    let best = stations[0];
    let bestCount = -1;
    for (const [s, c] of counts) {
      if (c > bestCount) { best = s; bestCount = c; }
    }
    return best;
  }

  /** Prep-time hint (minutes) for a menu-item line, for KDS expected-ready. */
  private async prepTimeForItem(it: any, cache: Map<string, number | null>): Promise<number | null> {
    if (!it.menuItemId) return null;
    if (cache.has(it.menuItemId)) return cache.get(it.menuItemId)!;
    const mi = await this.prisma.client.menuItem.findFirst({ where: { id: it.menuItemId }, select: { preparationTime: true } });
    const t = ((mi as any)?.preparationTime ?? null) as number | null;
    cache.set(it.menuItemId, t);
    return t;
  }

  /** Resolve a menu item's configured tax category (H4). Cached per resolve pass. */
  private async menuItemTaxId(menuItemId: string, cache: Map<string, string | null>): Promise<string | null> {
    if (cache.has(menuItemId)) return cache.get(menuItemId)!;
    const mi = await this.prisma.client.menuItem.findFirst({
      where: { id: menuItemId, organizationId: this.tenant.organizationId },
      select: { taxId: true },
    });
    const taxId = (mi as any)?.taxId ?? null;
    cache.set(menuItemId, taxId);
    return taxId;
  }

  /** Validate variant + accompaniment + modifier rules server-side before pricing. */
  private async validateLines(lines: OrderLineDto[], bypassRequired = false): Promise<void> {
    for (const ln of lines) {
      if (ln.variantId && ln.menuItemId) await this.variants.validateVariant(ln.menuItemId, ln.variantId);
      if (ln.menuItemId) await this.accompaniments.validateSelections(ln.menuItemId, ln.accompanimentOptionIds ?? [], bypassRequired);
    }
    await this.modifiers.validateSelections(lines as any, bypassRequired);
  }

  /** Assert that the override user has pos:override permission. Returns true if override is valid. */
  private async assertOverride(overrideById: string): Promise<boolean> {
    if (businessOperation.getStore()?.approvedById !== overrideById && overrideById !== this.tenant.userId) throw new ForbiddenException('An authenticated manager approval is required');
    const user = await this.prisma.client.user.findFirst({
      where: { id: overrideById, organizationId: this.tenant.organizationId, deletedAt: null },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException('Override user not found');
    const perms = new Set<string>();
    for (const role of (user as any).roles) {
      for (const p of (role as any).permissions ?? []) perms.add(p);
    }
    if (!perms.has('pos:override')) {
      throw new ForbiddenException('User does not have pos:override permission');
    }
    return true;
  }

  /** Resolve cart lines into ledger-ready lines (folds variant/accompaniment/modifier into unitPrice, expands combos). */
  private async resolveLines(inputLines: OrderLineDto[]): Promise<ResolvedLine[]> {
    const orgId = this.tenant.organizationId;
    const skuMap = await this.resolveSkus(inputLines);
    const productStationCache = new Map<string, 'bar' | 'kitchen' | 'cafe'>();
    const stationFor = async (productId: string | null): Promise<'bar' | 'kitchen' | 'cafe'> => {
      if (!productId) return 'cafe';
      if (productStationCache.has(productId)) return productStationCache.get(productId)!;
      const p = await this.prisma.client.product.findFirst({ where: { id: productId }, select: { station: true } });
      const st = ((p as any)?.station ?? 'cafe') as 'bar' | 'kitchen' | 'cafe';
      productStationCache.set(productId, st);
      return st;
    };

    const lines: ResolvedLine[] = [];
    for (const l of inputLines) {
      if (!Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0) throw new BadRequestException('Sale quantities must be positive');
      if (l.comboId) throw new BadRequestException('Combo selling is paused until component quantities and prices can be preserved through order editing. Sell the individual catalog items.');
      const productId = l.productId ?? skuMap.get(l.sku?.toLowerCase() ?? '') ?? null;
      const product = productId
        ? await this.prisma.client.product.findFirst({ where: { id: productId, organizationId: orgId, isActive: true } })
        : null;
      const menuItem = l.menuItemId
        ? await this.prisma.client.menuItem.findFirst({ where: { id: l.menuItemId, organizationId: orgId, isAvailable: true } })
        : null;
      // A line saved against a menu item that has since been removed (or
      // reseeded under a new id) must not brick the open order — fall back to
      // the line's own product when it is still sellable. Never block a sale.
      const menuItemId = menuItem ? l.menuItemId! : null;
      const catalog = menuItem ?? product;
      if (!catalog) throw new BadRequestException('A sale line must identify an available catalog item');
      // SECURITY: re-resolve each modifier's price from the DB (reject unknown
      // ids) rather than trusting the client-sent priceDelta. Mirrors how
      // variants/accompaniments are already server-resolved below.
      const resolvedMods = l.modifiers?.length
        ? await this.modifiers.resolveSelectedModifiers({
            menuItemId: menuItemId ?? undefined, productId: l.productId, modifierIds: l.modifiers.map((m) => m.modifierId),
          })
        : [];
      const modifierDelta = resolvedMods.reduce((s, m) => s + m.priceDelta, 0);
      let variantName: string | undefined;
      let variantPrice = 0;
      let hasVariant = false;
      if (l.variantId && menuItemId) {
        const v = await this.variants.validateVariant(menuItemId, l.variantId);
        variantName = v.name; variantPrice = v.price; hasVariant = true;
      }
      let accompanimentImpact = 0;
      let accompanimentNames: string[] = [];
      if (l.accompanimentOptionIds?.length && menuItemId) {
        // Resolution only — rule enforcement already ran in validateLines (with
        // the caller's override state). Re-running strict here would 400 an
        // override-approved save.
        const r = await this.accompaniments.validateSelections(menuItemId, l.accompanimentOptionIds, true);
        accompanimentImpact = r.priceImpact; accompanimentNames = r.names;
      }
      if (l.variantId && productId && !menuItemId) {
        const variant = await this.prisma.client.productVariant.findFirst({ where: { id: l.variantId, productId, organizationId: orgId, isActive: true, deletedAt: null } });
        if (!variant) throw new BadRequestException('Variant does not belong to this product');
        variantName = variant.name;
        if (variant.salesPrice != null) { variantPrice = Number(variant.salesPrice); hasVariant = true; }
      }
      const catalogPrice = menuItemId ? (catalog as any).basePrice : (catalog as any).salesPrice;
      if (!hasVariant && catalogPrice == null) throw new BadRequestException('Configure a catalog selling price before selling this item');
      const baseUnitPrice = hasVariant ? variantPrice : Number(catalogPrice);
      const finalUnitPrice = baseUnitPrice + accompanimentImpact + modifierDelta;
      if (!Number.isFinite(finalUnitPrice) || finalUnitPrice < 0) throw new BadRequestException('Catalog price must be finite and non-negative');
      const taxId = catalog.taxId ?? null;
      const tax = taxId ? await this.prisma.client.tax.findFirst({ where: { id: taxId } }) : null;
      const taxInclusive = menuItemId ? Boolean(tax?.isInclusive) : Boolean((catalog as any).taxInclusive);
      const noteParts = [l.note, ...accompanimentNames.map((n) => `+ ${n}`), ...resolvedMods.map((m) => `+ ${m.name}`)].filter(Boolean);
      lines.push({
        productId,
        menuItemId: menuItemId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: finalUnitPrice,
        taxId,
        discountPercent: l.discountPercent ?? 0,
        discountType: l.discountType,
        discountAmount: l.discountAmount,
        discountReason: l.discountReason ?? null,
        note: noteParts.length ? noteParts.join(' | ') : null,
        taxInclusive,
        modifiers: resolvedMods,
        variantId: l.variantId ?? undefined,
        variantName,
        accompanimentNames,
        accompanimentOptionIds: l.accompanimentOptionIds ?? [],
        station: await stationFor(productId),
        course: l.course ?? null,
      });
    }

    return lines;
  }

  /**
   * F10 — per-line kitchen identity for preserving the sent/printed lifecycle
   * across an auto-save replace. The old key was `productId` (or
   * `menuItemId|variant`) ONLY, so two lines of the same product with different
   * milk / notes / sides / course collapsed to one key: an unsent "oat latte"
   * inherited a sent "dairy latte"'s printed quantity, or an already-fired line
   * re-fired. The signature now covers the whole customization, and matching is
   * a one-to-one multiset consume (see `writeItems`), so two genuinely identical
   * lines each keep their own lifecycle row instead of sharing the last one.
   */
  private lineSignature(it: {
    productId?: string | null; menuItemId?: string | null; variantName?: string | null;
    description?: string | null; note?: string | null; course?: number | null;
    modifierIds?: (string | null)[]; accompanimentOptionIds?: string[];
  }): string {
    const base = it.productId ? `p:${it.productId}` : it.menuItemId ? `m:${it.menuItemId}` : `d:${it.description ?? ''}`;
    const mods = [...(it.modifierIds ?? [])].filter(Boolean).sort().join(',');
    const accs = [...(it.accompanimentOptionIds ?? [])].filter(Boolean).sort().join(',');
    return [base, it.variantName ?? '', it.course ?? '', (it.note ?? '').trim(), mods, accs].join('|');
  }

  /** Signature of a persisted OrderItem row (needs its modifiers loaded). */
  private rowSignature(row: any): string {
    return this.lineSignature({
      productId: row.productId, menuItemId: row.menuItemId, variantName: row.variantName,
      description: row.description, note: row.note, course: row.course,
      modifierIds: (row.modifiers ?? []).map((m: any) => m.modifierId),
      accompanimentOptionIds: row.accompanimentOptionIds ?? [],
    });
  }

  /** Signature of an incoming resolved line. */
  private resolvedSignature(l: ResolvedLine): string {
    return this.lineSignature({
      productId: l.productId, menuItemId: l.menuItemId, variantName: l.variantName,
      description: l.description, note: l.note, course: l.course,
      modifierIds: (l.modifiers ?? []).map((m) => m.modifierId),
      accompanimentOptionIds: l.accompanimentOptionIds ?? [],
    });
  }

  /** Map an existing OrderItem row back to a ResolvedLine (for merge). */
  private itemToResolved(it: any): ResolvedLine {
    return {
      productId: it.productId ?? null,
      menuItemId: it.menuItemId ?? null,
      description: it.description,
      quantity: Number(it.quantity),
      unitPrice: Number(it.unitPrice),
      taxId: it.taxId ?? null,
      discountPercent: Number(it.discountPercent ?? 0),
      discountType: it.discountType ?? undefined,
      discountAmount: it.discountAmount ? Number(it.discountAmount) : undefined,
      discountReason: it.discountReason ?? null,
      note: it.note ?? null,
      taxInclusive: it.taxInclusive,
      modifiers: (it.modifiers ?? []).map((m: any) => ({ modifierId: m.modifierId, name: m.name, priceDelta: Number(m.priceDelta) })),
      variantId: it.variantId ?? undefined,
      variantName: it.variantName ?? undefined,
      accompanimentNames: it.accompanimentNames ?? [],
      accompanimentOptionIds: it.accompanimentOptionIds ?? [],
      station: 'cafe',
      course: it.course ?? null,
    };
  }

  /**
   * Persist resolved lines as OrderItems and recompute the order header totals.
   * `replace` wipes existing items first (auto-save); `append` keeps them.
   * Kitchen lifecycle counters are preserved across a replace by productId.
   */
  private async writeItems(
    tx: any,
    orderId: string,
    resolved: ResolvedLine[],
    opts: { replace?: boolean; append?: boolean } & Partial<SaveOrderItemsDto> = {},
  ): Promise<void> {
    const orgId = this.tenant.organizationId;

    let baseline: ResolvedLine[] = [];
    // F10 — preserve each line's kitchen lifecycle across a replace/auto-save by
    // its full-customization signature, matched ONE-TO-ONE. Old rows sharing a
    // signature form a queue; each new line consumes at most one, so a second
    // identical line cannot inherit the first's sent quantity and two distinct
    // customizations of the same product never cross-contaminate.
    const lifecycleQueue = new Map<string, any[]>();
    const enqueue = (rows: any[]) => {
      for (const o of rows) {
        const sig = this.rowSignature(o);
        (lifecycleQueue.get(sig) ?? lifecycleQueue.set(sig, []).get(sig)!).push(o);
      }
    };
    if (opts.append) {
      const existing = await tx.orderItem.findMany({ where: { orderId, cancelled: false }, include: { modifiers: true }, orderBy: { lineNumber: 'asc' } });
      baseline = existing.map((it: any) => this.itemToResolved(it));
      // Preserve the already-fired kitchen state of existing lines across the append.
      enqueue(existing);
    } else if (opts.replace) {
      const old = await tx.orderItem.findMany({
        where: { orderId }, include: { modifiers: { select: { modifierId: true } } },
      });
      enqueue(old);
    }
    const all = [...baseline, ...resolved];

    // Price through the tax engine for authoritative subtotal/tax/total.
    const totals = await this.builder.prepareLines(tx, all.map((l) => ({
      productId: l.productId ?? undefined,
      menuItemId: l.menuItemId ?? undefined,
      variantId: l.variantId ?? undefined,
      variantName: l.variantName ?? undefined,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxId: l.taxId ?? undefined,
      discountPercent: l.discountPercent,
      discountType: l.discountType,
      discountAmount: l.discountAmount,
      discountReason: l.discountReason ?? undefined,
      discountSource: 'manual' as const,
      taxInclusive: l.taxInclusive,
    })));

    if (opts.replace || opts.append) {
      await tx.orderItem.deleteMany({ where: { orderId } });
    }

    for (let i = 0; i < totals.prepared.length; i++) {
      const p = totals.prepared[i];
      const src = all[i];
      // Consume one lifecycle row for this line's signature (F10). shift() makes
      // the match one-to-one: the next identical line gets the next row, or none.
      const lc = lifecycleQueue.get(this.resolvedSignature(src))?.shift();
      const item = await tx.orderItem.create({
        data: {
          organizationId: orgId,
          orderId,
          productId: p.productId,
          menuItemId: p.menuItemId,
          variantId: p.variantId ?? undefined,
          variantName: p.variantName ?? undefined,
          description: p.description,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          discountPercent: p.discountPercent,
          discountType: (p as any).discountType ?? 'percentage',
          discountAmount: (p as any).discountAmount ?? 0,
          discountReason: (p as any).discountReason ?? null,
          taxId: p.taxId,
          taxInclusive: p.taxInclusive,
          note: src?.note ?? null,
          accompanimentNames: src?.accompanimentNames ?? [],
          accompanimentOptionIds: src?.accompanimentOptionIds ?? [],
          course: src?.course ?? null,
          lineNumber: p.lineNumber,
          kitchenStatus: lc?.kitchenStatus ?? 'pending',
          kitchenPrintCount: lc?.kitchenPrintCount ?? 0,
          kitchenLastPrintedAt: lc?.kitchenLastPrintedAt ?? null,
          kitchenPrintedQty: lc?.kitchenPrintedQty ?? null,
          cancelPrintCount: lc?.cancelPrintCount ?? 0,
          cancelLastPrintedAt: lc?.cancelLastPrintedAt ?? null,
          lastKitchenPrintedById: lc?.lastKitchenPrintedById ?? null,
        },
      });
      const mods = src?.modifiers ?? [];
      if (mods.length) {
        await tx.orderItemModifier.createMany({
          data: mods.map((m) => ({ organizationId: orgId, orderItemId: item.id, modifierId: m.modifierId ?? null, name: m.name, kitchenPrintName: (m as any).kitchenPrintName ?? null, priceDelta: m.priceDelta })),
        });
      }
    }

    const header = await tx.order.findFirst({ where: { id: orderId, organizationId: orgId } });
    const pricing = all.length ? {
      transactionDiscountType: opts.transactionDiscountType ?? header.transactionDiscountType ?? 'percentage',
      transactionDiscountPercent: opts.transactionDiscountPercent ?? Number(header.transactionDiscountPercent ?? 0),
      transactionDiscountAmount: opts.transactionDiscountAmount ?? Number(header.transactionDiscountAmount ?? 0),
      discountReason: opts.discountReason ?? header.discountReason ?? null,
    } : { transactionDiscountType: 'percentage', transactionDiscountPercent: 0, transactionDiscountAmount: 0, discountReason: null };
    const discounted = await this.builder.prepareLines(tx, discountedLines(all, pricing));
    await tx.order.update({ where: { id: orderId }, data: {
      subtotal: discounted.subtotal, taxAmount: discounted.taxAmount, totalAmount: discounted.total,
      discountTotal: discounted.discountTotal, ...pricing, version: { increment: 1 },
    } });
  }

  private async reload(tx: any, orderId: string) {
    return tx.order.findFirst({
      where: { id: orderId },
      include: { items: { where: { cancelled: false }, orderBy: { lineNumber: 'asc' }, include: { modifiers: true } } },
    });
  }

  private async lockOrder(tx: any, orderId: string) {
    const orgId = this.tenant.organizationId;
    const header = await tx.order.findFirst({ where: { id: orderId, organizationId: orgId }, select: { cashSessionId: true } });
    if (header?.cashSessionId) {
      await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', header.cashSessionId, orgId);
      const session = await tx.cashSession.findFirst({ where: { id: header.cashSessionId, organizationId: orgId } });
      if (!session || session.status !== 'open') throw new ConflictException('The order belongs to a closed register session');
    }
    await tx.$queryRawUnsafe(`SELECT id FROM "Order" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`, orderId, orgId);
    const order = await tx.order.findFirst({ where: { id: orderId, organizationId: orgId } });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private assertEditable(order: any): void {
    if (order.invoiceId) throw new ConflictException('Order is already billed and cannot be edited');
    if (order.status === 'cancelled') throw new ConflictException('Order is cancelled');
    if (order.status === 'closed') throw new ConflictException('Order is closed');
  }

  private assertVersion(order: any, expected?: number): void {
    if (expected == null) throw new ConflictException('An order version is required before replacing saved items');
    if (order.version !== expected) {
      throw new ConflictException(`Order was modified by someone else (expected v${expected}, found v${order.version}). Reload and retry.`);
    }
  }

  // Table status is derived from active order items — one invariant, one helper.
  // Both names are kept for call-site clarity but delegate to the same recompute.
  private async syncTableOnOpen(tx: any, tableId?: string | null): Promise<void> {
    await recomputeTableStatus(tx, tableId);
  }

  private async syncTableOnClose(tx: any, tableId?: string | null): Promise<void> {
    await recomputeTableStatus(tx, tableId);
  }

  private async resolveSkus(lines: OrderLineDto[]): Promise<Map<string, string>> {
    const skus = Array.from(new Set(lines.filter((l) => !l.productId && l.sku).map((l) => l.sku!.toLowerCase())));
    if (skus.length === 0) return new Map();
    const products = await this.prisma.client.product.findMany({
      where: { organizationId: this.tenant.organizationId, isActive: true, OR: [{ sku: { in: skus, mode: 'insensitive' } }, { code: { in: skus, mode: 'insensitive' } }] },
      select: { id: true, sku: true, code: true },
    });
    const map = new Map<string, string>();
    for (const p of products) {
      if (p.sku) map.set(p.sku.toLowerCase(), p.id);
      if (p.code) map.set(p.code.toLowerCase(), p.id);
    }
    return map;
  }

  private async ensureWalkInCustomer(orgId: string): Promise<string> {
    const existing = await this.prisma.client.partner.findFirst({ where: { organizationId: orgId, code: 'WALKIN' } });
    if (existing) return existing.id;
    const created = await this.prisma.client.partner.create({
      data: { organizationId: orgId, code: 'WALKIN', name: 'Walk-in Customer', isCustomer: true, isCompany: false },
    });
    return created.id;
  }
}
