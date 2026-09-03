import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENTS } from '@erp/shared';
import { EventBus } from '../../kernel/events/event-bus';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { PosKdsService } from './pos-kds.service';

/**
 * F11 — pulls a cancelled order's food off the kitchen board.
 *
 * Cancelling an order publishes `PosOrderCancelled`, but nothing consumed it, so
 * tickets already fired to the pass kept being prepared for an order that no
 * longer existed. This subscriber cancels every still-active ticket for the
 * order. It is idempotent (already served/cancelled tickets are skipped), so a
 * redelivered event is harmless.
 *
 * The outbox worker dispatches handlers WITHOUT a tenant scope, so the handler
 * derives `organizationId` from the payload and runs inside `tenant.run`.
 */
@Injectable()
export class KdsCancellationSubscriber implements OnModuleInit {
  private readonly logger = new Logger(KdsCancellationSubscriber.name);

  constructor(
    private readonly events: EventBus,
    private readonly tenant: TenantContextService,
    private readonly kds: PosKdsService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(EVENTS.PosOrderCancelled, (p) => this.onOrderCancelled(p as { organizationId: string; orderId: string; reason?: string }));
  }

  private async onOrderCancelled(p: { organizationId: string; orderId: string; reason?: string }): Promise<void> {
    await this.tenant.run({ organizationId: p.organizationId }, async () => {
      try {
        const n = await this.kds.cancelTicketsForOrder(p.orderId, p.reason ?? 'Order cancelled');
        if (n > 0) this.logger.log(`Cancelled ${n} kitchen ticket(s) for order ${p.orderId}`);
      } catch (e: any) {
        this.logger.error(`Failed to cancel kitchen tickets for order ${p.orderId}: ${e?.message ?? e}`);
      }
    });
  }
}
