import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import type {
  ReactivateEmployeeDto,
  SuspendEmployeeDto,
  TerminateEmployeeDto,
  TransferEmployeeDto,
} from './dto/hr-lifecycle.dto';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Statuses in which a person still counts as staff for existing HR queries. */
const ACTIVE_STATUSES = ['ACTIVE', 'PROBATION', 'ON_LEAVE'];

/**
 * HrLifecycleService — hire → probation → confirmed → transfer → suspend →
 * terminate, and the account consequences of each.
 *
 * Two invariants run through everything here:
 *
 *   1. **History is never rewritten.** Terminating, suspending or transferring
 *      an employee changes the master record and appends to an immutable
 *      ledger. It never touches the actor id on a past order, invoice, payment,
 *      cash session, journal entry or audit row. A former employee keeps
 *      resolving on last year's receipts, which is the point.
 *   2. **Employment status is not authorization.** Disabling the login is a
 *      separate, explicit act that the caller has to ask for — the status
 *      change alone grants no permission and leaves the back-office login as
 *      it was. The one exception is the POS: a suspended or departed employee
 *      cannot sign in at a till whatever their login state
 *      (kernel/auth/pos-eligibility.ts), because a café cannot rely on
 *      someone remembering to tick "disable login".
 *
 * `isActive` is kept in step with `employmentStatus` on every transition so the
 * dozens of pre-existing queries that filter on it keep behaving correctly
 * without being rewritten.
 */
