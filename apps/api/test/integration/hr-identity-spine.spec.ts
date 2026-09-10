import { PrismaClient } from '@prisma/client';
import { describeDb } from './_setup';

/**
 * The Employee <-> User identity spine, asserted at the database.
 *
 * Service-level guards live in hr-access.service.spec.ts. These tests exist to
 * prove the constraints hold even if a future caller bypasses that service —
 * a raw Prisma write, a script, a migration. That matters most for the
 * cross-tenant case: the whole point of making the FK composite
 * (organizationId, userId) -> User(organizationId, id) is that tenancy stops
 * depending on anyone remembering to check it.
 */
describeDb('integration: HR identity spine', () => {
  const prisma = new PrismaClient();

  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let employeeA: string;

  beforeAll(async () => {
    await prisma.$connect();
    const stamp = Date.now();

    const a = await prisma.organization.create({
      data: { code: `HR-SPINE-A-${stamp}`, name: 'Spine Org A', currencyCode: 'UGX' },
    });
    const b = await prisma.organization.create({
      data: { code: `HR-SPINE-B-${stamp}`, name: 'Spine Org B', currencyCode: 'UGX' },
    });
    orgA = a.id;
    orgB = b.id;

    const ua = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `spine-a-${stamp}@test.local`,
        firstName: 'Ada',
        passwordHash: 'x',
      },
    });
    const ub = await prisma.user.create({
      data: {
        organizationId: orgB,
        email: `spine-b-${stamp}@test.local`,
        firstName: 'Grace',
        passwordHash: 'x',
      },
    });
    userA = ua.id;
    userB = ub.id;

    const emp = await prisma.hrEmployee.create({
      data: { organizationId: orgA, employeeCode: `EMP-A-${stamp}`, firstName: 'Ada' },
    });
    employeeA = emp.id;
  });

  afterAll(async () => {
    // Employees hold a RESTRICT FK to User, so they must go first.
    if (orgA || orgB) {
      await prisma.hrEmployee.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await prisma.auditLog.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    }
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Reset the link between cases.
    await prisma.hrEmployee.updateMany({ where: { id: employeeA }, data: { userId: null } });
    await prisma.hrEmployee.deleteMany({
      where: { organizationId: orgA, id: { not: employeeA } },
    });
  });

  it('allows an employee with no user account (the unlinked default)', async () => {
    const row = await prisma.hrEmployee.findUnique({ where: { id: employeeA } });
    expect(row?.userId).toBeNull();
  });

  it('links an employee to a user in the same organization', async () => {
    const updated = await prisma.hrEmployee.update({
      where: { id: employeeA },
      data: { userId: userA },
    });
    expect(updated.userId).toBe(userA);
  });

  it('REFUSES a cross-tenant link at the database', async () => {
    // orgA's employee pointing at orgB's user. Postgres rejects it because no
    // row satisfies (organizationId = orgA, id = userB) in User. Without the
    // composite FK this write would have succeeded silently.
    await expect(
      prisma.hrEmployee.update({ where: { id: employeeA }, data: { userId: userB } }),
    ).rejects.toThrow();

    const row = await prisma.hrEmployee.findUnique({ where: { id: employeeA } });
    expect(row?.userId).toBeNull();
  });

  it('refuses a userId that does not exist at all', async () => {
    await expect(
      prisma.hrEmployee.update({
        where: { id: employeeA },
        data: { userId: '00000000-0000-4000-8000-000000000000' },
      }),
    ).rejects.toThrow();
  });

  it('refuses to link one account to two employees', async () => {
    await prisma.hrEmployee.update({ where: { id: employeeA }, data: { userId: userA } });

    const second = await prisma.hrEmployee.create({
      data: { organizationId: orgA, employeeCode: `EMP-A2-${Date.now()}`, firstName: 'Second' },
    });

    await expect(
      prisma.hrEmployee.update({ where: { id: second.id }, data: { userId: userA } }),
    ).rejects.toThrow();
  });

  it('lets many employees stay unlinked at once (NULL is not subject to the unique)', async () => {
    const extra = await prisma.hrEmployee.create({
      data: { organizationId: orgA, employeeCode: `EMP-A3-${Date.now()}`, firstName: 'Third' },
    });
    expect(extra.userId).toBeNull();

    const unlinked = await prisma.hrEmployee.count({
      where: { organizationId: orgA, userId: null },
    });
    expect(unlinked).toBeGreaterThanOrEqual(2);
  });

  it('RESTRICTs a hard delete of a linked account rather than orphaning the employee', async () => {
    const stamp = Date.now();
    const doomed = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `doomed-${stamp}@test.local`,
        firstName: 'Doomed',
        passwordHash: 'x',
      },
    });
    const emp = await prisma.hrEmployee.create({
      data: {
        organizationId: orgA,
        employeeCode: `EMP-DOOM-${stamp}`,
        firstName: 'Doomed',
        userId: doomed.id,
      },
    });

    // Users are only ever soft-deleted in this system. A hard delete of a
    // linked account must fail loudly rather than silently detach a workforce
    // identity or orphan the employee record.
    await expect(prisma.user.delete({ where: { id: doomed.id } })).rejects.toThrow();

    await prisma.hrEmployee.delete({ where: { id: emp.id } });
    await prisma.user.delete({ where: { id: doomed.id } });
  });

  it('resolves the relation in both directions once linked', async () => {
    await prisma.hrEmployee.update({ where: { id: employeeA }, data: { userId: userA } });

    const fromEmployee = await prisma.hrEmployee.findUnique({
      where: { id: employeeA },
      include: { user: { select: { id: true, email: true } } },
    });
    expect(fromEmployee?.user?.id).toBe(userA);

    const fromUser = await prisma.user.findUnique({
      where: { id: userA },
      include: { employee: { select: { id: true, employeeCode: true } } },
    });
    expect(fromUser?.employee?.id).toBe(employeeA);
  });

  it('finds accounts with no employee — the "link employee" picker query', async () => {
    await prisma.hrEmployee.update({ where: { id: employeeA }, data: { userId: userA } });

    const stamp = Date.now();
    const spare = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `spare-${stamp}@test.local`,
        firstName: 'Spare',
        passwordHash: 'x',
      },
    });

    const linkable = await prisma.user.findMany({
      where: { organizationId: orgA, employee: null, isActive: true },
      select: { id: true },
    });
    const ids = linkable.map((u) => u.id);

    expect(ids).toContain(spare.id);
    expect(ids).not.toContain(userA);

    await prisma.user.delete({ where: { id: spare.id } });
  });
});
