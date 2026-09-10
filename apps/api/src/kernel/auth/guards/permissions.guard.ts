import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import type { AuthUser } from '../jwt-token.service';

/**
 * D4-2: Permissions guard with two modes:
 *
 *   - JWT mode (default): trusts the permissions baked into the access token.
 *     Fast (no DB hit per request) but allows up to JWT_TTL minutes of staleness
 *     when a role is updated.
 *
 *   - DB mode (PERMISSIONS_DB_LOOKUP=true): re-reads the user's role permissions
 *     from Postgres on every authenticated request. ~3–15 ms overhead, but
 *     revocation is immediate. This is the recommended mode for the beta —
 *     JWT stays the cache, the DB is the source of truth.
 *
 * Wire via env flag `PERMISSIONS_DB_LOOKUP`. Default is DB mode for the beta.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger('PermissionsGuard');
  private readonly dbMode = process.env.PERMISSIONS_DB_LOOKUP !== 'false';

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ auth?: AuthUser }>();
    if (!request.auth) {
      throw new ForbiddenException('Authentication required');
    }

    let granted: string[];
    if (this.dbMode) {
      granted = await this.lookupPermissions(request.auth.sub);
      // The JWT's copy can be stale by up to JWT_ACCESS_TTL, and a POS token
      // lives 12h. Publish the authoritative set so field-level checks
      // (TenantContextService.has) cannot be answered from a stale token.
      this.tenant.setPermissions(granted);
    } else {
      granted = request.auth.permissions ?? [];
    }

    const ok = required.every((perm) => granted.includes(perm));
    if (!ok) {
      throw new ForbiddenException(`Missing required permission(s): ${required.join(', ')}`);
    }
    return true;
  }

  /**
   * Re-read the user's role permissions from Postgres.
   *
   * Filters on `isActive` so deactivation revokes immediately, which is what
   * this guard's DB mode exists to promise. Without it a suspended or
   * terminated employee kept full authority until their token expired — up to
   * 12h for a POS token. A soft-deleted user is already excluded by the
   * tenancy extension, which injects `deletedAt: null`.
   */
  private async lookupPermissions(userId: string): Promise<string[]> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, isActive: true },
      include: { roles: true },
    });
    if (!user) return [];
    const all = new Set<string>();
    for (const role of user.roles as any[]) {
      for (const p of role.permissions ?? []) all.add(p);
    }
    return [...all];
  }
}