import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CashRegister } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { BaseCrudService, type CrudDelegate } from '../../../kernel/common/base-crud.service';

@Injectable()
export class CashRegisterService extends BaseCrudService<CashRegister> {
  protected readonly entityName = 'CashRegister';
  protected readonly searchFields = ['code', 'name'];
  protected readonly defaultInclude = { defaultAccount: true, location: true };

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {
    super(prisma.client.cashRegister as unknown as CrudDelegate);
  }

  async create(data: any): Promise<CashRegister> {
    const orgId = this.tenant.organizationId;
    if (data.locationId) {
      const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: data.locationId, organizationId: orgId, isActive: true, deletedAt: null } });
      if (!location) throw new BadRequestException('Select an active inventory location in this organization');
    }
    if (data.branchId) await this.assertBranch(data.branchId);
    const result = await this.prisma.client.$transaction(async (tx) => {
      const drawerCode = `DRW-${data.code}`;
      const existing = await tx.account.findUnique({
        where: { organizationId_code: { organizationId: orgId, code: drawerCode } },
        include: { category: true },
      });
      let drawerAccountId: string;
      if (!existing) {
        const cashCategory = await tx.accountCategory.findFirst({ where: { key: 'cash' } });
        if (!cashCategory) {
          throw new BadRequestException(
            "Account category 'cash' is missing for this organization. " +
              'Run the accounting backfill (prisma/backfill-account-category.ts).',
          );
        }
        const drawerAccount = await tx.account.create({
          data: {
            organizationId: orgId,
            code: drawerCode,
            name: `Cash Drawer - ${data.name}`,
            categoryId: cashCategory.id,
            normalBalance: cashCategory.normalBalance,
            isDefault: false,
          },
        });
        drawerAccountId = drawerAccount.id;
      } else {
        if (!existing.isActive || existing.deletedAt || !['cash', 'petty_cash'].includes(existing.category?.key ?? '')) {
          throw new BadRequestException(`${drawerCode} exists but is not an active drawer cash account`);
        }
        const used = await tx.cashRegister.count({ where: { organizationId: orgId, defaultAccountId: existing.id, isActive: true, deletedAt: null } });
        if (used) throw new BadRequestException('Each active register must use a distinct drawer account');
        drawerAccountId = existing.id;
      }
      return tx.cashRegister.create({
        data: { ...data, organizationId: orgId, defaultAccountId: drawerAccountId },
        include: this.defaultInclude,
      });
    });
    return result;
  }

  async update(id: string, data: any): Promise<CashRegister> {
    const orgId = this.tenant.organizationId;
    const current = await this.prisma.client.cashRegister.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!current) throw new NotFoundException('CashRegister not found');
    const changesCustody = (data.defaultAccountId && data.defaultAccountId !== current.defaultAccountId)
      || (data.locationId !== undefined && data.locationId !== current.locationId)
      || (data.branchId !== undefined && data.branchId !== (current as any).branchId)
      || data.isActive === false;
    if (changesCustody) {
      const open = await this.prisma.client.cashSession.count({ where: { organizationId: orgId, cashRegisterId: id, status: 'open' } });
      if (open) throw new BadRequestException('Close or hand over the active shift before changing its account, location or status');
    }
    if (data.defaultAccountId) await this.assertAvailableDrawerAccount(data.defaultAccountId, id);
    if (data.locationId) {
      const location = await this.prisma.client.inventoryLocation.findFirst({ where: { id: data.locationId, organizationId: orgId, isActive: true, deletedAt: null } });
      if (!location) throw new BadRequestException('Select an active inventory location in this organization');
    }
    if (data.branchId) await this.assertBranch(data.branchId);
    return super.update(id, data);
  }

  async remove(id: string): Promise<void> {
    const open = await this.prisma.client.cashSession.count({ where: { organizationId: this.tenant.organizationId, cashRegisterId: id, status: 'open' } });
    if (open) throw new BadRequestException('An open register cannot be deleted');
    const updated = await this.prisma.client.cashRegister.updateMany({ where: { id, organizationId: this.tenant.organizationId }, data: { deletedAt: new Date(), isActive: false } });
    if (!updated.count) throw new NotFoundException('CashRegister not found');
  }

  private async assertAvailableDrawerAccount(accountId: string, registerId: string) {
    const orgId = this.tenant.organizationId;
    const account = await this.prisma.client.account.findFirst({ where: { id: accountId, organizationId: orgId, isActive: true, deletedAt: null }, include: { category: true } });
    if (!account || !['cash', 'petty_cash'].includes(account.category?.key ?? '')) throw new BadRequestException('Select an active cash or petty-cash account');
    const used = await this.prisma.client.cashRegister.count({ where: { organizationId: orgId, id: { not: registerId }, defaultAccountId: accountId, isActive: true, deletedAt: null } });
    if (used) throw new BadRequestException('Each active register must use a distinct drawer account');
  }

  private async assertBranch(branchId: string) {
    const branch = await this.prisma.client.branch.findFirst({ where: { id: branchId, organizationId: this.tenant.organizationId, isActive: true, deletedAt: null } });
    if (!branch) throw new BadRequestException('Select an active branch in this organization');
  }
}
