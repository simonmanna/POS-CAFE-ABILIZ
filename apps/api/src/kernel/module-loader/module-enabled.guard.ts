import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { REQUIRES_MODULE_KEY } from './requires-module.decorator';

/** Modules whose boot-time gate is an env flag rather than the default false. */
const MODULE_ENV_FLAGS: Record<string, string> = {
  task: 'ENABLE_TASKS',
  manufacturing: 'ENABLE_MANUFACTURING',
  rental: 'ENABLE_RENTAL',
  repair: 'ENABLE_REPAIR',
  hr: 'ENABLE_HR',
  beverage: 'ENABLE_BEVERAGE',
  'fixed-asset': 'ENABLE_ASSETS',
  communication: 'ENABLE_COMMUNICATION',
};

/**
 * Enforces `@RequiresModule(...)` (ADR-005): a tenant may only reach an optional
 * vertical's routes when it has an active `OrganizationModule` row.
 *
 * Backwards-compat: an org with zero `OrganizationModule` rows is allowed
 * through (see class docs). Once rows exist, a missing row for a globally-enabled
 * module is treated as enabled, so an env-imported module cannot be blocked by
 * the absence of an explicit row.
 */
@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  private readonly logger = new Logger('ModuleEnabledGuard');
  private readonly warned = new Set<string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly tenant: TenantContextService,
    private readonly flags: FeatureFlagsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(REQUIRES_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const orgId = this.tenant.optionalOrganizationId;
    if (!orgId) return true;

    const hasAnyRow = await this.flags.hasAnyModuleRow();
    if (!hasAnyRow) {
      if (!this.warned.has(orgId)) {
        this.warned.add(orgId);
        this.logger.warn(
          `Organization ${orgId} has no OrganizationModule rows; allowing '${required}' by default. ` +
            'Run prisma/backfill-organization-modules.ts to make module gating explicit for this tenant.',
        );
      }
      return true;
    }

    const explicitlyEnabled = await this.flags.isModuleEnabled(required);
    if (explicitlyEnabled) return true;

    const envFlag = MODULE_ENV_FLAGS[required];
    const globallyEnabled = !!envFlag && process.env[envFlag] === 'true';
    if (globallyEnabled) return true;

    throw new ForbiddenException(`Module '${required}' is not enabled for this organization`);
  }
}
