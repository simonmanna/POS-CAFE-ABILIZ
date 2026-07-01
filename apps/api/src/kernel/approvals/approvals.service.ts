import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { EventBus } from '../events/event-bus';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';

/**
 * F.5 — Generic approval workflow runner.
 *
 * Decoupled from any specific document type. A policy says: "for entityType X
 * with amount >= minAmount, require N approvers holding any of
 * approverPermissions to decide." A request is created when a caller calls
 * `requestApproval(...)`. Approvers then call `decide(...)` to approve or
 * reject; once `requiredCount` approvals accumulate (or any rejection occurs),
 * the request resolves.
 *
 * Consumers wire the post-approval action via the workflow engine (e.g. "once
 * approved, post the expense" — see AccountingApprovalsInitializer).
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
  ) {}

  /** Create a request. Resolves the matching policy automatically. */
  async requestApproval(params: {
    entityType: string;
    entityId: string;
    snapshot: Record<string, unknown>;
    policyId?: string;
  }) {
    const orgId = this.tenant.organizationId;
    const policy = params.policyId
      ? await this.prisma.client.approvalPolicy.findFirst({ where: { id: params.policyId, organizationId: orgId } })
      : await this.prisma.client.approvalPolicy.findFirst({
          where: { organizationId: orgId, entityType: params.entityType, isActive: true },
          orderBy: { requiredCount: 'desc' },
        });
    if (!policy) {
      // No policy → no approval required. Caller proceeds.
      return null;
    }
    if (policy.minAmount) {
      const amt = Number((params.snapshot.amount as string | number | undefined) ?? 0);
      if (amt < Number(policy.minAmount)) return null;
    }
    const req = await this.prisma.client.approvalRequest.create({
      data: {
        organizationId: orgId,
        entityType: params.entityType,
        entityId: params.entityId,
        snapshot: params.snapshot as any,
        policyId: policy.id,
        requiredCount: policy.requiredCount,
        createdById: this.tenant.userId ?? null,
      },
    });
    await this.audit.record({
      entity: 'ApprovalRequest',
      entityId: req.id,
      action: 'create',
      newValues: { entityType: req.entityType, entityId: req.entityId },
    });
    this.events.publish('approval.requested' as any, {
      organizationId: orgId,
      requestId: req.id,
      entityType: req.entityType,
      entityId: req.entityId,
    });
    return req;
  }

  /** Approver decides. Idempotent per (requestId, approverId). */
  async decide(params: {
    requestId: string;
    status: 'approved' | 'rejected';
    comment?: string;
  }) {
    const userId = this.tenant.userId;
    if (!userId) throw new BadRequestException('Not authenticated');
    const orgId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx) => {
      const req = await tx.approvalRequest.findFirst({
        where: { id: params.requestId, organizationId: orgId },
        include: { policy: true, decisions: true },
      });
      if (!req) throw new NotFoundException('Approval request not found');
      if (req.status !== 'pending') throw new BadRequestException('Already resolved');

      // Permission check: user must hold any of the policy's approver permissions.
      const perms = this.tenant.permissions ?? [];
      const allowed = (req.policy?.approverPermissions ?? []).some((p) => perms.includes(p));
      if (!allowed && req.policy?.approverPermissions.length) {
        throw new BadRequestException('You are not allowed to decide on this request');
      }
      // Self-approval forbidden.
      if (req.createdById && req.createdById === userId && req.policy?.approverPermissions.length) {
        throw new BadRequestException('You cannot approve a request you created');
      }
      const existing = req.decisions.find((d) => d.approverId === userId);
      if (existing) throw new BadRequestException('You already decided on this request');

      await tx.approvalDecision.create({
        data: {
          organizationId: orgId,
          requestId: req.id,
          approverId: userId,
          status: params.status,
          comment: params.comment ?? null,
        },
      });

      // Re-fetch to count.
      const all = await tx.approvalDecision.findMany({ where: { requestId: req.id } });
      const approvals = all.filter((d) => d.status === 'approved').length;
      const rejections = all.filter((d) => d.status === 'rejected').length;
      let nextStatus: 'pending' | 'approved' | 'rejected' | 'cancelled' = 'pending';
      let decidedAt: Date | null = null;
      if (rejections > 0) {
        nextStatus = 'rejected';
        decidedAt = new Date();
      } else if (approvals >= req.requiredCount) {
        nextStatus = 'approved';
        decidedAt = new Date();
      }
      const updated = await tx.approvalRequest.update({
        where: { id: req.id },
        data: { status: nextStatus, ...(decidedAt ? { decidedAt } : {}) },
      });
      this.events.publish('approval.decided' as any, {
        organizationId: orgId,
        requestId: req.id,
        status: nextStatus,
      });
      await this.audit.recordInTx(tx, {
        entity: 'ApprovalRequest',
        entityId: req.id,
        action: params.status === 'approved' ? 'approve' : 'reject',
        newValues: { status: nextStatus, comment: params.comment ?? null },
      });
      return updated;
    });
  }

  list(query: { status?: 'pending' | 'approved' | 'rejected' | 'cancelled'; entityType?: string }) {
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.status) where.status = query.status;
    if (query.entityType) where.entityType = query.entityType;
    return this.prisma.client.approvalRequest.findMany({
      where,
      include: { decisions: true, policy: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  findOne(id: string) {
    return this.prisma.client.approvalRequest.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: { decisions: true, policy: true },
    });
  }
}
