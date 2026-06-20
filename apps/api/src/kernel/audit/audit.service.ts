import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditAction } from '@erp/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

export interface AuditInput {
  entity: string;
  entityId: string;
  action: AuditAction;
  oldValues?: unknown;
  newValues?: unknown;
}

/** Central audit trail (ADR-006). Failures here must never break business flow. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async record(input: AuditInput): Promise<void> {
    const organizationId = this.tenant.optionalOrganizationId;
    if (!organizationId) return;
    try {
      await this.prisma.client.auditLog.create({
        data: {
          organizationId,
          entity: input.entity,
          entityId: input.entityId,
          action: input.action,
          oldValues: (input.oldValues ?? undefined) as Prisma.InputJsonValue | undefined,
          newValues: (input.newValues ?? undefined) as Prisma.InputJsonValue | undefined,
          actorId: this.tenant.userId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to write audit log: ${String(err)}`);
    }
  }
}
