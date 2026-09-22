import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { UsersService } from '../../kernel/auth/staff/users/users.service';
import type { LinkUserDto, ProvisionUserDto } from './dto/hr-access.dto';
import type { UpdateAccessDto } from './dto/hr-lifecycle.dto';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * HrAccessService — the Employee <-> User identity spine.
 *
 * `HrEmployee.userId` has existed since the HR module shipped but was never
 * written or read by anything, so HR and POS were two parallel person
 * registries. This service is the only sanctioned writer of that column.
 *
 * Three rules it exists to enforce:
 *
 *   1. **Authentication is not employment.** Linking never changes what a user
 *      can do — roles decide that, and an employee record cannot grant a
 *      permission. The one thing employment does take away is the till: a
 *      suspended or departed employee cannot sign in at a POS (see
 *      kernel/auth/pos-eligibility.ts).
 *   2. **Both sides stay optional.** A POS user with no employee keeps working
 *      exactly as before; an employee with no user simply cannot log in.
 *   3. **Every link change is audited.** `assign` / `unassign` on the employee,
 *      recorded inside the same transaction as the write.
 *
 * Tenancy is belt-and-braces: the tenancy extension scopes every query to the
 * caller's org, AND the composite FK (organizationId, userId) -> User makes a
 * cross-tenant link impossible at the database. The checks here exist to turn
 * what would be a raw Postgres constraint error into a usable message.
 */
@Injectable()
export class HrAccessService {
  private readonly logger = new Logger('HrAccessService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * The "System Access" panel of the Employee 360 view.
   *
   * Never returns credentials — no password hash, no PIN hash, no MFA secret.
   * `hasPin` is a boolean so the UI can show "PIN set" without the hash ever
   * leaving the server.
   */
  async getAccess(employeeId: string) {
    const employee = await this.findEmployee(employeeId);

    if (!employee.userId) {
      return { employee: this.employeeSummary(employee), linked: false, user: null };
    }

    const user = await this.prisma.client.user.findFirst({
      where: { id: employee.userId },
      include: { roles: { select: { id: true, name: true, permissions: true } } },
    });

    // Defensive: the FK makes this unreachable, but a link that cannot be
    // resolved should read as "not linked" rather than throw and break the page.
    if (!user) {
      return { employee: this.employeeSummary(employee), linked: false, user: null };
    }

    const permissions = [
      ...new Set(((user.roles ?? []) as any[]).flatMap((r) => (r.permissions ?? []) as string[])),
    ];

    return {
      employee: this.employeeSummary(employee),
      linked: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        defaultBranchId: user.defaultBranchId,
        lockedUntil: user.lockedUntil,
        roles: ((user.roles ?? []) as any[]).map((r) => ({ id: r.id, name: r.name })),
        /** Whether this account can operate the POS at all. */
        posAccess: permissions.some((p) => p.startsWith('pos:')),
        /** Boolean only — the bcrypt hash is never exposed. */
        hasPin: !!(user as any).pinHash,
      },
    };
  }

