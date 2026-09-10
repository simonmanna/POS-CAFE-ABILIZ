import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { HrLeaveService } from './hr-leave.service';
import { HrAttendanceService } from './hr-attendance.service';
import { redactEmployee } from './hr-employee-projection';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ACTIVE_STATUSES = ['ACTIVE', 'PROBATION', 'ON_LEAVE'];

/**
 * HrSelfService — employee self-service and the manager's team view.
 *
 * These routes carry no `hr:*` permission, and that is deliberate rather than
 * an oversight. Every one of them is scoped by construction: the employee is
 * resolved from `tenant.userId`, so the only record a caller can ever reach is
 * their own, or (for the team endpoints) one of their own direct reports.
 * Requiring `hr:read` here would mean granting every cashier the ability to
 * read the whole staff directory just so they could see their own payslip —
 * strictly worse for confidentiality than no permission at all.
 *
 * Compensation redaction still applies: an employee sees their own salary
 * because it is theirs, never anyone else's.
 */
@Injectable()
export class HrSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly leave: HrLeaveService,
    private readonly attendance: HrAttendanceService,
  ) {}

  // ── Me ───────────────────────────────────────────────────────────────────

  /** The caller's own employee record, or null if they have never been linked. */
  async me() {
    const employee = await this.resolveSelf(false);
    if (!employee) {
      return {
        linked: false,
        employee: null,
        message:
          'Your login is not linked to an employee record. Ask HR to link it if you need self-service.',
      };
    }
    const full = await this.prisma.client.hrEmployee.findFirst({
      where: { id: employee.id },
      include: {
        department: true,
        position: true,
        branch: { select: { id: true, code: true, name: true } },
        supervisor: {
          select: { id: true, firstName: true, lastName: true, employeeCode: true },
        },
        leaveBalances: { include: { leaveType: true } },
        shiftAssignments: { include: { shift: true }, where: { isActive: true } },
      },
    });
    // `true` — this is the caller's own record, so their own pay is theirs to see.
    return { linked: true, employee: redactEmployee(full as any, true) };
  }

  async myAttendance(query: any = {}) {
    const employee = await this.resolveSelf();
    return this.attendance.listAttendance({ ...query, employeeId: employee.id });
  }

  async myLeave(query: any = {}) {
    const employee = await this.resolveSelf();
    return this.leave.listRequests({ ...query, employeeId: employee.id });
  }

  async myLeaveBalances(query: any = {}) {
    const employee = await this.resolveSelf();
    return this.leave.listBalances({ ...query, employeeId: employee.id });
  }

  /** Request leave for yourself. The employee id comes from the session, not the body. */
  async requestLeave(dto: any) {
    const employee = await this.resolveSelf();
    return this.leave.createRequest({
      ...dto,
      employeeId: employee.id,
      // Self-service cannot override its own balance — that needs HR.
      overrideBalance: false,
    });
  }

  async cancelMyLeave(id: string) {
    const employee = await this.resolveSelf();
    const row = await this.prisma.client.hrLeaveRequest.findFirst({ where: { id } });
    if (!row || row.employeeId !== employee.id) {
      throw new ForbiddenException('That leave request is not yours');
    }
    return this.leave.cancelRequest(id);
  }

  async myPayslips(query: any = {}) {
    const employee = await this.resolveSelf();
    // A payslip hangs off the payroll ITEM, not the employee — the employee link
    // is one hop further in. Filtering through the relation keeps this scoped to
    // the caller's own slips without a second round trip.
    const rows = await this.prisma.client.hrPayslip.findMany({
      where: { item: { employeeId: employee.id } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(query.take ?? 24), 60),
      include: {
        item: {
          include: {
            run: { select: { id: true, runNumber: true, status: true, periodId: true, paymentDate: true } },
            allowances: true,
            deductions: true,
          },
        },
      },
    });
    return { rows, total: rows.length };
  }

  async myTrainings() {
    const employee = await this.resolveSelf();
    const rows = await this.prisma.client.hrEmployeeTraining.findMany({
      where: { employeeId: employee.id },
      include: { program: true },
      orderBy: { enrolledAt: 'desc' },
    });
    return { rows, total: rows.length };
  }

  /** Clock yourself in or out. */
  async clock(dto: any) {
    const employee = await this.resolveSelf();
    return this.attendance.clock({ ...dto, employeeId: employee.id, method: dto.method ?? 'APP' });
  }

  // ── My team ──────────────────────────────────────────────────────────────

  /**
   * Direct reports, plus anyone in a department this employee manages.
   *
   * No compensation is returned — being someone's manager does not by itself
   * make their salary your business; that still needs `hr:compensation` through
   * the normal HR screens.
   */
  async team() {
    const employee = await this.resolveSelf();
    const reports = await this.findReports(employee.id);
    return {
      manager: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName },
      rows: reports.map((r) => redactEmployee(r, false)),
      total: reports.length,
    };
  }

  /** The "who is in today" tile. */
  async teamToday() {
    const employee = await this.resolveSelf();
    const reports = await this.findReports(employee.id);
    const ids = reports.map((r) => r.id);
    if (ids.length === 0) {
      return { total: 0, present: 0, late: 0, onLeave: 0, absent: 0, notClockedIn: 0, rows: [] };
    }

    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const attendance = await this.prisma.client.hrAttendance.findMany({
      where: { employeeId: { in: ids }, date: start },
    });
    const byEmployee = new Map(attendance.map((a: any) => [a.employeeId, a]));

    const rows = reports.map((r) => {
      const a: any = byEmployee.get(r.id);
      return {
        employeeId: r.id,
        employeeCode: r.employeeCode,
        firstName: r.firstName,
        lastName: r.lastName,
        employmentStatus: r.employmentStatus,
        status: a?.status ?? (r.employmentStatus === 'ON_LEAVE' ? 'ON_LEAVE' : 'NOT_CLOCKED_IN'),
        checkInAt: a?.checkInAt ?? null,
        checkOutAt: a?.checkOutAt ?? null,
        lateMinutes: a?.lateMinutes ?? 0,
      };
    });

    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      total: rows.length,
      present: count('PRESENT'),
      late: count('LATE'),
      onLeave: count('ON_LEAVE'),
      absent: count('ABSENT'),
      notClockedIn: count('NOT_CLOCKED_IN'),
      rows,
    };
  }

  /** Leave requests awaiting this manager's decision. */
  async teamLeave(query: any = {}) {
    const employee = await this.resolveSelf();
    const reports = await this.findReports(employee.id);
    const ids = reports.map((r) => r.id);
    if (ids.length === 0) return { rows: [], total: 0 };

    const where: any = { employeeId: { in: ids } };
    if (query.status) where.status = query.status;
    const rows = await this.prisma.client.hrLeaveRequest.findMany({
      where,
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        leaveType: true,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(query.take ?? 50), 200),
    });
    return { rows, total: rows.length };
  }

  async approveTeamLeave(id: string, dto: any = {}) {
    await this.assertManagesRequest(id);
    return this.leave.approveRequest(id, dto);
  }

  async rejectTeamLeave(id: string, dto: any = {}) {
    await this.assertManagesRequest(id);
    return this.leave.rejectRequest(id, dto);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Resolve the caller's employee record through the identity spine.
   *
   * This is the whole reason the spine exists: before it, the server had no way
   * to answer "which employee is this login?" at all.
   */
  private async resolveSelf(required = true) {
    const userId = this.tenant.userId;
    if (!userId) throw new ForbiddenException('Authentication required');

    const employee = await this.prisma.client.hrEmployee.findFirst({ where: { userId } });
    if (!employee) {
      if (!required) return null;
      throw new BadRequestException(
        'Your login is not linked to an employee record. Ask HR to link it.',
      );
    }
    return employee as any;
  }

  /** Direct reports plus members of departments this employee manages. */
  private async findReports(employeeId: string): Promise<any[]> {
    const managedDepartments = await this.prisma.client.hrDepartment.findMany({
      where: { managerId: employeeId },
      select: { id: true },
    });
    const departmentIds = managedDepartments.map((d: any) => d.id);

    return this.prisma.client.hrEmployee.findMany({
      where: {
        id: { not: employeeId },
        employmentStatus: { in: ACTIVE_STATUSES as any },
        OR: [
          { supervisorId: employeeId },
          ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
        ],
      },
      include: {
        department: { select: { id: true, name: true } },
        position: { select: { id: true, name: true } },
      },
      orderBy: [{ firstName: 'asc' }],
    }) as any;
  }

  private async assertManagesRequest(requestId: string): Promise<void> {
    const employee = await this.resolveSelf();
    const request = await this.prisma.client.hrLeaveRequest.findFirst({
      where: { id: requestId },
      select: { employeeId: true },
    });
    if (!request) throw new ForbiddenException('Leave request not found');

    const reports = await this.findReports(employee.id);
    if (!reports.some((r) => r.id === request.employeeId)) {
      throw new ForbiddenException('That leave request is not from someone you manage');
    }
  }
}
