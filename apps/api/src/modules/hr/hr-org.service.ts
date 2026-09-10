import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { AuditService } from '../../kernel/audit/audit.service';
import {
  HR_COMPENSATION_FIELDS,
  redactEmployee,
  redactEmployees,
} from './hr-employee-projection';
import { writeAudited } from './hr-audit.util';

/* eslint-disable @typescript-eslint/no-explicit-any */

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CASUAL', 'PROBATION'];
const PAY_FREQUENCIES = ['MONTHLY', 'BIWEEKLY', 'WEEKLY', 'DAILY', 'HOURLY'];
const SHIFT_TYPES = ['MORNING', 'AFTERNOON', 'NIGHT', 'SPLIT', 'ROTATING', 'FLEXIBLE'];

/**
 * HrOrgService — HR core masters: departments, positions, employees and
 * shifts. Every model is org-scoped + soft-deleted by the tenancy extension.
 */
@Injectable()
export class HrOrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
  ) {}

  // ── Departments ──────────────────────────────────────────────────────────

  async listDepartments(query: any = {}) {
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId };
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.client.hrDepartment.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        take: Math.min(Number(query.take ?? 100), 200),
        skip: Number(query.skip ?? 0),
        include: { _count: { select: { employees: true, positions: true } } },
      }),
      this.prisma.client.hrDepartment.count({ where }),
    ]);
    return { rows, total };
  }

  async getDepartment(id: string) {
    const orgId = this.tenant.organizationId;
    const row = await this.prisma.client.hrDepartment.findFirst({
      where: { id, organizationId: orgId },
      include: { manager: true, positions: true },
    });
    if (!row) throw new NotFoundException('Department not found');
    return row;
  }

  async createDepartment(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.code || !dto.name) throw new BadRequestException('code and name are required');
    const existing = await this.prisma.client.hrDepartment.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: dto.code } },
    });
    if (existing) throw new BadRequestException(`Department code "${dto.code}" already exists`);
    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrDepartment.create({
      data: {
        organizationId: orgId,
        code: String(dto.code).toUpperCase(),
        name: dto.name,
        description: dto.description ?? null,
        managerId: dto.managerId ?? null,
        isActive: dto.isActive ?? true,
        createdBy: userId,
      },
      }),
      (row) => ({
        entity: 'HrDepartment',
        entityId: row.id,
        action: 'create',
        newValues: { code: row.code, name: row.name, managerId: row.managerId },
      }),
    );
  }

  async updateDepartment(id: string, dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrDepartment.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Department not found');
    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrDepartment.update({
        where: { id },
        data: {
          name: dto.name ?? row.name,
          description: dto.description !== undefined ? dto.description : row.description,
          managerId: dto.managerId !== undefined ? dto.managerId : row.managerId,
          isActive: dto.isActive ?? row.isActive,
          updatedBy: userId,
        },
      }),
      (updated) => ({
        entity: 'HrDepartment',
        entityId: id,
        action: 'update',
        oldValues: { name: row.name, managerId: row.managerId, isActive: row.isActive },
        newValues: { name: updated.name, managerId: updated.managerId, isActive: updated.isActive },
      }),
    );
  }

  async deleteDepartment(id: string) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrDepartment.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Department not found');
    const employeeCount = await this.prisma.client.hrEmployee.count({
      where: { organizationId: orgId, departmentId: id },
    });
    if (employeeCount > 0)
      throw new BadRequestException('Department still has employees — reassign them first');
    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrDepartment.update({
        where: { id },
        data: { deletedAt: new Date(), updatedBy: userId },
      }),
      () => ({
        entity: 'HrDepartment',
        entityId: id,
        action: 'delete',
        oldValues: { code: row.code, name: row.name },
      }),
    );
  }

  // ── Positions ────────────────────────────────────────────────────────────

  async listPositions(query: any = {}) {
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId };
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.client.hrPosition.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        take: Math.min(Number(query.take ?? 100), 200),
        skip: Number(query.skip ?? 0),
        include: { department: true, _count: { select: { employees: true } } },
      }),
      this.prisma.client.hrPosition.count({ where }),
    ]);
    return { rows, total };
  }

  async createPosition(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.code || !dto.name) throw new BadRequestException('code and name are required');
    const existing = await this.prisma.client.hrPosition.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: dto.code } },
    });
    if (existing) throw new BadRequestException(`Position code "${dto.code}" already exists`);
    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrPosition.create({
      data: {
        organizationId: orgId,
        code: String(dto.code).toUpperCase(),
        name: dto.name,
        departmentId: dto.departmentId ?? null,
        defaultSalary: dto.defaultSalary ?? null,
        isActive: dto.isActive ?? true,
        createdBy: userId,
      },
      }),
      (row) => ({
        entity: 'HrPosition',
        entityId: row.id,
        action: 'create',
        newValues: { code: row.code, name: row.name, departmentId: row.departmentId },
      }),
    );
  }

  async updatePosition(id: string, dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrPosition.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Position not found');
    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrPosition.update({
        where: { id },
        data: {
          name: dto.name ?? row.name,
          departmentId: dto.departmentId !== undefined ? dto.departmentId : row.departmentId,
          defaultSalary: dto.defaultSalary !== undefined ? dto.defaultSalary : row.defaultSalary,
          isActive: dto.isActive ?? row.isActive,
          updatedBy: userId,
        },
      }),
      (updated) => ({
        entity: 'HrPosition',
        entityId: id,
        action: 'update',
        // defaultSalary is a pay band, so a change to it belongs in the trail.
        oldValues: { name: row.name, defaultSalary: row.defaultSalary, isActive: row.isActive },
        newValues: {
          name: updated.name,
          defaultSalary: updated.defaultSalary,
          isActive: updated.isActive,
        },
      }),
    );
  }

  async deletePosition(id: string) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrPosition.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Position not found');
    const employeeCount = await this.prisma.client.hrEmployee.count({
      where: { organizationId: orgId, positionId: id },
    });
    if (employeeCount > 0)
      throw new BadRequestException('Position still has employees — reassign them first');
    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrPosition.update({
        where: { id },
        data: { deletedAt: new Date(), updatedBy: userId },
      }),
      () => ({
        entity: 'HrPosition',
        entityId: id,
        action: 'delete',
        oldValues: { code: row.code, name: row.name },
      }),
    );
  }

  // ── Employees ────────────────────────────────────────────────────────────

  async listEmployees(query: any = {}) {
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId };
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.positionId) where.positionId = query.positionId;
    if (query.employmentType) where.employmentType = query.employmentType;
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
    if (query.search) {
      const term = query.search;
      where.OR = [
        { employeeCode: { contains: term, mode: 'insensitive' } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.client.hrEmployee.findMany({
        where,
        orderBy: [{ employeeCode: 'asc' }],
        take: Math.min(Number(query.take ?? 50), 200),
        skip: Number(query.skip ?? 0),
        include: {
          department: true,
          position: true,
          supervisor: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
      }),
      this.prisma.client.hrEmployee.count({ where }),
    ]);
    return { rows: redactEmployees(rows as any[], this.canSeeCompensation()), total };
  }

  async getEmployee(id: string) {
    const orgId = this.tenant.organizationId;
    const row = await this.prisma.client.hrEmployee.findFirst({
      where: { id, organizationId: orgId },
      include: {
        department: true,
        position: true,
        supervisor: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        leaveBalances: { include: { leaveType: true } },
        loans: { where: { deletedAt: null } },
        salaryAdvances: { where: { deletedAt: null } },
        shiftAssignments: { include: { shift: true } },
        // The linked account is deliberately NOT expanded here. This route is
        // gated on `hr:read` — the directory permission — and the account
        // carries role and permission grants, which is access-control data, not
        // directory data. The Employee 360 "System Access" panel reads it from
        // GET /hr/employees/:id/access instead, behind `hr:access`. The bare
        // `userId` column still rides along on the row, which only reveals that
        // the person has an account.
      },
    });
    if (!row) throw new NotFoundException('Employee not found');
    return redactEmployee(row as any, this.canSeeCompensation());
  }

  /** True when the caller may read or write compensation-grade fields. */
  private canSeeCompensation(): boolean {
    return this.tenant.has(PERMISSIONS.hr.compensation);
  }

  /**
   * Reject an attempt to set pay/bank/ID fields without `hr:compensation`.
   *
   * Refuses loudly rather than silently dropping the fields — an HR officer who
   * types a salary and gets a 200 back would reasonably believe it saved.
   */
  private assertMayWriteCompensation(dto: Record<string, any>): void {
    if (this.canSeeCompensation()) return;
    const attempted = HR_COMPENSATION_FIELDS.filter((f) => dto[f] !== undefined);
    if (attempted.length > 0) {
      throw new ForbiddenException(
        `Setting ${attempted.join(', ')} requires the ${PERMISSIONS.hr.compensation} permission.`,
      );
    }
  }

  async createEmployee(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.firstName) throw new BadRequestException('firstName is required');
    const employeeCode =
      dto.employeeCode ?? (await this.seq.next('hr_employee', { prefix: 'EMP-', padding: 5 }));
    const existing = await this.prisma.client.hrEmployee.findUnique({
      where: { organizationId_employeeCode: { organizationId: orgId, employeeCode } },
    });
    if (existing) throw new BadRequestException(`Employee code "${employeeCode}" already exists`);
    if (dto.employmentType && !EMPLOYMENT_TYPES.includes(dto.employmentType))
      throw new BadRequestException(`Invalid employmentType: ${dto.employmentType}`);
    if (dto.payFrequency && !PAY_FREQUENCIES.includes(dto.payFrequency))
      throw new BadRequestException(`Invalid payFrequency: ${dto.payFrequency}`);
    this.assertMayWriteCompensation(dto);
    // `userId` is deliberately NOT accepted here. Linking an employee to a
    // login is an identity-control action gated on `hr:access` and recorded in
    // the audit trail — see HrAccessService.linkUser. Accepting it as a plain
    // create field is how an unvalidated cross-tenant link became possible.
    return this.prisma.client.$transaction(async (tx: any) => {
      const created = await tx.hrEmployee.create({
      data: {
        organizationId: orgId,
        employeeCode,
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        photoUrl: dto.photoUrl ?? null,
        gender: dto.gender ?? null,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
        address: dto.address ?? null,
        employmentType: dto.employmentType ?? 'FULL_TIME',
        hireDate: dto.hireDate ? new Date(dto.hireDate) : null,
        contractEndDate: dto.contractEndDate ? new Date(dto.contractEndDate) : null,
        probationEndDate: dto.probationEndDate ? new Date(dto.probationEndDate) : null,
        departmentId: dto.departmentId ?? null,
        positionId: dto.positionId ?? null,
        supervisorId: dto.supervisorId ?? null,
        baseSalary: dto.baseSalary ?? null,
        payFrequency: dto.payFrequency ?? 'MONTHLY',
        hourlyRate: dto.hourlyRate ?? null,
        bankName: dto.bankName ?? null,
        bankAccountName: dto.bankAccountName ?? null,
        bankAccountNumber: dto.bankAccountNumber ?? null,
        mobileMoneyProvider: dto.mobileMoneyProvider ?? null,
        mobileMoneyNumber: dto.mobileMoneyNumber ?? null,
        taxNumber: dto.taxNumber ?? null,
        pensionNumber: dto.pensionNumber ?? null,
        socialSecurityNumber: dto.socialSecurityNumber ?? null,
        isActive: dto.isActive ?? true,
        notes: dto.notes ?? null,
        createdBy: userId,
      },
      });
      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: created.id,
        action: 'create',
        newValues: {
          employeeCode: created.employeeCode,
          firstName: created.firstName,
          lastName: created.lastName,
          departmentId: created.departmentId,
          positionId: created.positionId,
        },
      });
      return redactEmployee(created as any, this.canSeeCompensation());
    });
  }

  async updateEmployee(id: string, dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrEmployee.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Employee not found');
    if (dto.employmentType && !EMPLOYMENT_TYPES.includes(dto.employmentType))
      throw new BadRequestException(`Invalid employmentType: ${dto.employmentType}`);
    if (dto.payFrequency && !PAY_FREQUENCIES.includes(dto.payFrequency))
      throw new BadRequestException(`Invalid payFrequency: ${dto.payFrequency}`);
    this.assertMayWriteCompensation(dto);
    const data: any = {};
    // `userId` is NOT in this list. It used to be, with no existence, tenancy
    // or duplicate check, which let any `hr:employee` holder point an employee
    // at an arbitrary user id — including one in another organization. Linking
    // now goes through HrAccessService, gated on `hr:access` and audited.
    const fields = [
      'firstName', 'lastName', 'email', 'phone', 'photoUrl', 'gender', 'address',
      'employmentType', 'departmentId', 'positionId', 'supervisorId', 'baseSalary',
      'payFrequency', 'hourlyRate', 'bankName', 'bankAccountName', 'bankAccountNumber',
      'mobileMoneyProvider', 'mobileMoneyNumber', 'taxNumber', 'pensionNumber',
      'socialSecurityNumber', 'isActive', 'notes',
    ];
    for (const f of fields) {
      if (dto[f] !== undefined) data[f] = dto[f];
    }
    for (const f of ['dateOfBirth', 'hireDate', 'contractEndDate', 'probationEndDate']) {
      if (dto[f] !== undefined) data[f] = dto[f] ? new Date(dto[f]) : null;
    }
    data.updatedBy = userId;

    // Capture only the fields actually changing, so the audit entry is a real
    // before/after rather than a dump of the whole row.
    const oldValues: Record<string, unknown> = {};
    for (const f of Object.keys(data)) {
      if (f !== 'updatedBy') oldValues[f] = (row as any)[f];
    }

    return this.prisma.client.$transaction(async (tx: any) => {
      const updated = await tx.hrEmployee.update({ where: { id }, data });
      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: id,
        action: 'update',
        oldValues,
        newValues: data,
      });
      return redactEmployee(updated as any, this.canSeeCompensation());
    });
  }

  async deleteEmployee(id: string) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrEmployee.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Employee not found');
    return this.prisma.client.$transaction(async (tx: any) => {
      const deleted = await tx.hrEmployee.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
      });
      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: id,
        action: 'delete',
        oldValues: { employeeCode: row.employeeCode, isActive: row.isActive },
      });
      return deleted;
    });
  }

  // ── Shifts ───────────────────────────────────────────────────────────────

  async listShifts(query: any = {}) {
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId };
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.client.hrShift.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        take: Math.min(Number(query.take ?? 100), 200),
        skip: Number(query.skip ?? 0),
        include: { _count: { select: { assignments: true } } },
      }),
      this.prisma.client.hrShift.count({ where }),
    ]);
    return { rows, total };
  }

  async createShift(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.code || !dto.name || !dto.startTime || !dto.endTime)
      throw new BadRequestException('code, name, startTime and endTime are required');
    if (dto.shiftType && !SHIFT_TYPES.includes(dto.shiftType))
      throw new BadRequestException(`Invalid shiftType: ${dto.shiftType}`);
    const existing = await this.prisma.client.hrShift.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: dto.code } },
    });
    if (existing) throw new BadRequestException(`Shift code "${dto.code}" already exists`);
    return this.prisma.client.hrShift.create({
      data: {
        organizationId: orgId,
        code: String(dto.code).toUpperCase(),
        name: dto.name,
        shiftType: dto.shiftType ?? 'MORNING',
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakStart: dto.breakStart ?? null,
        breakEnd: dto.breakEnd ?? null,
        graceMinutes: dto.graceMinutes ?? 10,
        maxOvertimeMinutes: dto.maxOvertimeMinutes ?? 180,
        isActive: dto.isActive ?? true,
        description: dto.description ?? null,
        createdBy: userId,
      },
    });
  }

  async updateShift(id: string, dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrShift.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Shift not found');
    if (dto.shiftType && !SHIFT_TYPES.includes(dto.shiftType))
      throw new BadRequestException(`Invalid shiftType: ${dto.shiftType}`);
    const data: any = {};
    const fields = [
      'name', 'shiftType', 'startTime', 'endTime', 'breakStart', 'breakEnd',
      'graceMinutes', 'maxOvertimeMinutes', 'isActive', 'description',
    ];
    for (const f of fields) {
      if (dto[f] !== undefined) data[f] = dto[f];
    }
    data.updatedBy = userId;
    return this.prisma.client.hrShift.update({ where: { id }, data });
  }

  async deleteShift(id: string) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrShift.findFirst({ where: { id, organizationId: orgId } });
    if (!row) throw new NotFoundException('Shift not found');
    return this.prisma.client.hrShift.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
  }

  // ── Shift assignments ────────────────────────────────────────────────────

  async listAssignments(query: any = {}) {
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId };
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.shiftId) where.shiftId = query.shiftId;
    const [rows, total] = await Promise.all([
      this.prisma.client.hrShiftAssignment.findMany({
        where,
        orderBy: [{ effectiveFrom: 'desc' }],
        take: Math.min(Number(query.take ?? 100), 200),
        skip: Number(query.skip ?? 0),
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
          shift: true,
        },
      }),
      this.prisma.client.hrShiftAssignment.count({ where }),
    ]);
    return { rows, total };
  }

  async assignShift(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.employeeId || !dto.shiftId)
      throw new BadRequestException('employeeId and shiftId are required');
    // Deactivate any overlapping active assignment for the employee.
    await this.prisma.client.hrShiftAssignment.updateMany({
      where: { organizationId: orgId, employeeId: dto.employeeId, isActive: true },
      data: { isActive: false },
    });
    return this.prisma.client.hrShiftAssignment.create({
      data: {
        organizationId: orgId,
        employeeId: dto.employeeId,
        shiftId: dto.shiftId,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
        isActive: true,
        createdBy: userId,
      },
    });
  }

  async revokeAssignment(id: string) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrShiftAssignment.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Assignment not found');
    return this.prisma.client.hrShiftAssignment.update({
      where: { id },
      data: { isActive: false, updatedAt: new Date(), deletedAt: new Date(), createdBy: userId },
    });
  }
}
