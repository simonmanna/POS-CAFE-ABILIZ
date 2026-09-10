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
 * Turns a POS PIN sign-in into an HR attendance clock-in.
 *
 * This is the one place POS and HR meet, and it is deliberately a subscriber
 * rather than a call:
 *
 *   - `pos` and `hr` are both verticals, and the architecture rules forbid
 *     either importing the other. The kernel event bus is the sanctioned seam.
 *   - Attendance must never be able to fail, slow, or block a cashier's login.
 *     POS publishes and returns; this runs afterwards, off the request path.
 *
 * Scope, deliberately narrow (§13/§14 of the brief): a PIN sign-in raises a
 * clock-in and nothing else. It does not open a cash session, and a cash
 * session does not create attendance. A manager who clocks in without ever
 * touching a drawer still gets an attendance record; a cashier who opens a
 * second drawer mid-shift does not get a second clock-in.
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
      this.onPinLogin(p as PosPinLoginPayload),
    );
    this.logger.log(`Subscribed to ${EVENTS.PosPinLogin} for attendance clock-in`);
  }

  private async onPinLogin(p: PosPinLoginPayload): Promise<void> {
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

        const timestamp = p.at ? new Date(p.at) : new Date();

        // Already clocked in today? Signing in again mid-shift (after a screen
        // lock, a handover, or a second terminal) must not overwrite the real
        // arrival time, so the first CHECK_IN of the day wins.
        const day = new Date(timestamp);
        day.setHours(0, 0, 0, 0);
        const existing = await this.prisma.client.hrAttendance.findFirst({
          where: { employeeId: employee.id, date: day },
          select: { checkInAt: true },
        });
        if (existing?.checkInAt) return;

        await this.attendance.clock({
          employeeId: employee.id,
          eventType: 'CHECK_IN',
          timestamp,
          method: 'PIN',
          deviceId: p.deviceId ?? null,
          note: 'Clocked in automatically at POS sign-in',
        });
      } catch (err) {
        // Never rethrow. Attendance bookkeeping is not permitted to turn into a
        // failed or retried login, and the cashier is already on the terminal
        // by the time this runs.
        this.logger.warn(
          `Could not record POS clock-in for user ${p.userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
