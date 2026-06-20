import { Injectable } from '@nestjs/common';
import type { Partner } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { BaseCrudService, type CrudDelegate } from '../../../kernel/common/base-crud.service';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { UpdatePartnerDto } from './dto/update-partner.dto';

@Injectable()
export class PartnerService extends BaseCrudService<Partner, CreatePartnerDto, UpdatePartnerDto> {
  protected readonly entityName = 'Partner';
  protected readonly searchFields = ['code', 'name', 'email', 'phone', 'taxNumber'];
  protected readonly defaultInclude = { category: true };

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {
    super(prisma.client.partner as unknown as CrudDelegate);
  }

  async create(dto: CreatePartnerDto): Promise<Partner> {
    const partner = await super.create(dto);
    this.events.publish('partner.created', {
      id: partner.id,
      organizationId: this.tenant.organizationId,
    });
    await this.audit.record({
      entity: 'Partner',
      entityId: partner.id,
      action: 'create',
      newValues: partner,
    });
    return partner;
  }

  async update(id: string, dto: UpdatePartnerDto): Promise<Partner> {
    const partner = await super.update(id, dto);
    this.events.publish('partner.updated', {
      id: partner.id,
      organizationId: this.tenant.organizationId,
    });
    await this.audit.record({
      entity: 'Partner',
      entityId: id,
      action: 'update',
      newValues: partner,
    });
    return partner;
  }

  async remove(id: string): Promise<void> {
    await super.remove(id);
    this.events.publish('partner.deleted', {
      id,
      organizationId: this.tenant.organizationId,
    });
    await this.audit.record({ entity: 'Partner', entityId: id, action: 'delete' });
  }
}
