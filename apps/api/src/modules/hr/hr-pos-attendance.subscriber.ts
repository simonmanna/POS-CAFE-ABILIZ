import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENTS, type PosPinLoginPayload } from '@erp/shared';
import { EventBus } from '../../kernel/events/event-bus';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { HrAttendanceService } from './hr-attendance.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Statuses in which someone is still considered staff. */
const ACTIVE_STATUSES = ['ACTIVE', 'PROBATION', 'ON_LEAVE'];

/**
 * Turns POS PIN sign-ins and log-offs into HR attendance.
 *
 * This is the one place POS and HR meet, and it is deliberately a subscriber
 * rather than a call:
 *
 *   - `pos` and `hr` are both verticals, and the architecture rules forbid
 *     either importing the other. The kernel event bus is the sanctioned seam.
 *   - Attendance must never be able to fail, slow, or block a cashier's login.
 *     POS publishes and returns; this runs afterwards, off the request path.
 *
 * A sign-in raises a clock-in (first of the day wins); a log-off raises a
 * clock-out (last of the day wins). Neither opens or closes a cash session.
 * See HrAttendanceService.posSignIn / posSignOff for the day rules.
 *
 * A sign-in by someone with no linked employee is simply ignored — that is the
 * normal state for a POS user HR has not adopted yet, not an error.
 */
@Injectable()
export class HrPosAttendanceSubscriber implements OnModuleInit {
  private readonly logger = new Logger('HrPosAttendanceSubscriber');

  constructor(
    private readonly events: EventBus,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly attendance: HrAttendanceService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(EVENTS.PosPinLogin, (p) =>
      this.handle(p as PosPinLoginPayload, 'in'),
    );
    this.events.subscribe(EVENTS.PosPinLogoff, (p) =>
      this.handle(p as PosPinLoginPayload, 'out'),
    );
    this.logger.log(`Subscribed to ${EVENTS.PosPinLogin} / ${EVENTS.PosPinLogoff} for attendance`);
  }

  private async handle(p: PosPinLoginPayload, direction: 'in' | 'out'): Promise<void> {
    // The outbox worker dispatches without a tenant scope, so the org comes
    // from the payload and the work runs inside an explicit tenant context.
    await this.tenant.run({ organizationId: p.organizationId, userId: p.userId }, async () => {
      try {
        const employee = await this.prisma.client.hrEmployee.findFirst({
          where: { userId: p.userId },
          select: { id: true, employmentStatus: true },
        });

        // No employee record, or not currently staff: nothing to record. A POS
        // user who has never been linked is a supported state, not a problem.
        if (!employee) return;
        if (!ACTIVE_STATUSES.includes(employee.employmentStatus)) return;

        const at = p.at ? new Date(p.at) : new Date();
        if (direction === 'in') {
          await this.attendance.posSignIn(employee.id, at, p.deviceId ?? null);
        } else {
          await this.attendance.posSignOff(employee.id, at, p.deviceId ?? null);
        }
      } catch (err) {
        // Never rethrow. Attendance bookkeeping is not permitted to turn into a
        // failed or retried login, and the cashier has already moved on by the
        // time this runs.
        this.logger.warn(
          `Could not record POS clock-${direction} for user ${p.userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
