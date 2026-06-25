/**
 * POS PIN authentication service.
 *
 * Verifies a cashier's POS PIN (stored in User.pinHash, bcrypt).
 * Returns user info + aggregated permissions for the frontend store.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { PasswordService } from '../../kernel/auth/password.service';
import { AuditService } from '../../kernel/audit/audit.service';

@Injectable()
export class PosAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /** Verify POS PIN and return user info + permissions. */
  async pinLogin(userId: string, pin: string) {
    const organizationId = this.tenant.organizationId;

    const user = await this.prisma.raw.user.findFirst({
      where: { id: userId, organizationId, isActive: true, deletedAt: null },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException('Staff not found');

    // Verify PIN
    if (!user.pinHash) {
      throw new UnauthorizedException('No POS PIN set. Ask a manager to set one.');
    }
    const ok = await this.password.compare(pin, user.pinHash);
    if (!ok) throw new UnauthorizedException('Invalid PIN');

    // Aggregate permissions from all roles
    const permissions = [...new Set<string>(user.roles.flatMap((r: any) => r.permissions ?? []))];

    // Audit login
    await this.audit.record({
      entity: 'User',
      entityId: user.id,
      action: 'login' as any,
      newValues: { posLogin: true },
    });

    // Update last POS login
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      userId: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      permissions,
    };
  }
}
