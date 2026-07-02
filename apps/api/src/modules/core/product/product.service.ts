import { Injectable } from '@nestjs/common';
import type { Product } from '@prisma/client';
import type { PaginatedResult, PaginationQuery } from '@erp/shared';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@erp/shared';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../../kernel/audit/audit.service';
import { BaseCrudService, type CrudDelegate } from '../../../kernel/common/base-crud.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductService extends BaseCrudService<Product, CreateProductDto, UpdateProductDto> {
  protected readonly entityName = 'Product';
  protected readonly searchFields = ['code', 'sku', 'name'];
  protected readonly defaultInclude = { category: true, uom: true, tax: true };

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {
    super(prisma.client.product as unknown as CrudDelegate);
  }

  async list(query: PaginationQuery & { categoryId?: string; productType?: string }): Promise<PaginatedResult<Product>> {
    const page = Math.max(1, Number(query.page) || DEFAULT_PAGE);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || DEFAULT_PAGE_SIZE));

    const where: Record<string, unknown> = {};
    if (query.search && this.searchFields.length > 0) {
      where.OR = this.searchFields.map((field) => ({
        [field]: { contains: query.search, mode: 'insensitive' },
      }));
    }
    if (query.categoryId) (where as any).categoryId = query.categoryId;
    if (query.productType) (where as any).productType = query.productType;

    const orderBy = query.sortBy
      ? { [query.sortBy]: query.sortOrder ?? 'asc' }
      : this.defaultOrderBy;

    const [data, total] = await Promise.all([
      this.delegate.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: this.defaultInclude,
      }),
      this.delegate.count({ where }),
    ]);

    return {
      data: data as Product[],
      meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const product = await super.create(dto);
    this.events.publish('product.created', {
      id: product.id,
      organizationId: this.tenant.organizationId,
    });
    await this.audit.record({
      entity: 'Product',
      entityId: product.id,
      action: 'create',
      newValues: product,
    });
    return product;
  }

  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const product = await super.update(id, dto);
    this.events.publish('product.updated', {
      id: product.id,
      organizationId: this.tenant.organizationId,
    });
    await this.audit.record({
      entity: 'Product',
      entityId: id,
      action: 'update',
      newValues: product,
    });
    return product;
  }

  async remove(id: string): Promise<void> {
    await super.remove(id);
    this.events.publish('product.deleted', {
      id,
      organizationId: this.tenant.organizationId,
    });
    await this.audit.record({ entity: 'Product', entityId: id, action: 'delete' });
  }

  async search(q: string, pageSize = 20) {
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId, isActive: true };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
      ];
    }
    return this.prisma.client.product.findMany({
      where,
      take: pageSize,
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, salesPrice: true, productType: true, station: true, categoryId: true },
    });
  }
}
