/**
 * POS Phase T1 — Tables Management (ADR-012).
 *
 * A PosTable is a physical seat (e.g. "Table 7 / VIP 01"). It carries
 * lifecycle metadata (status, seats, zone, layout geometry) and is linked
 * to:
 *   - `PosTableOrder`        — the live Document being rung up on it
 *   - `PosTableReservation`  — a booking for a future time window
 *
 * Money still flows through `Document` / `Payment` / `KitchenTicket`. These
 * three PosTable* tables are operational metadata only and never hold
 * monetary amounts.
 *
 * Concurrency: every status-changing endpoint runs in a Prisma transaction
 * with a row-level `SELECT … FOR UPDATE` lock on the table so concurrent
 * merge / transfer / seat calls cannot race. Conflicts return 409.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { EventBus } from '../../kernel/events/event-bus';
import { DocumentBuilderService } from '../invoicing/document/document-builder.service';
import { EVENTS } from '@erp/shared';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export interface CreateTableDto {
  name: string;
  number: number;
  seats?: number;
  zone?: 'indoor' | 'outdoor' | 'terrace' | 'vip' | 'garden' | 'bar' | 'custom';
  customZone?: string;
  shape?: 'square' | 'rectangle' | 'circle';
  posX?: number;
  posY?: number;
  width?: number;
  height?: number;
  notes?: string;
  active?: boolean;
  assignedWaiterId?: string;
}

export interface UpdateTableDto extends Partial<CreateTableDto> {}

export interface SetStatusDto {
  status: 'available' | 'occupied' | 'reserved' | 'dirty' | 'out_of_service';
  reason?: string;
}

export interface AssignWaiterDto {
  waiterId: string | null;
}

@Injectable()
export class PosTablesService {
  private readonly logger = new Logger('PosTablesService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly builder: DocumentBuilderService,
  ) {}

  /**
   * Sync table status based on open orders count - single source of truth.
   * - open orders > 0 → occupied
   * - open orders = 0 → available
   * out_of_service is preserved (admin override).
   * Called in same transaction as order create/close.
   */
  async syncTableStatus(
    tableId: string,
    tx: any = this.prisma.client,
  ): Promise<'available' | 'occupied' | 'reserved' | 'out_of_service'> {
    const openCount = await tx.posTableOrder.count({
      where: { tableId, closedAt: null },
    });

    const table = await tx.posTable.findFirst({ where: { id: tableId } });
    if (!table) throw new NotFoundException('Table not found');
    if (table.status === 'out_of_service') return table.status;

    const nextStatus = openCount > 0 ? 'occupied' : 'available';
    if (table.status !== nextStatus) {
      await tx.posTable.update({
        where: { id: tableId },
        data: { status: nextStatus as any },
      });
    }
    return nextStatus as any;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  async list(filter: { status?: string; zone?: string; active?: boolean } = {}) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.posTable.findMany({
      where: {
        organizationId,
        ...(filter.status ? { status: filter.status as any } : {}),
        ...(filter.zone ? { zone: filter.zone as any } : {}),
        ...(filter.active === undefined ? {} : { active: filter.active }),
      },
      orderBy: [{ number: 'asc' }, { name: 'asc' }],
      include: {
        orders: {
          where: { closedAt: null },
          include: { document: { select: { id: true, documentNumber: true, totalAmount: true, status: true } } },
        },
        reservations: {
          where: { status: { in: ['pending', 'seated'] } },
          orderBy: { startAt: 'asc' },
        },
      },
    });
  }

  async get(id: string) {
    const organizationId = this.tenant.organizationId;
    const table = await this.prisma.client.posTable.findFirst({
      where: { id, organizationId },
      include: {
        orders: {
          orderBy: { openedAt: 'desc' },
          take: 50,
          include: {
            document: {
              select: {
                id: true,
                documentNumber: true,
                totalAmount: true,
                status: true,
                createdAt: true,
              },
            },
          },
        },
        reservations: {
          orderBy: { startAt: 'desc' },
          take: 50,
        },
        mergedInto: { select: { id: true, number: true, name: true } },
      },
    });
    if (!table) throw new NotFoundException('Table not found');
    return table;
  }

  /** Aggregate counters used by the terminal top bar. */
  async stats() {
    const organizationId = this.tenant.organizationId;
    const groups = await this.prisma.client.posTable.groupBy({
      by: ['status'],
      where: { organizationId, active: true },
      _count: { _all: true },
    });
    const out: Record<string, number> = {
      total: 0,
      available: 0,
      occupied: 0,
      reserved: 0,
      out_of_service: 0,
    };
    for (const g of groups) {
      out.total += g._count._all;
      out[g.status] = g._count._all;
    }
    const denom = out.total - out.out_of_service;
    out.occupancyPct = denom > 0 ? Math.round(((out.occupied + out.reserved) / denom) * 100) : 0;
    return out;
  }

  // ─── Mutations ───────────────────────────────────────────────────────────

  async create(dto: CreateTableDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.name?.trim()) throw new BadRequestException('Table name is required');
    if (!Number.isInteger(dto.number)) throw new BadRequestException('Table number is required');
    try {
      const created = await this.prisma.client.$transaction(async (tx: any) => {
        const t = await tx.posTable.create({
          data: {
            name: dto.name.trim(),
            number: dto.number,
            seats: dto.seats ?? 2,
            zone: dto.zone ?? 'indoor',
            customZone: dto.customZone ?? null,
            shape: dto.shape ?? 'square',
            posX: dto.posX ?? 40,
            posY: dto.posY ?? 40,
            width: dto.width ?? 120,
            height: dto.height ?? 120,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
            assignedWaiterId: dto.assignedWaiterId ?? null,
          },
        });
        await this.audit.recordInTx(tx, {
          entity: 'PosTable',
          entityId: t.id,
          action: 'create',
          newValues: { name: t.name, number: t.number, zone: t.zone, seats: t.seats },
        });
        return t;
      });
      this.events.publish(EVENTS.PosTableCreated, {
        organizationId,
        tableId: created.id,
        number: created.number,
        name: created.name,
      });
      return created;
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Table number ${dto.number} already exists`);
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateTableDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const existing = await tx.posTable.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundException('Table not found');
      const changes: Record<string, unknown> = {};
      const fields: (keyof UpdateTableDto)[] = [
        'name', 'seats', 'zone', 'customZone', 'shape',
        'posX', 'posY', 'width', 'height', 'notes', 'active',
        'assignedWaiterId',
      ];
      for (const f of fields) {
        if (dto[f] !== undefined && (existing as any)[f] !== dto[f]) {
          changes[f as string] = { from: (existing as any)[f], to: dto[f] };
        }
      }
      const updated = await tx.posTable.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
          ...(dto.zone !== undefined ? { zone: dto.zone } : {}),
          ...(dto.customZone !== undefined ? { customZone: dto.customZone } : {}),
          ...(dto.shape !== undefined ? { shape: dto.shape } : {}),
          ...(dto.posX !== undefined ? { posX: dto.posX } : {}),
          ...(dto.posY !== undefined ? { posY: dto.posY } : {}),
          ...(dto.width !== undefined ? { width: dto.width } : {}),
          ...(dto.height !== undefined ? { height: dto.height } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.assignedWaiterId !== undefined ? { assignedWaiterId: dto.assignedWaiterId } : {}),
        },
      });
      if (Object.keys(changes).length > 0) {
        await this.audit.recordInTx(tx, {
          entity: 'PosTable',
          entityId: id,
          action: 'update',
          oldValues: { ...changes },
          newValues: { updatedBy: userId ?? null },
        });
      }
      return updated;
    }).then(async (updated) => {
      this.events.publish(EVENTS.PosTableUpdated, {
        organizationId,
        tableId: id,
        changes: { name: dto.name, seats: dto.seats },
      });
      return updated;
    });
  }

  /** Soft-archive a table. Refused if it has open PosTableOrder rows. */
  async archive(id: string) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const existing = await tx.posTable.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundException('Table not found');
      const open = await tx.posTableOrder.count({
        where: { tableId: id, closedAt: null },
      });
      if (open > 0) {
        throw new ConflictException(
          `Cannot archive table ${existing.number}: ${open} open order(s)`,
        );
      }
      const updated = await tx.posTable.update({
        where: { id },
        data: { active: false },
      });
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: id,
        action: 'delete',
        newValues: { active: false },
      });
      return updated;
    }).then((t) => {
      this.events.publish(EVENTS.PosTableDeleted, { organizationId, tableId: id });
      return t;
    });
  }

  /**
   * Manual status flip. Used for "mark dirty → cleaned", "out of service",
   * etc. Lifecycle transitions that involve money (open a sale → OCCUPIED,
   * payment posted → DIRTY) are driven by the sales flow, not this method.
   */
  async setStatus(id: string, dto: SetStatusDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      // Acquire a row-level lock so concurrent transfers/merges can't race.
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        id,
        organizationId,
      );
      const existing = await tx.posTable.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundException('Table not found');
      const updated = await tx.posTable.update({
        where: { id },
        data: { status: dto.status as any },
      });
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: id,
        action: 'update',
        oldValues: { status: existing.status },
        newValues: { status: dto.status, reason: dto.reason ?? null },
      });
      return { previous: existing.status, current: updated };
    }).then(({ previous, current }) => {
      this.events.publish(EVENTS.PosTableStatusChanged, {
        organizationId,
        tableId: id,
        from: previous,
        to: current.status,
        reason: dto.reason,
      });
      return current;
    });
  }

  async assignWaiter(id: string, dto: AssignWaiterDto) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const existing = await tx.posTable.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundException('Table not found');
      const updated = await tx.posTable.update({
        where: { id },
        data: { assignedWaiterId: dto.waiterId },
      });
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: id,
        action: 'update',
        oldValues: { assignedWaiterId: existing.assignedWaiterId },
        newValues: { assignedWaiterId: dto.waiterId },
      });
      return updated;
    });
  }

  // ─── Merge / Transfer (Hard Move) ────────────────────────────────────────

  /**
   * Merge `sourceId` into `targetId`. Hard move:
   *   1. Acquire FOR UPDATE on both rows.
   *   2. Reassign all open `PosTableOrder.documentId` from source → target.
   *   3. Update `Document.tableId` for each affected doc.
   *   4. Source becomes AVAILABLE with `mergedIntoId=targetId`; target keeps
   *      OCCUPIED status if it was occupied, otherwise becomes OCCUPIED if
   *      the merged-in sale brought items.
   *   5. Audit + event.
   *
   * The whole operation is one transaction — partial failure leaves no
   * inconsistent state. Source `mergedFrom` rows (other tables merged into
   * the source) cascade the reassignment.
   */
  async merge(sourceId: string, targetId: string) {
    if (sourceId === targetId) {
      throw new BadRequestException('A table cannot be merged into itself');
    }
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      // Lock both rows. Always lock the lower id first to avoid deadlock.
      const first = sourceId < targetId ? sourceId : targetId;
      const second = first === sourceId ? targetId : sourceId;
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = ANY($1::uuid[]) AND "organizationId" = $2 ORDER BY id FOR UPDATE`,
        [first, second],
        organizationId,
      );
      const source = await tx.posTable.findFirst({ where: { id: sourceId, organizationId } });
      const target = await tx.posTable.findFirst({ where: { id: targetId, organizationId } });
      if (!source) throw new NotFoundException('Source table not found');
      if (!target) throw new NotFoundException('Target table not found');
      if (source.mergedIntoId) {
        throw new ConflictException(`Source table is already merged into T${source.mergedIntoId}`);
      }
      if (!source.active || !target.active) {
        throw new ConflictException('Cannot merge an archived table');
      }
      if (source.status === 'out_of_service' || target.status === 'out_of_service') {
        throw new ConflictException('Cannot merge an out-of-service table');
      }
      // Settled-table guard (User Story 9): only OPEN draft orders may merge — a
      // posted / paid sale has GL behind it and must never be re-tabled. We also
      // refuse a cross-branch merge (branch is carried on the Document, since a
      // PosTable itself is not branch-scoped).
      const involved = await tx.posTableOrder.findMany({
        where: { tableId: { in: [sourceId, targetId] }, closedAt: null },
        include: { document: { select: { status: true, branchId: true } } },
      });
      if (involved.some((o: any) => o.document && o.document.status !== 'draft')) {
        throw new ConflictException('Cannot merge settled tables');
      }
      const branches = new Set(involved.map((o: any) => o.document?.branchId).filter(Boolean));
      if (branches.size > 1) {
        throw new ConflictException('Cannot merge tables from different branches');
      }
      // Collect every table merged into source (cascade) — they all reassign too.
      const cascadedSourceIds = await tx.posTable.findMany({
        where: { mergedIntoId: sourceId },
        select: { id: true },
      });
      const allSourceIds = [sourceId, ...cascadedSourceIds.map((c: any) => c.id)];

      // Reassign open PosTableOrder rows in one statement.
      const reassigned = await tx.posTableOrder.findMany({
        where: { tableId: { in: allSourceIds }, closedAt: null },
        select: { id: true, documentId: true },
      });
      const docIds = reassigned.map((r: any) => r.documentId);
      if (docIds.length > 0) {
        await tx.posTableOrder.updateMany({
          where: { id: { in: reassigned.map((r: any) => r.id) } },
          data: { tableId: targetId },
        });
        await tx.document.updateMany({
          where: { id: { in: docIds } },
          data: { tableId: targetId },
        });
      }
      // Source is now drained → AVAILABLE + mergedInto pointer.
      await tx.posTable.update({
        where: { id: sourceId },
        data: {
          status: 'available',
          mergedIntoId: targetId,
          mergedAt: new Date(),
          mergedById: userId ?? null,
        },
      });
      // Cascade members also point at target.
      if (cascadedSourceIds.length > 0) {
        await tx.posTable.updateMany({
          where: { id: { in: cascadedSourceIds.map((c: any) => c.id) } },
          data: { mergedIntoId: targetId, status: 'available' },
        });
      }
      // Sync status for both tables based on open orders
      await this.syncTableStatus(sourceId, tx);
      await this.syncTableStatus(targetId, tx);
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: sourceId,
        action: 'merge' as any,
        newValues: { targetId, reassignedDocs: docIds, actorId: userId ?? null },
      });
      return { source, target, reassigned: docIds };
    }).then(({ source, target, reassigned }) => {
      this.events.publish(EVENTS.PosTableMerged, {
        organizationId,
        sourceId,
        targetId,
        orderIds: reassigned,
        actorId: userId ?? '',
      });
      return { sourceId, targetId, mergedSource: source, target, reassignedDocuments: reassigned };
    });
  }

  /** Split a merged source back out. Only allowed when the source has no docs. */
  async unmerge(sourceId: string) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        sourceId,
        organizationId,
      );
      const source = await tx.posTable.findFirst({ where: { id: sourceId, organizationId } });
      if (!source) throw new NotFoundException('Source table not found');
      if (!source.mergedIntoId) {
        throw new BadRequestException('Table is not merged');
      }
      const open = await tx.posTableOrder.count({
        where: { tableId: sourceId, closedAt: null },
      });
      if (open > 0) {
        throw new ConflictException(
          'Cannot unmerge: source table still has open orders (transfer first).',
        );
      }
      const updated = await tx.posTable.update({
        where: { id: sourceId },
        data: {
          mergedIntoId: null,
          mergedAt: null,
          mergedById: null,
        },
      });
      // Sync status based on open orders
      await this.syncTableStatus(sourceId, tx);
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: sourceId,
        action: 'update',
        oldValues: { mergedIntoId: source.mergedIntoId },
        newValues: { mergedIntoId: null },
      });
      return updated;
    }).then((t) => {
      this.events.publish(EVENTS.PosTableUnmerged, { organizationId, tableId: sourceId, actorId: userId ?? '' });
      return t;
    });
  }

  /**
   * Transfer every open sale from `sourceId` to `targetId`. Unlike merge,
   * source becomes AVAILABLE (no merge pointer); target becomes OCCUPIED
   * (absorbing the transferred sales). All PosTableOrder rows + their
   * Document.tableId cache are reassigned in one tx.
   */
  async transfer(sourceId: string, targetId: string, documentIds?: string[]) {
    if (sourceId === targetId) {
      throw new BadRequestException('A table cannot transfer to itself');
    }
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const first = sourceId < targetId ? sourceId : targetId;
      const second = first === sourceId ? targetId : sourceId;
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = ANY($1::uuid[]) AND "organizationId" = $2 ORDER BY id FOR UPDATE`,
        [first, second],
        organizationId,
      );
      const source = await tx.posTable.findFirst({ where: { id: sourceId, organizationId } });
      const target = await tx.posTable.findFirst({ where: { id: targetId, organizationId } });
      if (!source) throw new NotFoundException('Source table not found');
      if (!target) throw new NotFoundException('Target table not found');
      if (!source.active || !target.active) {
        throw new ConflictException('Cannot transfer to/from an archived table');
      }
      if (target.status === 'occupied' || target.status === 'reserved') {
        throw new ConflictException(
          `Target table T${target.number} is ${target.status}; cannot transfer into it`,
        );
      }
      const where: any = { tableId: sourceId, closedAt: null };
      if (documentIds?.length) where.documentId = { in: documentIds };
      const orders = await tx.posTableOrder.findMany({
        where,
        select: { id: true, documentId: true },
      });
      const docIds = orders.map((o: any) => o.documentId);
      if (docIds.length === 0) {
        throw new BadRequestException('No open orders on the source table');
      }
      await tx.posTableOrder.updateMany({
        where: { id: { in: orders.map((o: any) => o.id) } },
        data: { tableId: targetId },
      });
      await tx.document.updateMany({
        where: { id: { in: docIds } },
        data: { tableId: targetId },
      });
      // Sync status for both tables based on open orders
      await this.syncTableStatus(sourceId, tx);
      await this.syncTableStatus(targetId, tx);
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: sourceId,
        action: 'transfer',
        newValues: { targetId, documents: docIds, actorId: userId ?? null },
      });
      return { source, target, transferred: docIds };
    }).then(({ source, target, transferred }) => {
      this.events.publish(EVENTS.PosTableTransferred, {
        organizationId,
        sourceId,
        targetId,
        documentIds: transferred,
        actorId: userId ?? '',
      });
      return { sourceId, targetId, transferredDocuments: transferred };
    });
  }

  // ─── Transfer Items (soft move — split a draft between two tables) ────────

  /**
   * Transfer specific order ITEMS (lines, with optional partial quantities)
   * from `sourceId`'s open draft order into `targetId`'s. Unlike `transfer`
   * (which moves whole documents into an empty table), this splits a draft:
   * the chosen quantities leave the source line-set and are appended to the
   * target's draft (created on the fly if the target had none) — so it works
   * into an already-OCCUPIED table without losing its existing items. Totals on
   * both sides are recomputed by the tax engine; if the source is fully drained
   * it becomes AVAILABLE.
   *
   * KDS note: already-fired KitchenTicket rows reference the *source* document
   * and stay there — this operates on the live draft order only.
   */
  async transferItems(
    sourceId: string,
    targetId: string,
    items: Array<{ lineId: string; quantity: number }>,
  ) {
    if (sourceId === targetId) {
      throw new BadRequestException('A table cannot transfer items to itself');
    }
    if (!items?.length) throw new BadRequestException('No items selected to transfer');
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;

    return this.prisma.client.$transaction(async (tx: any) => {
      // Lock both rows (lower id first) to keep concurrent moves deadlock-free.
      const first = sourceId < targetId ? sourceId : targetId;
      const second = first === sourceId ? targetId : sourceId;
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = ANY($1::uuid[]) AND "organizationId" = $2 ORDER BY id FOR UPDATE`,
        [first, second],
        organizationId,
      );
      const source = await tx.posTable.findFirst({ where: { id: sourceId, organizationId } });
      const target = await tx.posTable.findFirst({ where: { id: targetId, organizationId } });
      if (!source) throw new NotFoundException('Source table not found');
      if (!target) throw new NotFoundException('Target table not found');
      if (!source.active || !target.active) {
        throw new ConflictException('Cannot transfer to/from an archived table');
      }
      if (target.status === 'out_of_service') {
        throw new ConflictException(`Target table T${target.number} is out of service`);
      }

      // Source open draft order + lines (with modifier rows, to re-attach later).
      const sourceOrder = await tx.posTableOrder.findFirst({
        where: { tableId: sourceId, closedAt: null },
        include: {
          document: { include: { lines: { include: { modifiers: true }, orderBy: { lineNumber: 'asc' } } } },
        },
      });
      if (!sourceOrder?.document || sourceOrder.document.status !== 'draft') {
        throw new BadRequestException('No open order on the source table');
      }
      const sourceDoc = sourceOrder.document;

      // Tally requested quantities per source line.
      const byLine = new Map<string, number>();
      for (const it of items) {
        if (!(it.quantity > 0)) throw new BadRequestException('Transfer quantity must be greater than zero');
        byLine.set(it.lineId, (byLine.get(it.lineId) ?? 0) + it.quantity);
      }

      const toInput = (l: any, quantity: number) => ({
        productId: l.productId ?? undefined,
        menuItemId: l.menuItemId ?? undefined,
        description: l.description,
        quantity,
        unitPrice: Number(l.unitPrice),
        taxId: l.taxId ?? undefined,
        discountPercent: Number(l.discountPercent),
        taxInclusive: l.taxInclusive,
      });
      const modsOf = (l: any) =>
        (l.modifiers ?? []).map((m: any) => ({ modifierId: m.modifierId, name: m.name, priceDelta: m.priceDelta }));

      // Split each source line into remaining (stays) + moved (goes to target).
      const remainingInputs: any[] = [];
      const remainingMods: any[][] = [];
      const movedInputs: any[] = [];
      const movedMods: any[][] = [];
      const movedSummary: Array<{ description: string; quantity: number }> = [];
      for (const l of sourceDoc.lines as any[]) {
        const moveQty = byLine.get(l.id) ?? 0;
        const have = Number(l.quantity);
        if (moveQty === 0) {
          remainingInputs.push(toInput(l, have));
          remainingMods.push(modsOf(l));
          continue;
        }
        if (moveQty > have + 1e-6) {
          throw new BadRequestException(
            `Cannot transfer ${moveQty} of "${l.description}" — only ${have} on the order`,
          );
        }
        const keep = have - moveQty;
        if (keep > 1e-6) {
          remainingInputs.push(toInput(l, keep));
          remainingMods.push(modsOf(l));
        }
        movedInputs.push(toInput(l, moveQty));
        movedMods.push(modsOf(l));
        movedSummary.push({ description: l.description, quantity: moveQty });
        byLine.delete(l.id);
      }
      if (byLine.size > 0) {
        throw new BadRequestException("One or more selected items are not on this table's order");
      }
      if (movedInputs.length === 0) throw new BadRequestException('No items selected to transfer');

      // ── Source side ──────────────────────────────────────────────────────
      if (remainingInputs.length === 0) {
        // Fully drained → cancel the draft, close the order, free the table.
        await tx.documentLine.deleteMany({ where: { documentId: sourceDoc.id } });
        await tx.document.update({
          where: { id: sourceDoc.id },
          data: {
            status: 'cancelled',
            subtotal: 0, discountTotal: 0, taxAmount: 0, totalAmount: 0, amountResidual: 0,
            notes: `Items transferred to T${target.number}`,
          },
        });
        await tx.posTableOrder.updateMany({ where: { id: sourceOrder.id }, data: { closedAt: new Date() } });
      } else {
        const srcLines = await this.rebuildDraftLines(tx, organizationId, sourceDoc.id, remainingInputs);
        await this.attachLineModifiers(tx, organizationId, srcLines, 0, remainingMods);
      }
      await this.syncTableStatus(sourceId, tx);

      // ── Target side ──────────────────────────────────────────────────────
      const targetOrder = await tx.posTableOrder.findFirst({
        where: { tableId: targetId, closedAt: null },
        include: {
          document: { include: { lines: { include: { modifiers: true }, orderBy: { lineNumber: 'asc' } } } },
        },
      });
      let targetDocId: string;
      if (targetOrder?.document && targetOrder.document.status === 'draft') {
        // Append moved lines to the existing draft; preserve its current items
        // and their modifier rows (rebuild cascade-deletes them).
        targetDocId = targetOrder.documentId;
        const existing = (targetOrder.document.lines as any[]).map((l) => toInput(l, Number(l.quantity)));
        const existingMods = (targetOrder.document.lines as any[]).map((l) => modsOf(l));
        const tgtLines = await this.rebuildDraftLines(tx, organizationId, targetDocId, [...existing, ...movedInputs]);
        await this.attachLineModifiers(tx, organizationId, tgtLines, 0, [...existingMods, ...movedMods]);
      } else {
        const doc = await this.builder.createDocument(
          tx,
          'sales_invoice',
          { partnerId: sourceDoc.partnerId, issueDate: new Date().toISOString(), sourceType: 'pos', branchId: target.branchId ?? undefined } as any,
          movedInputs,
        );
        targetDocId = doc.id;
        await tx.document.update({ where: { id: doc.id }, data: { tableId: targetId } });
        await tx.posTableOrder.create({ data: { tableId: targetId, documentId: doc.id } });
        const tgtLines = await tx.documentLine.findMany({ where: { documentId: doc.id }, orderBy: { lineNumber: 'asc' } });
        await this.attachLineModifiers(tx, organizationId, tgtLines, 0, movedMods);
      }
      if (target.status !== 'occupied' && target.status !== 'reserved') {
        await tx.posTable.update({ where: { id: targetId }, data: { status: 'occupied' } });
      }
      await this.syncTableStatus(targetId, tx);

      // ── Audit trail (User Story 5) ───────────────────────────────────────
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: sourceId,
        action: 'transfer' as any,
        newValues: { kind: 'transfer_items', targetId, items: movedSummary, actorId: userId ?? null },
      });

      const [sourceFresh, targetFresh] = await Promise.all([
        tx.document.findFirst({ where: { id: sourceDoc.id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } }),
        tx.document.findFirst({ where: { id: targetDocId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } }),
      ]);
      return { sourceId, targetId, targetDocId, movedSummary, source: sourceFresh, target: targetFresh };
    }).then((res) => {
      this.events.publish(EVENTS.PosTableTransferred, {
        organizationId,
        sourceId,
        targetId,
        documentIds: [res.targetDocId],
        actorId: userId ?? '',
      });
      return res;
    });
  }

  /**
   * Replace a draft document's lines with `inputs` (priced through the tax
   * engine) and refresh its header totals. Returns the freshly-created lines in
   * order. Shared by transferItems for both the source and target rebuilds.
   */
  private async rebuildDraftLines(
    tx: any,
    organizationId: string,
    documentId: string,
    inputs: Array<{
      productId?: string; menuItemId?: string; description: string;
      quantity: number; unitPrice: number; taxId?: string; discountPercent: number; taxInclusive?: boolean;
    }>,
  ) {
    const totals = await this.builder.prepareLines(tx, inputs);
    await tx.documentLine.deleteMany({ where: { documentId } });
    for (const p of totals.prepared) {
      await tx.documentLine.create({
        data: {
          organizationId,
          documentId,
          productId: p.productId,
          menuItemId: p.menuItemId,
          accountId: p.accountId,
          description: p.description,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          discountPercent: p.discountPercent,
          taxId: p.taxId,
          subtotal: p.subtotal,
          taxAmount: p.taxAmount,
          total: p.total,
          lineNumber: p.lineNumber,
          taxInclusive: p.taxInclusive,
        },
      });
    }
    await tx.document.updateMany({
      where: { id: documentId },
      data: {
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        amountResidual: totals.total,
      },
    });
    return tx.documentLine.findMany({ where: { documentId }, orderBy: { lineNumber: 'asc' } });
  }

  /**
   * Re-create DocumentLineModifier rows after a line rebuild. `modsList[i]`
   * maps onto `lines[fromIndex + i]` — prepareLines preserves input order 1:1,
   * so positional mapping is exact. Best-effort (modifier prices are already
   * baked into unitPrice; these rows exist for reporting).
   */
  private async attachLineModifiers(
    tx: any,
    organizationId: string,
    lines: any[],
    fromIndex: number,
    modsList: Array<Array<{ modifierId: string | null; name: string; priceDelta: any }>>,
  ) {
    for (let i = 0; i < modsList.length; i++) {
      const mods = modsList[i];
      if (!mods?.length) continue;
      const line = lines[fromIndex + i];
      if (!line) continue;
      for (const m of mods) {
        await tx.documentLineModifier.create({
          data: {
            organizationId,
            documentLineId: line.id,
            modifierId: m.modifierId ?? null,
            name: m.name,
            priceDelta: m.priceDelta ?? 0,
          },
        });
      }
    }
  }

  /**
   * Split a single Document into N Documents (one per "guest check"). Each
   * new Document inherits a subset of DocumentLines from the original. The
   * source Document is voided (status='cancelled', kept for audit) and the
   * new Documents become separate PosTableOrder rows on the same table.
   *
   * For full menu-engine split, the caller passes `splits` — an array of
   * `{ documentLines: { id, quantity } }` instructions. Backend re-prices
   * and creates the new sales_invoice Documents.
   */
  async splitBill(args: {
    tableId: string;
    sourceDocumentId: string;
    splits: Array<{ label: string; lines: Array<{ sourceLineId: string; quantity: number }> }>;
    partnerId?: string;
  }) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        args.tableId,
        organizationId,
      );
      const source = await tx.posTable.findFirst({ where: { id: args.tableId, organizationId } });
      if (!source) throw new NotFoundException('Table not found');
      const sourceDoc = await tx.document.findFirst({
        where: { id: args.sourceDocumentId, organizationId },
        include: { lines: true },
      });
      if (!sourceDoc) throw new NotFoundException('Source document not found');
      // H6 — a posted/paid sale has GL behind it; cancelling it to split would
      // orphan those entries. Only an open (unposted draft) bill can be split.
      if (sourceDoc.status !== 'draft') {
        throw new BadRequestException(
          'Only an open (unposted) bill can be split — a posted or paid sale cannot be re-split',
        );
      }

      // Validate that the splits cover the original lines exactly.
      const usedByLine = new Map<string, number>();
      for (const split of args.splits) {
        for (const ln of split.lines) {
          usedByLine.set(ln.sourceLineId, (usedByLine.get(ln.sourceLineId) ?? 0) + ln.quantity);
        }
      }
      for (const srcLine of sourceDoc.lines) {
        const requested = Number(srcLine.quantity);
        const allocated = usedByLine.get(srcLine.id) ?? 0;
        if (Math.abs(requested - allocated) > 0.0001) {
          throw new BadRequestException(
            `Split quantities do not match source line ${srcLine.id} (have ${allocated}, need ${requested})`,
          );
        }
      }

      // Move the open PosTableOrder off the source doc once (the source is
      // about to be cancelled and replaced by the split tickets below).
      await tx.posTableOrder.deleteMany({
        where: { tableId: args.tableId, documentId: args.sourceDocumentId },
      });

      // Generate one Document per split. H5: each split is priced through the
      // DocumentBuilder so tax + document-level totals are computed correctly —
      // the old hand-rolled lines wrote taxAmount:0 and left the doc total null.
      const created: string[] = [];
      for (const split of args.splits) {
        const newDoc = await this.builder.createDocument(
          tx,
          'sales_invoice',
          {
            partnerId: args.partnerId ?? sourceDoc.partnerId,
            currencyId: sourceDoc.currencyId ?? undefined,
            exchangeRate: Number(sourceDoc.exchangeRate ?? 1),
            issueDate: new Date().toISOString(),
            reference: `Split of ${sourceDoc.documentNumber}`,
          } as any,
          split.lines.map((ln) => {
            const src = sourceDoc.lines.find((s: any) => s.id === ln.sourceLineId);
            if (!src) throw new BadRequestException(`Unknown source line ${ln.sourceLineId}`);
            return {
              productId: src.productId ?? undefined,
              description: src.description + (split.label ? ` (${split.label})` : ''),
              quantity: Number(ln.quantity),
              unitPrice: Number(src.unitPrice),
              discountPercent: Number(src.discountPercent),
              taxId: src.taxId ?? undefined,
              taxInclusive: (src as any).taxInclusive,
            };
          }),
        );
        // createDocument doesn't map branch / table / source — tag them now so
        // the split ticket stays linked to the table and the POS report scope.
        await tx.document.update({
          where: { id: newDoc.id },
          data: { branchId: sourceDoc.branchId, tableId: args.tableId, sourceType: 'pos' },
        });
        await tx.posTableOrder.create({
          data: {
            tableId: args.tableId,
            documentId: newDoc.id,
            customerName: split.label,
            notes: `Split from ${sourceDoc.documentNumber}`,
          },
        });
        created.push(newDoc.id);
      }
      // Mark the source document as cancelled (kept for audit; cannot be
      // posted). The new Documents become the live tickets for tender.
      await tx.document.update({
        where: { id: args.sourceDocumentId },
        data: { status: 'cancelled', notes: `Split into ${created.length} ticket(s)` },
      });
      // Sync table status after split (new open orders created)
      await this.syncTableStatus(args.tableId, tx);
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: args.tableId,
        action: 'update',
        newValues: { kind: 'split', sourceDocumentId: args.sourceDocumentId, newDocumentIds: created, actorId: userId ?? null },
      });
      return { sourceDocumentId: args.sourceDocumentId, newDocumentIds: created };
    }).then((res) => {
      this.events.publish(EVENTS.PosTableSplit, {
        organizationId,
        sourceDocumentId: res.sourceDocumentId,
        newDocumentIds: res.newDocumentIds,
        actorId: userId ?? '',
      });
      return res;
    });
  }

  // ─── Link helpers (called from PosService.checkout) ──────────────────────

  /**
   * Mark the table OCCUPIED and create a PosTableOrder row for the new
   * Document. Called from /pos/checkout when the cashier assigns the sale
   * to a table.
   */
  async attachSaleToTable(args: {
    tableId: string;
    documentId: string;
    customerName?: string;
    guestCount?: number;
  }) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        args.tableId,
        organizationId,
      );
      const table = await tx.posTable.findFirst({ where: { id: args.tableId, organizationId } });
      if (!table) throw new NotFoundException('Table not found');
      if (table.status === 'out_of_service') {
        throw new ConflictException('Table is out of service');
      }
      await tx.posTableOrder.upsert({
        where: {
          tableId_documentId: { tableId: args.tableId, documentId: args.documentId },
        },
        create: {
          tableId: args.tableId,
          documentId: args.documentId,
          customerName: args.customerName ?? null,
          guestCount: args.guestCount ?? null,
        },
        update: {
          customerName: args.customerName ?? null,
          guestCount: args.guestCount ?? null,
        },
      });
      await tx.document.update({
        where: { id: args.documentId },
        data: { tableId: args.tableId },
      });
      // Sync status: occupied if open orders exist, available otherwise (reserved stays reserved)
      await this.syncTableStatus(args.tableId, tx);
      return { tableId: args.tableId, documentId: args.documentId };
    });
  }

  /**
   * Close the open PosTableOrder(s) on a table after payment.
   * Table status auto-synced: no open orders → available, else occupied.
   */
  async closeTableOrder(args: { tableId: string; documentId?: string }): Promise<{ closed: number; tableStatus: 'available' | 'occupied' | 'reserved' | 'out_of_service' }> {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        args.tableId,
        organizationId,
      );
      const where: any = { tableId: args.tableId, closedAt: null };
      if (args.documentId) where.documentId = args.documentId;
      const closed = await tx.posTableOrder.updateMany({
        where,
        data: { closedAt: new Date() },
      });
      // Sync status based on remaining open orders and return it
      const tableStatus = await this.syncTableStatus(args.tableId, tx);
      return { closed: closed.count, tableStatus };
    });
  }

  // ─── SSE Stream (mirrors KDS pattern) ───────────────────────────────────

  async stream(res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`retry: 5000\n\n`);

    let alive = true;
    const send = async () => {
      if (!alive) return;
      try {
        const tables = await this.list({ active: true });
        const stats = await this.stats();
        res.write(`data: ${JSON.stringify({ type: 'snapshot', tables, stats })}\n\n`);
      } catch (e: any) {
        this.logger.warn(`SSE snapshot failed: ${String(e?.message ?? e)}`);
      }
    };
    await send();
    const id = setInterval(send, 2_000);
    res.on('close', () => {
      alive = false;
      clearInterval(id);
    });
  }
}