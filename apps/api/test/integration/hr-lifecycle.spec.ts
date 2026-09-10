import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from './_setup';
import { ensureAccountCategories, makeAccountFactory } from './_accounts';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { HrLifecycleService } from '../../src/modules/hr/hr-lifecycle.service';
import { HrAccessService } from '../../src/modules/hr/hr-access.service';
import { StaffModule } from '../../src/kernel/auth/staff/staff.module';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Employment lifecycle against a live database.
 *
 * The invariant these tests exist to defend is the one the brief is most
 * emphatic about (§24): ending someone's employment must never rewrite history.
 * A terminated cashier's invoices, cash sessions and audit rows have to keep
 * resolving to them, or last year's books quietly change identity.
 */
describeDb('integration: HR employment lifecycle', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let lifecycle: HrLifecycleService;
  let access: HrAccessService;
  let tenant: TenantContextService;

  let organizationId: string;
  let userId: string;
  let employeeId: string;
  let cashRegisterId: string;
  let cashSessionId: string;

  const TIMEOUT = 120_000;
  jest.setTimeout(TIMEOUT);

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run({ organizationId, userId: 'admin-actor' }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    moduleRef = await Test.createTestingModule({
      // Kernel + Staff only. Importing AccountingModule pulls in its workers and
      // the test never finishes booting; neither service under test needs it.
      imports: [KernelModule, DocumentsModule, StaffModule],
      providers: [HrLifecycleService, HrAccessService],
    }).compile();
    await moduleRef.init();
    lifecycle = moduleRef.get(HrLifecycleService);
    access = moduleRef.get(HrAccessService);
    tenant = moduleRef.get(TenantContextService);

    const stamp = Date.now();
    const org = await prisma.organization.create({
      data: { code: `HR-LIFE-${stamp}`, name: 'Lifecycle Org', currencyCode: 'UGX' },
    });
    organizationId = org.id;

    const user = await prisma.user.create({
      data: {
        organizationId,
        email: `life-${stamp}@test.local`,
        firstName: 'Cashier',
        lastName: 'One',
        passwordHash: 'x',
        pinHash: '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
        isActive: true,
      },
    });
    userId = user.id;

    await prisma.refreshToken.create({
      data: {
        organizationId,
        userId,
        tokenHash: `hash-${stamp}`,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const employee = await prisma.hrEmployee.create({
      data: {
        organizationId,
        employeeCode: `EMP-LIFE-${stamp}`,
        firstName: 'Cashier',
        lastName: 'One',
        userId,
        employmentStatus: 'ACTIVE',
        isActive: true,
      },
    });
    employeeId = employee.id;

    // A real piece of history owned by this person. A cash register needs a
    // drawer account, so build the minimum chart of accounts for one.
    const categories = await ensureAccountCategories(prisma);
    const account = makeAccountFactory(prisma, categories);
    const drawer = await account(organizationId, `1000-${stamp}`, 'Cash drawer', 'cash');
    const register = await prisma.cashRegister.create({
      data: {
        organizationId,
        code: `REG-${stamp}`,
        name: 'Till 1',
        defaultAccountId: drawer.id,
      },
    });
    cashRegisterId = register.id;
    const session = await prisma.cashSession.create({
      data: { organizationId, cashRegisterId, userId, status: 'closed', openingFloat: 0 },
    });
    cashSessionId = session.id;
  }, TIMEOUT);

  afterAll(async () => {
    if (organizationId) {
      await prisma.hrEmployeeStatusHistory.deleteMany({ where: { organizationId } });
      await prisma.hrEmployeeTransfer.deleteMany({ where: { organizationId } });
      await prisma.hrEmployee.deleteMany({ where: { organizationId } });
      await prisma.cashSession.deleteMany({ where: { organizationId } });
      await prisma.cashRegister.deleteMany({ where: { organizationId } });
      await prisma.account.deleteMany({ where: { organizationId } });
      await prisma.refreshToken.deleteMany({ where: { organizationId } });
      await prisma.auditLog.deleteMany({ where: { organizationId } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await moduleRef?.close();
    await prisma.$disconnect();
  }, TIMEOUT);

  it('suspends without ending employment, and can lift the suspension', async () => {
    await asOrg(() =>
      lifecycle.suspend(employeeId, { reason: 'Under investigation', disableAccount: true }),
    );

    let employee = await prisma.hrEmployee.findUnique({ where: { id: employeeId } });
    expect(employee?.employmentStatus).toBe('SUSPENDED');
    // Suspension is not termination: employment continues.
    expect(employee?.terminationDate).toBeNull();
    // …but access is gone.
    let user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.isActive).toBe(false);

    await asOrg(() => lifecycle.reactivate(employeeId, { enableAccount: true }));
    employee = await prisma.hrEmployee.findUnique({ where: { id: employeeId } });
    user = await prisma.user.findUnique({ where: { id: userId } });
    expect(employee?.employmentStatus).toBe('ACTIVE');
    expect(employee?.isActive).toBe(true);
    expect(user?.isActive).toBe(true);
  });

  it('records a transfer and leaves historical records where they happened', async () => {
    const dept = await prisma.hrDepartment.create({
      data: { organizationId, code: `D-${Date.now()}`, name: 'Kitchen' },
    });

    await asOrg(() =>
      lifecycle.transfer(employeeId, { toDepartmentId: dept.id, reason: 'Moved to kitchen' }),
    );

    const employee = await prisma.hrEmployee.findUnique({ where: { id: employeeId } });
    expect(employee?.departmentId).toBe(dept.id);

    const transfers = await prisma.hrEmployeeTransfer.findMany({ where: { employeeId } });
    expect(transfers).toHaveLength(1);
    expect(transfers[0].toDepartmentId).toBe(dept.id);
    expect(transfers[0].fromDepartmentId).toBeNull();

    // The cash session predates the transfer and must be untouched.
    const session = await prisma.cashSession.findUnique({ where: { id: cashSessionId } });
    expect(session?.userId).toBe(userId);
  });

  it('refuses a transfer that would change nothing', async () => {
    await expect(
      asOrg(() => lifecycle.transfer(employeeId, { reason: 'No-op' })),
    ).rejects.toThrow(/would not change/i);
  });

  it('TERMINATES: disables the login, revokes sessions, and preserves every historical actor', async () => {
    const before = await prisma.cashSession.findUnique({ where: { id: cashSessionId } });

    await asOrg(() =>
      lifecycle.terminate(employeeId, {
        reason: 'End of contract',
        disableAccount: true,
      }),
    );

    const employee = await prisma.hrEmployee.findUnique({ where: { id: employeeId } });
    expect(employee?.employmentStatus).toBe('TERMINATED');
    // `isActive` is derived, so every legacy query that filters on it agrees.
    expect(employee?.isActive).toBe(false);
    expect(employee?.terminationReason).toBe('End of contract');
    expect(employee?.terminationDate).not.toBeNull();

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.isActive).toBe(false);

    // Live sessions are killed, not left to expire.
    const liveTokens = await prisma.refreshToken.count({
      where: { userId, revokedAt: null },
    });
    expect(liveTokens).toBe(0);

    // THE INVARIANT: history is untouched.
    const after = await prisma.cashSession.findUnique({ where: { id: cashSessionId } });
    expect(after?.userId).toBe(userId);
    expect(after?.userId).toBe(before?.userId);

    // The person is still resolvable — a former employee, not a deleted one.
    const stillThere = await prisma.user.findUnique({ where: { id: userId } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('writes an append-only status ledger of every transition', async () => {
    const history = await prisma.hrEmployeeStatusHistory.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'asc' },
    });

    const transitions = history.map((h) => h.toStatus);
    expect(transitions).toEqual(
      expect.arrayContaining(['SUSPENDED', 'ACTIVE', 'TERMINATED']),
    );

    const termination = history.find((h) => h.toStatus === 'TERMINATED');
    expect(termination?.reason).toBe('End of contract');
    expect(termination?.accountDisabled).toBe(true);
  });

  it('refuses to terminate someone who has already left', async () => {
    await expect(
      asOrg(() =>
        lifecycle.terminate(employeeId, { reason: 'Again', disableAccount: false }),
      ),
    ).rejects.toThrow(/already terminated/i);
  });

  it('rehires onto the same record, keeping the earlier service history', async () => {
    await asOrg(() =>
      lifecycle.reactivate(employeeId, { reason: 'Rehired', enableAccount: true, toProbation: true }),
    );

    const employee = await prisma.hrEmployee.findUnique({ where: { id: employeeId } });
    expect(employee?.employmentStatus).toBe('PROBATION');
    expect(employee?.isActive).toBe(true);
    expect(employee?.terminationDate).toBeNull();

    // Same employee row, so the earlier transitions are still theirs.
    const history = await prisma.hrEmployeeStatusHistory.count({ where: { employeeId } });
    expect(history).toBeGreaterThanOrEqual(4);

    const confirmed = await asOrg(() => lifecycle.confirm(employeeId, {}));
    expect((confirmed as any).employmentStatus).toBe('ACTIVE');
    expect((confirmed as any).confirmedAt).not.toBeNull();
  });

  it('keeps the employee reachable through the spine after everything', async () => {
    const result: any = await asOrg(() => access.getAccess(employeeId));
    expect(result.linked).toBe(true);
    expect(result.user.id).toBe(userId);
    // Credentials never leak, even for a rehired account with a PIN set.
    expect(JSON.stringify(result)).not.toContain('$2b$10$');
  });
});