@Injectable()
export class HrLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  // ── Status transitions ───────────────────────────────────────────────────

  /**
   * End someone's employment.
   *
   * `disableAccount` is required rather than defaulted: whether a departing
   * employee loses their login the same instant is a judgement the caller has
   * to make explicitly, and silently guessing either way is wrong.
   */
  async terminate(employeeId: string, dto: TerminateEmployeeDto) {
    const employee = await this.findEmployee(employeeId);
    this.assertNotAlreadyEnded(employee);

    const status = dto.resigned ? 'RESIGNED' : 'TERMINATED';
    const effectiveDate = dto.terminationDate ? new Date(dto.terminationDate) : new Date();

    return this.transition(employee, {
      toStatus: status,
      effectiveDate,
      reason: dto.reason,
      disableAccount: dto.disableAccount,
      extraData: {
        terminationDate: effectiveDate,
        terminationReason: dto.reason,
      },
    });
  }

  /** Suspend access without ending employment (§25 — the two are different). */
  async suspend(employeeId: string, dto: SuspendEmployeeDto) {
    const employee = await this.findEmployee(employeeId);
    this.assertNotAlreadyEnded(employee);
    if (employee.employmentStatus === 'SUSPENDED') {
      throw new BadRequestException('This employee is already suspended');
    }

    return this.transition(employee, {
      toStatus: 'SUSPENDED',
      effectiveDate: new Date(),
      reason: dto.reason,
      disableAccount: dto.disableAccount,
      extraData: { suspendedAt: new Date(), suspensionReason: dto.reason },
    });
  }

  /**
   * Bring someone back — from suspension, or a rehire after termination.
   *
   * Re-enabling the login is opt-in for the same reason disabling it is: the
   * account may have been disabled for a reason unrelated to this suspension.
   */
  async reactivate(employeeId: string, dto: ReactivateEmployeeDto) {
    const employee = await this.findEmployee(employeeId);
    if (ACTIVE_STATUSES.includes(employee.employmentStatus)) {
      throw new BadRequestException('This employee is already active');
    }

    return this.transition(employee, {
      toStatus: dto.toProbation ? 'PROBATION' : 'ACTIVE',
      effectiveDate: new Date(),
      reason: dto.reason,
      enableAccount: dto.enableAccount,
      extraData: {
        suspendedAt: null,
        suspensionReason: null,
        terminationDate: null,
        terminationReason: null,
      },
    });
  }

  /** Probation passed. */
  async confirm(employeeId: string, dto: { reason?: string } = {}) {
    const employee = await this.findEmployee(employeeId);
    if (employee.employmentStatus !== 'PROBATION') {
      throw new BadRequestException('Only employees on PROBATION can be confirmed');
    }
    return this.transition(employee, {
      toStatus: 'ACTIVE',
      effectiveDate: new Date(),
      reason: dto.reason,
      extraData: { confirmedAt: new Date() },
    });
  }

  /**
   * Move an employee between branches, departments or positions.
   *
   * Records where they came from so the move is reconstructable, and changes
   * nothing about their past transactions — last month's sales stay attributed
   * to the branch where they actually happened.
   */
  async transfer(employeeId: string, dto: TransferEmployeeDto) {
    const employee = await this.findEmployee(employeeId);
    const actor = this.tenant.userId;
    const orgId = this.tenant.organizationId;

    const toBranchId = dto.toBranchId ?? employee.branchId;
    const toDepartmentId = dto.toDepartmentId ?? employee.departmentId;
    const toPositionId = dto.toPositionId ?? employee.positionId;

    const unchanged =
      toBranchId === employee.branchId &&
      toDepartmentId === employee.departmentId &&
      toPositionId === employee.positionId;
    if (unchanged) {
      throw new BadRequestException('Transfer would not change branch, department or position');
    }

    await this.assertReferencesExist({ toBranchId, toDepartmentId, toPositionId }, employee);

    return this.prisma.client.$transaction(async (tx: any) => {
      const updated = await tx.hrEmployee.update({
        where: { id: employeeId },
        data: {
          branchId: toBranchId,
          departmentId: toDepartmentId,
          positionId: toPositionId,
          updatedBy: actor,
        },
      });

      // Keep the login's home branch in step with where the person now works,
      // so the POS and branch-scoped screens follow the transfer. Only the
      // default moves; past transactions keep their own branch.
      if (employee.userId && toBranchId !== employee.branchId) {
        await tx.user.updateMany({
          where: { id: employee.userId },
          data: { defaultBranchId: toBranchId ?? null, updatedBy: actor },
        });
      }

      await tx.hrEmployeeTransfer.create({
        data: {
          organizationId: orgId,
          employeeId,
          fromBranchId: employee.branchId,
          toBranchId,
          fromDepartmentId: employee.departmentId,
          toDepartmentId,
          fromPositionId: employee.positionId,
          toPositionId,
          effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : new Date(),
          reason: dto.reason ?? null,
          actorUserId: actor ?? null,
        },
      });

      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: employeeId,
        action: 'transfer',
        oldValues: {
          branchId: employee.branchId,
          departmentId: employee.departmentId,
          positionId: employee.positionId,
        },
        newValues: { branchId: toBranchId, departmentId: toDepartmentId, toPositionId, reason: dto.reason ?? null },
      });

      return updated;
    });
  }

  // ── History ──────────────────────────────────────────────────────────────

  async statusHistory(employeeId: string) {
    await this.findEmployee(employeeId);
    const rows = await this.prisma.client.hrEmployeeStatusHistory.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
    });
    return { rows, total: rows.length };
  }

  async transferHistory(employeeId: string) {
    await this.findEmployee(employeeId);
    const rows = await this.prisma.client.hrEmployeeTransfer.findMany({
      where: { employeeId },
      orderBy: { effectiveDate: 'desc' },
    });
    return { rows, total: rows.length };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Apply a status change, keep `isActive` in step, append to the immutable
   * ledger, optionally flip the login, and audit — all in one transaction.
   */
  private async transition(
    employee: any,
    opts: {
      toStatus: string;
      effectiveDate: Date;
      reason?: string;
      disableAccount?: boolean;
      enableAccount?: boolean;
      extraData?: Record<string, unknown>;
    },
  ) {
    const actor = this.tenant.userId;
    const orgId = this.tenant.organizationId;
    const fromStatus = employee.employmentStatus;
    const nowActive = ACTIVE_STATUSES.includes(opts.toStatus);

    return this.prisma.client.$transaction(async (tx: any) => {
      const updated = await tx.hrEmployee.update({
        where: { id: employee.id },
        data: {
          employmentStatus: opts.toStatus,
          // Derived, never set independently — otherwise the two fields drift
          // and every legacy `isActive` filter starts lying.
          isActive: nowActive,
          updatedBy: actor,
          ...(opts.extraData ?? {}),
        },
      });

      let accountDisabled = false;
      if (employee.userId && (opts.disableAccount || opts.enableAccount)) {
        const enable = !!opts.enableAccount;
        await tx.user.updateMany({
          where: { id: employee.userId },
          data: { isActive: enable, updatedBy: actor },
        });
        accountDisabled = !enable;

        if (!enable) {
          // Kill live sessions too. Without this the account stays usable until
          // the refresh token expires, and the POS token for up to 12h.
          await tx.refreshToken.updateMany({
            where: { userId: employee.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }

        await this.audit.recordInTx(tx, {
          entity: 'User',
          entityId: employee.userId,
          action: 'update',
          oldValues: { isActive: !enable },
          newValues: {
            isActive: enable,
            reason: `Employee ${opts.toStatus.toLowerCase()}: ${opts.reason ?? 'no reason given'}`,
          },
        });
      } else if (employee.userId) {
        // The login itself is untouched, but POS eligibility reads employment
        // status (kernel/auth/pos-eligibility.ts). Bumping the User row's
        // updatedAt puts it in the next offline staff delta, so a suspended
        // cashier's PIN is withdrawn from Android tills too.
        await tx.user.updateMany({
          where: { id: employee.userId },
          data: { updatedBy: actor },
        });
      }

      await tx.hrEmployeeStatusHistory.create({
        data: {
          organizationId: orgId,
          employeeId: employee.id,
          fromStatus,
          toStatus: opts.toStatus,
          effectiveDate: opts.effectiveDate,
          reason: opts.reason ?? null,
          accountDisabled,
          actorUserId: actor ?? null,
        },
      });

      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: employee.id,
        action: 'update',
        oldValues: { employmentStatus: fromStatus, isActive: employee.isActive },
        newValues: {
          employmentStatus: opts.toStatus,
          isActive: nowActive,
          reason: opts.reason ?? null,
          accountDisabled,
        },
      });

      return updated;
    });
  }

  private async findEmployee(employeeId: string) {
    const employee = await this.prisma.client.hrEmployee.findFirst({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee as any;
  }

  private assertNotAlreadyEnded(employee: any): void {
    if (employee.employmentStatus === 'TERMINATED' || employee.employmentStatus === 'RESIGNED') {
      throw new BadRequestException(
        `This employee is already ${employee.employmentStatus.toLowerCase()}. Reactivate them first if they were rehired.`,
      );
    }
  }

  /**
   * All three targets are org-scoped by the tenancy extension, so a reference
   * from another organization simply does not resolve.
   */
  private async assertReferencesExist(
    targets: { toBranchId?: string | null; toDepartmentId?: string | null; toPositionId?: string | null },
    employee: any,
  ): Promise<void> {
    const c = this.prisma.client as any;
    if (targets.toBranchId && targets.toBranchId !== employee.branchId) {
      const branch = await c.branch.findFirst({ where: { id: targets.toBranchId } });
      if (!branch) throw new NotFoundException('Target branch not found in this organization');
    }
    if (targets.toDepartmentId && targets.toDepartmentId !== employee.departmentId) {
      const dept = await c.hrDepartment.findFirst({ where: { id: targets.toDepartmentId } });
      if (!dept) throw new NotFoundException('Target department not found in this organization');
    }
    if (targets.toPositionId && targets.toPositionId !== employee.positionId) {
      const pos = await c.hrPosition.findFirst({ where: { id: targets.toPositionId } });
      if (!pos) throw new NotFoundException('Target position not found in this organization');
    }
  }

  /** Guard used by the controller layer for actions that need a live employee. */
  assertEmployable(employee: any): void {
    if (!ACTIVE_STATUSES.includes(employee.employmentStatus)) {
      throw new ForbiddenException(
        `Employee is ${employee.employmentStatus.toLowerCase()} and cannot be assigned work`,
      );
    }
  }
}
