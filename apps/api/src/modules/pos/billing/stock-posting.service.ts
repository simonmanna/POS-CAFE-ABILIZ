import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase 1 (accounting hardening) — Posting Monitor back-office API.
 *
 * Reads the durable inventory-posting queue (`StockPostingJob`) and the
 * exception work-queue (`InventoryException`), lets an admin retry a failed job
 * (safe — a failed job deducted nothing) and assign / resolve exceptions with an
 * audited note. Resolution is deliberately NOT an auto-re-issue: re-deducting a
 * partially-issued recipe would double-count, so a human corrects drift via a
 * manual stock adjustment and records it (same principle as SyncOpDeadLetter).
 */
@Injectable()
export class StockPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async listJobs(status = 'all') {
    return this.prisma.client.stockPostingJob.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listExceptions(status = 'open') {
    return this.prisma.client.inventoryException.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async counts() {
    const [pending, processing, failed, doneWithReview, openExceptions] = await Promise.all([
      this.prisma.client.stockPostingJob.count({ where: { status: 'pending' } }),
      this.prisma.client.stockPostingJob.count({ where: { status: 'processing' } }),
      this.prisma.client.stockPostingJob.count({ where: { status: 'failed' } }),
      this.prisma.client.stockPostingJob.count({ where: { status: 'done', lastError: { not: null } } }),
      this.prisma.client.inventoryException.count({ where: { status: 'open' } }),
    ]);
    return { jobs: { pending, processing, failed, doneWithReview }, exceptions: { open: openExceptions } };
  }

  /**
   * Re-queue a FAILED job. Safe: a job only reaches `failed` when the whole run
   * threw before any deduction (e.g. no active warehouse), so nothing was posted.
   * Use after fixing the underlying config.
   */
  async retryJob(id: string) {
    const job = await this.prisma.client.stockPostingJob.findFirst({ where: { id } });
    if (!job) throw new NotFoundException('Stock posting job not found');
    if (job.status !== 'failed') throw new BadRequestException(`Only failed jobs can be retried (this one is ${job.status})`);
    const updated = await this.prisma.client.stockPostingJob.update({
      where: { id },
      data: { status: 'pending', attempts: 0, lastError: null, nextRetryAt: new Date(), claimToken: null, claimedAt: null },
    });
    await this.audit.record({
      entity: 'StockPostingJob', entityId: id, action: 'update' as any,
      newValues: { retried: true, invoiceNumber: job.invoiceNumber },
    });
    return { id: updated.id, status: updated.status };
  }

  async assignException(id: string, assignedToId: string) {
    const row = await this.prisma.client.inventoryException.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Inventory exception not found');
    return this.prisma.client.inventoryException.update({ where: { id }, data: { assignedToId } });
  }

  /**
   * Close an exception. `resolved` = drift corrected (e.g. a manual stock
   * adjustment / count was posted). `discarded` = should never post (test/dup).
   * A human decides and records why — no blind re-deduction.
   */
  async resolveException(id: string, status: 'resolved' | 'discarded', note: string) {
    if (!note?.trim()) throw new BadRequestException('A note is required — record how the drift was corrected');
    const row = await this.prisma.client.inventoryException.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Inventory exception not found');
    if (row.status !== 'open') throw new BadRequestException(`Already ${row.status}`);
    const updated = await this.prisma.client.inventoryException.update({
      where: { id },
      data: { status, resolutionNote: note.trim(), resolvedById: this.tenant.userId ?? null, resolvedAt: new Date() },
    });
    await this.audit.record({
      entity: 'InventoryException', entityId: id, action: 'update' as any,
      newValues: { status, note: note.trim(), invoiceNumber: row.invoiceNumber, productId: row.productId, menuItemId: row.menuItemId },
    });
    return { id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt };
  }
}
