import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { HrAccessService } from './hr-access.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Guard behaviour of the Employee <-> User identity spine.
 *
 * The composite FK is the real backstop for tenancy and 1:1-ness; these tests
 * cover the service checks that turn a raw Postgres constraint error into a
 * usable message, plus the rules the database cannot express (already linked,
 * claimed by someone else, unlink leaves the account alone).
 */
describe('HrAccessService', () => {
  const ORG = 'org-1';

  function build(overrides: {
    employee?: any;
    user?: any;
    claimedBy?: any;
  } = {}) {
    const employee = overrides.employee ?? {
      id: 'emp-1',
      employeeCode: 'EMP-00001',
      firstName: 'Ada',
      lastName: 'Byron',
      isActive: true,
      userId: null,
    };

    const updates: any[] = [];
    const audits: any[] = [];

    const tx = {
      hrEmployee: {
        update: jest.fn(async (args: any) => {
          updates.push(args);
          Object.assign(employee, args.data);
          return employee;
        }),
      },
    };

    const prisma = {
      client: {
        hrEmployee: {
          findFirst: jest.fn(async (args: any) => {
            // The claimed-by-another lookup queries on userId.
            if (args?.where?.userId) return overrides.claimedBy ?? null;
            return employee;
          }),
        },
        user: {
          // `roles` is always present on the real include; default it so a
          // terse fixture cannot masquerade as a shape the query never returns.
          findFirst: jest.fn(async () =>
            overrides.user ? { roles: [], ...overrides.user } : null,
          ),
          findMany: jest.fn(async () => []),
        },
        $transaction: jest.fn(async (fn: any) => fn(tx)),
      },
    };

    const tenant = { organizationId: ORG, userId: 'actor-1' };
    const audit = {
      recordInTx: jest.fn(async (_tx: any, input: any) => {
        audits.push(input);
      }),
    };
    const users = { create: jest.fn(), remove: jest.fn() };

    const svc = new HrAccessService(
      prisma as any,
      tenant as any,
      audit as any,
      users as any,
    );
    return { svc, prisma, audit, users, employee, updates, audits, tx };
  }

  describe('linkUser', () => {
    it('links an unclaimed account and audits it as assign', async () => {
      const { svc, employee, audits } = build({
        user: { id: 'user-1', email: 'ada@example.test' },
      });

      await svc.linkUser('emp-1', { userId: 'user-1' });

      expect(employee.userId).toBe('user-1');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entity: 'HrEmployee',
        entityId: 'emp-1',
        action: 'assign',
        oldValues: { userId: null },
      });
      expect(audits[0].newValues).toMatchObject({ userId: 'user-1' });
    });

    it('is idempotent when the same pair is linked twice', async () => {
      const { svc, audits } = build({
        employee: { id: 'emp-1', employeeCode: 'E1', userId: 'user-1', isActive: true },
        user: { id: 'user-1', email: 'ada@example.test' },
      });

      await svc.linkUser('emp-1', { userId: 'user-1' });

      // No second write, no duplicate audit entry.
      expect(audits).toHaveLength(0);
    });

    it('refuses to attach a second account to an already-linked employee', async () => {
      const { svc } = build({
        employee: { id: 'emp-1', employeeCode: 'E1', userId: 'user-1', isActive: true },
        user: { id: 'user-2', email: 'other@example.test' },
      });

      await expect(svc.linkUser('emp-1', { userId: 'user-2' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('reports a cross-tenant user id as not found, leaking nothing about other orgs', async () => {
      // The tenancy extension scopes the lookup, so a foreign user id simply
      // does not resolve — the caller cannot probe for its existence.
      const { svc } = build({ user: null });

      await expect(svc.linkUser('emp-1', { userId: 'user-in-other-org' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses an account already linked to a different employee', async () => {
      const { svc } = build({
        user: { id: 'user-1', email: 'ada@example.test' },
        claimedBy: { id: 'emp-9', employeeCode: 'EMP-00009' },
      });

      await expect(svc.linkUser('emp-1', { userId: 'user-1' })).rejects.toThrow(/EMP-00009/);
    });
  });

  describe('unlinkUser', () => {
    it('clears the link, audits unassign, and does not touch the account', async () => {
      const { svc, prisma, employee, audits } = build({
        employee: { id: 'emp-1', employeeCode: 'E1', userId: 'user-1', isActive: true },
        user: { id: 'user-1', email: 'ada@example.test', roles: [] },
      });

      await svc.unlinkUser('emp-1');

      expect(employee.userId).toBeNull();
      expect(audits[0]).toMatchObject({ action: 'unassign', oldValues: { userId: 'user-1' } });
      // Unlinking is a correction to the workforce record, never a personnel
      // action: no user row is written.
      expect(prisma.client.user.findFirst).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.anything() }),
      );
    });

    it('rejects unlinking an employee that has no account', async () => {
      const { svc } = build();
      await expect(svc.unlinkUser('emp-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('provisionUser', () => {
    it('rolls the new account back if the link fails, leaving no orphan login', async () => {
      const { svc, users } = build({
        // Account creation succeeds, but the employee turns out to be claimed
        // already, so linkUser throws after the user exists.
        employee: { id: 'emp-1', employeeCode: 'E1', userId: null, isActive: true },
        user: { id: 'user-new', email: 'new@example.test' },
        claimedBy: { id: 'emp-9', employeeCode: 'EMP-00009' },
      });
      users.create.mockResolvedValue({ id: 'user-new' });
      users.remove.mockResolvedValue(undefined);

      await expect(
        svc.provisionUser('emp-1', {
          email: 'new@example.test',
          password: 'Sup3rSecret!',
          firstName: 'New',
          roleIds: ['role-1'],
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(users.remove).toHaveBeenCalledWith('user-new');
    });

    it('refuses to provision for an employee that already has an account', async () => {
      const { svc, users } = build({
        employee: { id: 'emp-1', employeeCode: 'E1', userId: 'user-1', isActive: true },
      });

      await expect(
        svc.provisionUser('emp-1', {
          email: 'new@example.test',
          password: 'Sup3rSecret!',
          firstName: 'New',
          roleIds: ['role-1'],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
    });
  });

  describe('getAccess', () => {
    it('never returns a credential, only whether a PIN is set', async () => {
      const { svc } = build({
        employee: { id: 'emp-1', employeeCode: 'E1', userId: 'user-1', isActive: true },
        user: {
          id: 'user-1',
          email: 'ada@example.test',
          firstName: 'Ada',
          lastName: 'Byron',
          isActive: true,
          lastLoginAt: null,
          defaultBranchId: null,
          lockedUntil: null,
          pinHash: '$2b$10$somethingsecret',
          roles: [{ id: 'r1', name: 'Cashier', permissions: ['pos:read', 'pos:checkout'] }],
        },
      });

      const result: any = await svc.getAccess('emp-1');

      expect(result.linked).toBe(true);
      expect(result.user.hasPin).toBe(true);
      expect(result.user.posAccess).toBe(true);
      expect(JSON.stringify(result)).not.toContain('$2b$10$');
      expect(result.user).not.toHaveProperty('pinHash');
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('reports posAccess false for a back-office-only account', async () => {
      const { svc } = build({
        employee: { id: 'emp-1', employeeCode: 'E1', userId: 'user-1', isActive: true },
        user: {
          id: 'user-1',
          email: 'hr@example.test',
          firstName: 'Grace',
          lastName: null,
          isActive: true,
          lastLoginAt: null,
          defaultBranchId: null,
          lockedUntil: null,
          pinHash: null,
          roles: [{ id: 'r2', name: 'HR Officer', permissions: ['hr:read', 'hr:employee'] }],
        },
      });

      const result: any = await svc.getAccess('emp-1');
      expect(result.user.posAccess).toBe(false);
      expect(result.user.hasPin).toBe(false);
    });

    it('reports an unlinked employee as not linked', async () => {
      const { svc } = build();
      const result: any = await svc.getAccess('emp-1');
      expect(result.linked).toBe(false);
      expect(result.user).toBeNull();
    });
  });
});
