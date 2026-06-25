import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';

interface CreateDealInput {
  name: string;
  partnerId: string;
  ownerId?: string;
  stage?: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
  amount?: number;
  currencyCode?: string;
  expectedClose?: string;
  notes?: string;
}

interface UpdateDealInput {
  name?: string;
  stage?: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
  amount?: number;
  expectedClose?: string;
  notes?: string;
  ownerId?: string;
}

interface CreateActivityInput {
  type: 'call' | 'email' | 'meeting' | 'note' | 'task';
  title: string;
  body?: string;
  subjectType?: string;
  subjectId?: string;
  dealId?: string;
  partnerId?: string;
  dueAt?: string;
  duration?: number;
}

interface UpdateActivityInput {
  title?: string;
  body?: string;
  dueAt?: string;
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
  completed?: boolean;
}

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly seq: SequenceService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  // ──────────────── Deals ────────────────

  async createDeal(input: CreateDealInput) {
    const orgId = this.tenant.organizationId;
    const partner = await this.prisma.raw.partner.findFirst({
      where: { organizationId: orgId, id: input.partnerId },
    });
    if (!partner) throw new NotFoundException('Partner not found');
    const deal = await this.prisma.client.deal.create({
      data: {
        organizationId: orgId,
        name: input.name,
        partnerId: input.partnerId,
        ownerId: input.ownerId ?? this.tenant.userId,
        stage: input.stage ?? 'lead',
        amount: input.amount ?? 0,
        currencyCode: input.currencyCode ?? 'USD',
        expectedClose: input.expectedClose ? new Date(input.expectedClose) : null,
        notes: input.notes,
      },
    });
    await this.audit.record({
      entity: 'Deal',
      entityId: deal.id,
      action: 'create',
      newValues: { name: deal.name, stage: deal.stage, amount: Number(deal.amount) },
    });
    this.events.publish('crm.deal.created' as any, {
      organizationId: orgId,
      dealId: deal.id,
      name: deal.name,
      stage: deal.stage,
    });
    return deal;
  }

  async updateDeal(id: string, input: UpdateDealInput) {
    const deal = await this.requireDeal(id);
    const updated = await this.prisma.client.deal.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.expectedClose !== undefined ? { expectedClose: input.expectedClose ? new Date(input.expectedClose) : null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
    });
    await this.audit.record({
      entity: 'Deal',
      entityId: id,
      action: 'update',
      newValues: input as any,
    });
    return updated;
  }

  async changeStage(id: string, stage: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost') {
    const deal = await this.requireDeal(id);
    const updated = await this.prisma.client.deal.update({
      where: { id },
      data: { stage },
    });
    // Auto-create a deal_stage_change activity so the timeline is complete.
    await this.prisma.client.activity.create({
      data: {
        organizationId: this.tenant.organizationId,
        type: 'deal_stage_change',
        title: `Stage: ${deal.stage} → ${stage}`,
        dealId: id,
        partnerId: deal.partnerId,
        occurredAt: new Date(),
        createdById: this.tenant.userId ?? null,
      },
    });
    this.events.publish('crm.deal.stage_changed' as any, {
      organizationId: this.tenant.organizationId,
      dealId: id,
      fromStage: deal.stage,
      toStage: stage,
    });
    return updated;
  }

  async listDeals(query: { stage?: string; partnerId?: string }) {
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.stage) where.stage = query.stage;
    if (query.partnerId) where.partnerId = query.partnerId;
    return this.prisma.client.deal.findMany({
      where,
      include: { partner: { select: { name: true, code: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  async findDeal(id: string) {
    return this.prisma.client.deal.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: { partner: true, activities: { orderBy: { occurredAt: 'desc' }, take: 50 } },
    });
  }

  async removeDeal(id: string) {
    const deal = await this.requireDeal(id);
    if (deal.stage === 'won') throw new BadRequestException('Cannot delete a won deal; archive it instead');
    await this.prisma.client.deal.delete({ where: { id } });
    return { ok: true };
  }

  // ──────────────── Activities ────────────────

  async createActivity(input: CreateActivityInput) {
    const orgId = this.tenant.organizationId;
    if (input.dealId) {
      const deal = await this.prisma.raw.deal.findFirst({ where: { id: input.dealId, organizationId: orgId } });
      if (!deal) throw new NotFoundException('Deal not found');
    }
    if (input.partnerId) {
      const partner = await this.prisma.raw.partner.findFirst({ where: { id: input.partnerId, organizationId: orgId } });
      if (!partner) throw new NotFoundException('Partner not found');
    }
    const activity = await this.prisma.client.activity.create({
      data: {
        organizationId: orgId,
        type: input.type,
        title: input.title,
        body: input.body,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        dealId: input.dealId,
        partnerId: input.partnerId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        duration: input.duration,
        status: input.type === 'task' ? 'todo' : 'todo',
        createdById: this.tenant.userId ?? null,
      },
    });
    return activity;
  }

  async updateActivity(id: string, input: UpdateActivityInput) {
    const activity = await this.requireActivity(id);
    const updated = await this.prisma.client.activity.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.completed !== undefined ? { completed: input.completed, completedAt: input.completed ? new Date() : null } : {}),
      },
    });
    return updated;
  }

  async completeActivity(id: string) {
    await this.requireActivity(id);
    return this.prisma.client.activity.update({
      where: { id },
      data: { status: 'done', completed: true, completedAt: new Date() },
    });
  }

  async listActivities(query: { type?: string; dealId?: string; partnerId?: string; status?: string }) {
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.type) where.type = query.type;
    if (query.dealId) where.dealId = query.dealId;
    if (query.partnerId) where.partnerId = query.partnerId;
    if (query.status) where.status = query.status;
    return this.prisma.client.activity.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
  }

  async upcomingTasks(limit: number) {
    return this.prisma.client.activity.findMany({
      where: {
        organizationId: this.tenant.organizationId,
        type: 'task',
        status: { in: ['todo', 'in_progress'] },
        OR: [{ dueAt: null }, { dueAt: { gte: new Date() } }],
      },
      orderBy: { dueAt: 'asc' },
      take: limit,
    });
  }

  async removeActivity(id: string) {
    await this.requireActivity(id);
    await this.prisma.client.activity.delete({ where: { id } });
    return { ok: true };
  }

  private async requireDeal(id: string) {
    const deal = await this.prisma.client.deal.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
    });
    if (!deal) throw new NotFoundException('Deal not found');
    return deal;
  }

  private async requireActivity(id: string) {
    const a = await this.prisma.client.activity.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
    });
    if (!a) throw new NotFoundException('Activity not found');
    return a;
  }
}
