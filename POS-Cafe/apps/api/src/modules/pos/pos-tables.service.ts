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
  ) {}

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
      dirty: 0,
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

  /** Convenience: flip DIRTY/OCCUPIED → AVAILABLE. Idempotent. */
  async clean(id: string) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        id,
        organizationId,
      );
      const existing = await tx.posTable.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundException('Table not found');
      if (existing.status === 'occupied') {
        throw new ConflictException('Cannot clean an occupied table — close the sale first');
      }
      const updated = await tx.posTable.update({
        where: { id },
        data: { status: 'available' },
      });
      await this.audit.recordInTx(tx, {
        entity: 'PosTable',
        entityId: id,
        action: 'clean' as any,
        oldValues: { status: existing.status },
        newValues: { status: 'available' },
      });
      return updated;
    }).then((t) => {
      this.events.publish(EVENTS.PosTableCleaned, { organizationId, tableId: id, actorId: userId ?? '' });
      return t;
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
      // Target absorbs the status if the source was occupied/reserved.
      if ((source.status === 'occupied' || source.status === 'reserved') && target.status === 'available') {
        await tx.posTable.update({ where: { id: targetId }, data: { status: source.status } });
      }
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
          status: 'available',
        },
      });
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
      await tx.posTable.update({
        where: { id: sourceId },
        data: { status: 'available' },
      });
      await tx.posTable.update({
        where: { id: targetId },
        data: { status: 'occupied' },
      });
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
      if (sourceDoc.status === 'paid' || sourceDoc.status === 'cancelled') {
        throw new BadRequestException('Cannot split a closed document');
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

      // Generate one Document per split using a copy of the invoice header.
      const created: string[] = [];
      for (const split of args.splits) {
        const newDoc = await tx.document.create({
          data: {
            organizationId,
            documentNumber: `${sourceDoc.documentNumber}-S${created.length + 1}`,
            documentType: 'sales_invoice',
            partnerId: args.partnerId ?? sourceDoc.partnerId,
            currencyId: sourceDoc.currencyId,
            exchangeRate: sourceDoc.exchangeRate,
            issueDate: new Date(),
            status: 'draft',
            reference: `Split of ${sourceDoc.documentNumber}`,
            branchId: sourceDoc.branchId,
            tableId: args.tableId,
            sourceType: 'pos',
            lines: {
              create: split.lines.map((ln, i) => {
                const src = sourceDoc.lines.find((s: any) => s.id === ln.sourceLineId);
                if (!src) throw new BadRequestException(`Unknown source line ${ln.sourceLineId}`);
                const qty = Number(ln.quantity);
                return {
                  description: src.description + (split.label ? ` (${split.label})` : ''),
                  quantity: qty,
                  unitPrice: src.unitPrice,
                  discountPercent: src.discountPercent,
                  taxId: src.taxId,
                  lineNumber: i + 1,
                  productId: src.productId,
                  accountId: src.accountId,
                  subtotal: qty * Number(src.unitPrice) * (1 - Number(src.discountPercent) / 100),
                  taxAmount: 0,
                  total: qty * Number(src.unitPrice) * (1 - Number(src.discountPercent) / 100),
                };
              }),
            },
          },
        });
        // Replace the old PosTableOrder with one pointing at the new doc.
        await tx.posTableOrder.deleteMany({
          where: { tableId: args.tableId, documentId: args.sourceDocumentId },
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
      // Table moves to OCCUPIED if it was AVAILABLE / DIRTY. Reserved stays
      // reserved until the booking is explicitly seated.
      const nextStatus = table.status === 'reserved' ? 'reserved' : 'occupied';
      if (table.status !== nextStatus) {
        await tx.posTable.update({
          where: { id: args.tableId },
          data: { status: nextStatus as any },
        });
      }
      return { tableId: args.tableId, documentId: args.documentId };
    });
  }

  /** Close the open PosTableOrder(s) on a table and flip status → DIRTY. */
  async markForCleaning(args: { tableId: string; documentId?: string }) {
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
      const stillOpen = await tx.posTableOrder.count({
        where: { tableId: args.tableId, closedAt: null },
      });
      // Only flip to DIRTY when no other open orders remain on the table.
      if (stillOpen === 0) {
        await tx.posTable.update({
          where: { id: args.tableId },
          data: { status: 'dirty' as any },
        });
      }
      return { closed: closed.count, stillOpen };
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