import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { REPORT_VISIBILITY_SETTING_KEY } from '@erp/shared';
import { ReportAccessService } from '../../src/kernel/reports/report-access.service';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { SettingsService } from '../../src/kernel/settings/settings.service';

const CASHIER = { id: 'role-cashier', name: 'Cashier', isSystem: false, permissions: ['pos:reports'] };
const ACCOUNTANT = {
  id: 'role-accountant',
  name: 'Accountant',
  isSystem: false,
  permissions: ['report:accounting'],
};

describe('ReportAccessService', () => {
  let service: ReportAccessService;
  let stored: unknown;
  let settings: Partial<SettingsService>;
  let roleFindMany: jest.Mock;
  let roleFindFirst: jest.Mock;
  let userFindFirst: jest.Mock;

  beforeEach(async () => {
    stored = null;
    settings = {
      get: jest.fn().mockImplementation(async () => (stored ? { value: stored } : null)) as any,
      set: jest.fn().mockImplementation(async (_key: string, value: unknown) => {
        stored = value;
        return {} as any;
      }) as any,
    };
    roleFindMany = jest.fn().mockResolvedValue([CASHIER, ACCOUNTANT]);
    roleFindFirst = jest.fn().mockImplementation(async ({ where }: any) =>
      [CASHIER, ACCOUNTANT].find((r) => r.id === where.id) ?? null,
    );
    userFindFirst = jest.fn().mockResolvedValue({ id: 'u1', roles: [CASHIER] });

    const prisma = {
      client: {
        role: { findMany: roleFindMany, findFirst: roleFindFirst },
        user: { findFirst: userFindFirst },
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportAccessService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();

    service = module.get(ReportAccessService);
  });

  it('defaults an unconfigured role to every report its permissions allow', async () => {
    const { roles } = await service.listRoleVisibility();
    const cashier = roles.find((r) => r.id === CASHIER.id)!;
    expect(cashier.configured).toBe(false);
    expect(cashier.reports).toContain('pos.sales');
    expect(cashier.reports).toContain('pos.z');
    // Nothing from another permission leaks in.
    expect(cashier.reports).not.toContain('center.sales');
  });

  it('stores an explicit allow-list under the settings key', async () => {
    await service.setRoleVisibility(CASHIER.id, ['pos.sales', 'pos.z']);
    expect(settings.set).toHaveBeenCalledWith(REPORT_VISIBILITY_SETTING_KEY, expect.anything());

    const { roles } = await service.listRoleVisibility();
    const cashier = roles.find((r) => r.id === CASHIER.id)!;
    expect(cashier.configured).toBe(true);
    expect(cashier.reports.sort()).toEqual(['pos.sales', 'pos.z']);
  });

  it('never grants a report the role has no permission for', async () => {
    const saved = await service.setRoleVisibility(CASHIER.id, ['pos.sales', 'center.sales']);
    expect(saved.reports).toEqual(['pos.sales']);
  });

  it('rejects unknown report ids', async () => {
    await expect(service.setRoleVisibility(CASHIER.id, ['nope.report'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unknown role', async () => {
    await expect(service.setRoleVisibility('role-ghost', [])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('clears the override with null', async () => {
    await service.setRoleVisibility(CASHIER.id, ['pos.sales']);
    const cleared = await service.setRoleVisibility(CASHIER.id, null);
    expect(cleared.configured).toBe(false);
    expect(cleared.reports.length).toBeGreaterThan(1);
  });

  it('unions a user’s roles', async () => {
    await service.setRoleVisibility(CASHIER.id, ['pos.sales']);
    userFindFirst.mockResolvedValue({ id: 'u1', roles: [CASHIER, ACCOUNTANT] });
    const reports = await service.reportsForUser('u1');
    expect(reports).toContain('pos.sales');
    expect(reports).toContain('center.sales');
    expect(reports).not.toContain('pos.z');
  });

  it('gives an inactive or unknown user nothing', async () => {
    userFindFirst.mockResolvedValue(null);
    expect(await service.reportsForUser('u1')).toEqual([]);
    expect(await service.reportsForUser(undefined)).toEqual([]);
  });
});
