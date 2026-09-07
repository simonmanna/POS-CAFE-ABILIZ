import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';

@Controller('fiscal-periods')
export class FiscalPeriodCrudController {
  private readonly log = new Logger('FiscalPeriodCrudController');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /** List fiscal periods for this org. */
  @Get()
  @RequirePermissions(PERMISSIONS.fiscalPeriod.read)
  async list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const p = Number(page) || 1;
    const ps = Math.min(Number(pageSize) || 50, 200);
    const orgId = this.tenant.organizationId;
    const where: any = { organizationId: orgId };
    const [data, total] = await Promise.all([
      this.prisma.client.fiscalPeriod.findMany({
        where,
        orderBy: { startDate: 'desc' },
        skip: (p - 1) * ps,
        take: ps,
      }),
      this.prisma.client.fiscalPeriod.count({ where }),
    ]);
    return {
      data,
      meta: { page: p, pageSize: ps, total, totalPages: Math.max(1, Math.ceil(total / ps)) },
    };
  }

  /** Get a single period. */
  @Get(':id')
  @RequirePermissions(PERMISSIONS.fiscalPeriod.read)
  async findOne(@Param('id') id: string) {
    const item = await this.prisma.client.fiscalPeriod.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
    });
    if (!item) throw new NotFoundException('Fiscal period not found');
    return item;
  }

  /** Create a new fiscal period. */
  @Post()
  @RequirePermissions(PERMISSIONS.fiscalPeriod.create)
  async create(
    @Body() dto: { name: string; startDate: string; endDate: string; status?: string },
  ) {
    return this.prisma.client.fiscalPeriod.create({
      data: {
        organizationId: this.tenant.organizationId,
        name: dto.name,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        status: (dto.status as any) ?? 'open',
      },
    });
  }

  /** Update a period's metadata (not close/lock/reopen — those are separate ops). */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.fiscalPeriod.update)
  async update(
    @Param('id') id: string,
    @Body() dto: { name?: string; startDate?: string; endDate?: string },
  ) {
    const data: any = {};
    if (dto.name) data.name = dto.name;
    // C-07: once a period carries posted journals, its date range is financially
    // significant. Refuse to mutate start/end dates after accounting activity so a
    // period cannot be stretched to absorb or relocate postings retroactively. The
    // controlled period-close/reopen flow is the sanctioned path.
    if (dto.startDate || dto.endDate) {
      const count = await this.prisma.client.journalEntry.count({
        where: {
          organizationId: this.tenant.organizationId,
          ...(dto.startDate
            ? { postingDate: { gte: new Date(dto.startDate) } }
            : {}),
          ...(dto.endDate
            ? { postingDate: { lte: new Date(dto.endDate) } }
            : {}),
        },
      });
      if (count > 0) {
        throw new BadRequestException(
          'This fiscal period (or date range) already has posted journals. Do not change period dates after accounting activity — reopen via the controlled period-close report instead.',
        );
      }
    }
    if (dto.startDate) data.startDate = new Date(dto.startDate);
    if (dto.endDate) data.endDate = new Date(dto.endDate);
    const r = await this.prisma.client.fiscalPeriod.updateMany({
      where: { id, organizationId: this.tenant.organizationId },
      data,
    });
    if (r.count === 0) throw new NotFoundException('Fiscal period not found');
    return { updated: true };
  }
}
