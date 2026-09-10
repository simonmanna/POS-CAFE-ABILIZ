import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { writeAudited } from './hr-audit.util';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DOCUMENT_TYPES = [
  'CONTRACT',
  'OFFER_LETTER',
  'ID_DOCUMENT',
  'CERTIFICATE',
  'WORK_PERMIT',
  'TRAINING_CERTIFICATE',
  'DISCIPLINARY',
  'OTHER',
];
const TRAINING_STATUSES = ['ENROLLED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * HrDocumentsService — employee paperwork and training.
 *
 * Documents sit behind `hr:document`, not `hr:read`: someone who can look up a
 * colleague's extension number has no business reading their contract or
 * passport. The bytes themselves live in the existing `File` model
 * (`ownerType: 'HrEmployee'`) — this service only owns the HR metadata, so
 * there is no second storage or upload path to secure.
 */
@Injectable()
export class HrDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  // ── Employee documents ───────────────────────────────────────────────────

  async list(query: any = {}) {
    const where: any = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.documentType) where.documentType = query.documentType;
    if (query.expiringBefore) where.expiresAt = { lte: new Date(query.expiringBefore) };

    const [rows, total] = await Promise.all([
      this.prisma.client.hrEmployeeDocument.findMany({
        where,
        include: {
          employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: Math.min(Number(query.take ?? 50), 200),
        skip: Number(query.skip ?? 0),
      }),
      this.prisma.client.hrEmployeeDocument.count({ where }),
    ]);
    return { rows, total };
  }

  /** Documents due to expire — work permits and contracts that need renewing. */
  async expiring(days = 60) {
    const until = new Date();
    until.setDate(until.getDate() + Number(days));
    const rows = await this.prisma.client.hrEmployeeDocument.findMany({
      where: { expiresAt: { not: null, lte: until } },
      include: {
        employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
      },
      orderBy: { expiresAt: 'asc' },
      take: 200,
    });
    return { rows, total: rows.length };
  }

  async create(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.employeeId || !dto.title) {
      throw new BadRequestException('employeeId and title are required');
    }
    if (dto.documentType && !DOCUMENT_TYPES.includes(dto.documentType)) {
      throw new BadRequestException(`Invalid documentType: ${dto.documentType}`);
    }
    await this.assertEmployee(dto.employeeId);
    this.assertDateOrder(dto.issuedAt, dto.expiresAt);

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) =>
        tx.hrEmployeeDocument.create({
          data: {
            organizationId: orgId,
            employeeId: dto.employeeId,
            documentType: dto.documentType ?? 'OTHER',
            title: dto.title,
            fileId: dto.fileId ?? null,
            documentNumber: dto.documentNumber ?? null,
            issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            notes: dto.notes ?? null,
            createdBy: userId,
          },
        }),
      (row) => ({
        entity: 'HrEmployeeDocument',
        entityId: row.id,
        action: 'create',
        newValues: {
          employeeId: row.employeeId,
          documentType: row.documentType,
          title: row.title,
          expiresAt: row.expiresAt,
        },
      }),
    );
  }

  async update(id: string, dto: any) {
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrEmployeeDocument.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Document not found');
    if (dto.documentType && !DOCUMENT_TYPES.includes(dto.documentType)) {
      throw new BadRequestException(`Invalid documentType: ${dto.documentType}`);
    }
    this.assertDateOrder(dto.issuedAt ?? row.issuedAt, dto.expiresAt ?? row.expiresAt);

    const data: any = { updatedBy: userId };
    for (const f of ['documentType', 'title', 'fileId', 'documentNumber', 'notes']) {
      if (dto[f] !== undefined) data[f] = dto[f];
    }
    for (const f of ['issuedAt', 'expiresAt']) {
      if (dto[f] !== undefined) data[f] = dto[f] ? new Date(dto[f]) : null;
    }

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrEmployeeDocument.update({ where: { id }, data }),
      (updated) => ({
        entity: 'HrEmployeeDocument',
        entityId: id,
        action: 'update',
        oldValues: { title: row.title, documentType: row.documentType, expiresAt: row.expiresAt },
        newValues: {
          title: updated.title,
          documentType: updated.documentType,
          expiresAt: updated.expiresAt,
        },
      }),
    );
  }

  async remove(id: string) {
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrEmployeeDocument.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Document not found');

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) =>
        tx.hrEmployeeDocument.update({
          where: { id },
          data: { deletedAt: new Date(), updatedBy: userId },
        }),
      () => ({
        entity: 'HrEmployeeDocument',
        entityId: id,
        action: 'delete',
        oldValues: { employeeId: row.employeeId, title: row.title, documentType: row.documentType },
      }),
    );
  }

  // ── Training programs ────────────────────────────────────────────────────

  async listPrograms(query: any = {}) {
    const where: any = {};
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.client.hrTrainingProgram.findMany({
        where,
        include: { _count: { select: { enrolments: true } } },
        orderBy: [{ name: 'asc' }],
        take: Math.min(Number(query.take ?? 100), 200),
      }),
      this.prisma.client.hrTrainingProgram.count({ where }),
    ]);
    return { rows, total };
  }

  async createProgram(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.code || !dto.name) throw new BadRequestException('code and name are required');
    const existing = await this.prisma.client.hrTrainingProgram.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: String(dto.code).toUpperCase() } },
    });
    if (existing) throw new BadRequestException(`Program code "${dto.code}" already exists`);

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) =>
        tx.hrTrainingProgram.create({
          data: {
            organizationId: orgId,
            code: String(dto.code).toUpperCase(),
            name: dto.name,
            description: dto.description ?? null,
            provider: dto.provider ?? null,
            durationHours: dto.durationHours ?? null,
            isActive: dto.isActive ?? true,
            createdBy: userId,
          },
        }),
      (row) => ({
        entity: 'HrTrainingProgram',
        entityId: row.id,
        action: 'create',
        newValues: { code: row.code, name: row.name, provider: row.provider },
      }),
    );
  }

  async updateProgram(id: string, dto: any) {
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrTrainingProgram.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Training program not found');

    const data: any = { updatedBy: userId };
    for (const f of ['name', 'description', 'provider', 'durationHours', 'isActive']) {
      if (dto[f] !== undefined) data[f] = dto[f];
    }

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrTrainingProgram.update({ where: { id }, data }),
      (updated) => ({
        entity: 'HrTrainingProgram',
        entityId: id,
        action: 'update',
        oldValues: { name: row.name, isActive: row.isActive },
        newValues: { name: updated.name, isActive: updated.isActive },
      }),
    );
  }

  async removeProgram(id: string) {
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrTrainingProgram.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Training program not found');
    const enrolled = await this.prisma.client.hrEmployeeTraining.count({ where: { programId: id } });
    if (enrolled > 0) {
      throw new BadRequestException(
        'Program has enrolments — deactivate it instead of deleting, so the training history survives',
      );
    }

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) =>
        tx.hrTrainingProgram.update({
          where: { id },
          data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
        }),
      () => ({
        entity: 'HrTrainingProgram',
        entityId: id,
        action: 'delete',
        oldValues: { code: row.code, name: row.name },
      }),
    );
  }

  // ── Enrolments ───────────────────────────────────────────────────────────

  async listEnrolments(query: any = {}) {
    const where: any = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.programId) where.programId = query.programId;
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.client.hrEmployeeTraining.findMany({
        where,
        include: {
          employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
          program: { select: { id: true, code: true, name: true, provider: true } },
        },
        orderBy: [{ enrolledAt: 'desc' }],
        take: Math.min(Number(query.take ?? 50), 200),
      }),
      this.prisma.client.hrEmployeeTraining.count({ where }),
    ]);
    return { rows, total };
  }

  async enrol(dto: any) {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!dto.employeeId || !dto.programId) {
      throw new BadRequestException('employeeId and programId are required');
    }
    await this.assertEmployee(dto.employeeId);
    const program = await this.prisma.client.hrTrainingProgram.findFirst({
      where: { id: dto.programId },
    });
    if (!program) throw new NotFoundException('Training program not found');

    // Re-enrolling someone already mid-course is almost always a mistake.
    const open = await this.prisma.client.hrEmployeeTraining.findFirst({
      where: {
        employeeId: dto.employeeId,
        programId: dto.programId,
        status: { in: ['ENROLLED', 'IN_PROGRESS'] },
      },
    });
    if (open) {
      throw new BadRequestException(
        'This employee is already enrolled on that program and has not finished it',
      );
    }

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) =>
        tx.hrEmployeeTraining.create({
          data: {
            organizationId: orgId,
            employeeId: dto.employeeId,
            programId: dto.programId,
            status: 'ENROLLED',
            trainer: dto.trainer ?? null,
            notes: dto.notes ?? null,
            createdBy: userId,
          },
        }),
      (row) => ({
        entity: 'HrEmployeeTraining',
        entityId: row.id,
        action: 'assign',
        newValues: { employeeId: row.employeeId, programId: row.programId, status: row.status },
      }),
    );
  }

  async updateEnrolment(id: string, dto: any) {
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrEmployeeTraining.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Enrolment not found');
    if (dto.status && !TRAINING_STATUSES.includes(dto.status)) {
      throw new BadRequestException(`Invalid status: ${dto.status}`);
    }

    const data: any = { updatedBy: userId };
    for (const f of ['status', 'score', 'certificateFileId', 'trainer', 'notes']) {
      if (dto[f] !== undefined) data[f] = dto[f];
    }
    if (dto.status === 'IN_PROGRESS' && !row.startedAt) data.startedAt = new Date();
    if (dto.status === 'COMPLETED' && !row.completedAt) data.completedAt = new Date();

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) => tx.hrEmployeeTraining.update({ where: { id }, data }),
      (updated) => ({
        entity: 'HrEmployeeTraining',
        entityId: id,
        action: 'update',
        oldValues: { status: row.status, score: row.score },
        newValues: { status: updated.status, score: updated.score, employeeId: row.employeeId },
      }),
    );
  }

  async removeEnrolment(id: string) {
    const userId = this.tenant.userId;
    const row = await this.prisma.client.hrEmployeeTraining.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Enrolment not found');

    return writeAudited(
      this.prisma,
      this.audit,
      (tx) =>
        tx.hrEmployeeTraining.update({
          where: { id },
          data: { deletedAt: new Date(), updatedBy: userId },
        }),
      () => ({
        entity: 'HrEmployeeTraining',
        entityId: id,
        action: 'delete',
        oldValues: { employeeId: row.employeeId, programId: row.programId, status: row.status },
      }),
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async assertEmployee(employeeId: string): Promise<void> {
    const employee = await this.prisma.client.hrEmployee.findFirst({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException('Employee not found');
  }

  private assertDateOrder(issuedAt: any, expiresAt: any): void {
    if (!issuedAt || !expiresAt) return;
    if (new Date(expiresAt) < new Date(issuedAt)) {
      throw new BadRequestException('expiresAt cannot be before issuedAt');
    }
  }
}