  /**
   * Accounts in this organization that are not yet attached to an employee —
   * the candidate list for the "Link employee" picker.
   *
   * Reads through the new relation, so an account already claimed by another
   * employee can never be offered twice.
   */
  async listLinkableUsers(query: any = {}) {
    const where: any = { employee: null, isActive: true };
    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.client.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        lastLoginAt: true,
        roles: { select: { id: true, name: true } },
      },
      orderBy: [{ firstName: 'asc' }],
      take: Math.min(Number(query.take ?? 50), 200),
    });
    return { rows, total: rows.length };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /** Attach an existing account to an employee. Idempotent for the same pair. */
  async linkUser(employeeId: string, dto: LinkUserDto) {
    const orgId = this.tenant.organizationId;
    const actor = this.tenant.userId;
    const employee = await this.findEmployee(employeeId);

    if (employee.userId === dto.userId) return this.getAccess(employeeId);
    if (employee.userId) {
      throw new ConflictException(
        'This employee is already linked to a user account. Unlink it first.',
      );
    }

    // Scoped by the tenancy extension, so a user id from another organization
    // simply is not found — the caller learns nothing about other tenants.
    const user = await this.prisma.client.user.findFirst({
      where: { id: dto.userId },
      select: { id: true, email: true, defaultBranchId: true },
    });
    if (!user) throw new NotFoundException('User account not found in this organization');

    const claimed = await this.prisma.client.hrEmployee.findFirst({
      where: { userId: dto.userId },
      select: { id: true, employeeCode: true },
    });
    if (claimed) {
      throw new ConflictException(
        `That account is already linked to employee ${claimed.employeeCode}.`,
      );
    }

    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.hrEmployee.update({
        where: { id: employeeId },
        data: { userId: dto.userId, updatedBy: actor },
      });
      // A login with no home branch picks up the one HR has on file, so the
      // POS scopes this person to where they actually work. An existing
      // default is someone's deliberate choice and is left alone.
      if (!user.defaultBranchId && employee.branchId) {
        await tx.user.updateMany({
          where: { id: dto.userId },
          data: { defaultBranchId: employee.branchId, updatedBy: actor },
        });
      }
      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: employeeId,
        action: 'assign',
        oldValues: { userId: null },
        newValues: { userId: dto.userId, email: user.email, organizationId: orgId },
      });
    });

    return this.getAccess(employeeId);
  }

  /**
   * Detach the account from the employee.
   *
   * Deliberately does NOT deactivate, delete or otherwise touch the user, and
   * never rewrites the historical actor ids on that account's past orders,
   * invoices, payments or cash sessions. Unlinking corrects the workforce
   * record; it is not a personnel action.
   */
  async unlinkUser(employeeId: string) {
    const actor = this.tenant.userId;
    const employee = await this.findEmployee(employeeId);
    if (!employee.userId) throw new BadRequestException('This employee has no linked user account');
    // Read before the write. Keeping the reference and dereferencing it after
    // the update would make the audit's "before" value depend on whether the
    // ORM hands back a fresh object or the same one.
    const previousUserId: string = employee.userId;

    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.hrEmployee.update({
        where: { id: employeeId },
        data: { userId: null, updatedBy: actor },
      });
      await this.audit.recordInTx(tx, {
        entity: 'HrEmployee',
        entityId: employeeId,
        action: 'unassign',
        oldValues: { userId: previousUserId },
        newValues: { userId: null },
      });
    });

    return this.getAccess(employeeId);
  }

  /**
   * Create a login for an employee who has none, and link it.
   *
   * Delegates account creation to the existing UsersService so there is exactly
   * one user-creation path in the system — same password hashing, same role
   * resolution, same last-admin guard, same event, same audit entry. This
   * service adds only the link.
   */
  async provisionUser(employeeId: string, dto: ProvisionUserDto) {
    const employee = await this.findEmployee(employeeId);
    if (employee.userId) {
      throw new ConflictException(
        'This employee already has a user account. Unlink it before provisioning another.',
      );
    }

    const created = await this.users.create({
      email: dto.email,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
      roleIds: dto.roleIds,
      isActive: dto.isActive ?? true,
    } as any);

    try {
      return await this.linkUser(employeeId, { userId: created.id });
    } catch (err) {
      // The account was created but could not be attached. Leaving an orphan
      // login behind would be a silent security hole, so undo it and surface
      // the real reason instead of reporting a half-finished provision.
      this.logger.error(
        `Provision for employee ${employeeId} failed after creating user ${created.id}; rolling the account back.`,
      );
      await this.users.remove(created.id).catch((cleanupErr) => {
        this.logger.error(
          `Rollback of user ${created.id} failed — remove it by hand: ${String(cleanupErr)}`,
        );
      });
      throw err;
    }
  }

  /**
   * Change what the linked account can do — roles and/or enabled state.
   *
   * Delegates to UsersService so the last-admin guard, role resolution and
   * audit entry are the same ones the Staff screen goes through. HR does not
   * get a private back door into authorization.
   */
  async updateAccess(employeeId: string, dto: UpdateAccessDto) {
    const employee = await this.findEmployee(employeeId);
    if (!employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account. Link or provision one first.',
      );
    }
    if (dto.roleIds === undefined && dto.isActive === undefined) {
      throw new BadRequestException('Provide roleIds and/or isActive');
    }

    await this.users.update(employee.userId, {
      ...(dto.roleIds !== undefined ? { roleIds: dto.roleIds } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    } as any);

    return this.getAccess(employeeId);
  }

  /**
   * Give the linked account a POS PIN, or reset a forgotten one.
   *
   * Delegates to UsersService.setPin, the same path the Staff screen uses, so
   * hashing, lockout reset and audit are identical. The PIN is never returned.
   */
  async setPin(employeeId: string, pin: string) {
    const userId = await this.linkedUserId(employeeId);
    await this.users.setPin(userId, pin);
    return this.getAccess(employeeId);
  }

  /** Take the linked account's PIN away. It can no longer sign in at a till. */
  async clearPin(employeeId: string) {
    const userId = await this.linkedUserId(employeeId);
    await this.users.clearPin(userId);
    return this.getAccess(employeeId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async linkedUserId(employeeId: string): Promise<string> {
    const employee = await this.findEmployee(employeeId);
    if (!employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account. Link or provision one first.',
      );
    }
    return employee.userId;
  }

  private async findEmployee(employeeId: string) {
    const employee = await this.prisma.client.hrEmployee.findFirst({
      where: { id: employeeId },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee as any;
  }

  private employeeSummary(employee: any) {
    return {
      id: employee.id,
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
      isActive: employee.isActive,
    };
  }
}
