import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { PosInvoiceService } from './pos-invoice.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase 1 (accounting hardening) — drains `StockPostingJob` rows.
 *
 * Multi-tenant + multi-instance safe: claims due jobs with
 * `FOR UPDATE SKIP LOCKED` (same pattern as OutboxWorker), then processes each
 * inside its org's tenant scope. Retry/backoff/exhaustion logic lives in
 * `PosInvoiceService.processStockPostingJob`.
 */
@Injectable()
export class StockPostingWorker {
  private readonly logger = new Logger('StockPostingWorker');
  private readonly batchSize = Number(process.env.STOCK_POSTING_BATCH ?? '20');
  private readonly staleClaimMs = 60_000;
  /** Release gate: no job older than this may still be unposted. */
  private readonly lagAlertMs = Number(process.env.STOCK_POSTING_LAG_ALERT_MS ?? 15 * 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly billing: PosInvoiceService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'stock-posting-drain' })
  async drain(): Promise<void> {
    const claimToken = randomUUID();
    const staleBefore = new Date(Date.now() - this.staleClaimMs);
    // Atomically claim due jobs (pending & retry-time reached, or a stale
    // processing claim). RETURNING just the ids — we re-read each via the typed
    // client to get the org unambiguously.
    const claimed = await this.prisma.raw.$queryRaw<{ id: string }[]>`
      UPDATE "StockPostingJob"
      SET "claimToken" = ${claimToken}, "claimedAt" = NOW(), "status" = 'processing'
      WHERE "id" IN (
        SELECT "id" FROM "StockPostingJob"
        WHERE (("status" = 'pending' AND "nextRetryAt" <= NOW())
               OR ("status" = 'processing' AND "claimedAt" < ${staleBefore}))
        ORDER BY "createdAt" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `;
    if (!claimed.length) return;

    // A backlog this deep means the queue is draining slower than sales arrive
    // (or a previous instance died mid-shift). Stock deduction is asynchronous,
    // so the only symptom is silently stale on-hand — log loudly enough that it
    // reaches whatever aggregates the API logs.
    if (claimed.length >= this.batchSize) {
      this.logger.warn(
        `stock posting backlog: claimed ${claimed.length} job(s) — on-hand is behind actual sales`,
      );
    }

    for (const { id } of claimed) {
      const job = await this.prisma.raw.stockPostingJob.findUnique({ where: { id }, select: { organizationId: true } });
      if (!job) continue;
      await this.tenant.run({ organizationId: job.organizationId }, async () => {
        try {
          await this.billing.processStockPostingJob(id);
        } catch (err) {
          this.logger.error(`stock job ${id} failed: ${String(err)}`);
        }
      });
    }
  }

  /**
   * Queue-health monitor. The drain above only logs; a dead worker, a wedged
   * claim or an exhausted job would otherwise surface as silently stale on-hand
   * and understated COGS. Every 5 minutes, raise an in-app inventory alert
   * (rate-limited per org) for jobs failed or unposted beyond the lag budget.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'stock-posting-health' })
  async monitor(): Promise<void> {
    const lagBefore = new Date(Date.now() - this.lagAlertMs);
    const rows = await this.prisma.raw.$queryRaw<{ organizationId: string; failed: bigint; lagging: bigint; oldest: Date | null }[]>`
      SELECT "organizationId",
             COUNT(*) FILTER (WHERE "status" = 'failed') AS failed,
             COUNT(*) FILTER (WHERE "status" IN ('pending', 'processing') AND "createdAt" < ${lagBefore}) AS lagging,
             MIN("createdAt") FILTER (WHERE "status" <> 'done') AS oldest
        FROM "StockPostingJob"
       WHERE "status" <> 'done'
       GROUP BY "organizationId"
      HAVING COUNT(*) FILTER (WHERE "status" = 'failed') > 0
          OR COUNT(*) FILTER (WHERE "status" IN ('pending', 'processing') AND "createdAt" < ${lagBefore}) > 0
    `;
    for (const r of rows) {
      const failed = Number(r.failed);
      const lagging = Number(r.lagging);
      this.logger.error(`stock posting unhealthy for org ${r.organizationId}: ${failed} failed, ${lagging} older than ${Math.round(this.lagAlertMs / 60_000)} min (oldest ${r.oldest?.toISOString() ?? 'n/a'})`);
      await this.tenant.run({ organizationId: r.organizationId }, () =>
        this.billing.raiseStockPostingHealthAlert({ failed, lagging, oldest: r.oldest }),
      ).catch((err) => this.logger.error(`stock posting health alert failed: ${String(err)}`));
    }
  }
}
