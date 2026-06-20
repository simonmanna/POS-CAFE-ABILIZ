import { Global, Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { TenantContextService } from './tenancy/tenant-context.service';
import { PrismaService } from './prisma/prisma.service';
import { EventBus } from './events/event-bus';
import { AuditService } from './audit/audit.service';
import { SettingsService } from './settings/settings.service';
import { SettingsController } from './settings/settings.controller';
import { ModuleRegistry } from './module-loader/module-registry.service';
import { SequenceService } from './sequence/sequence.service';
import { JwtTokenService } from './auth/jwt-token.service';
import { PasswordService } from './auth/password.service';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';

/**
 * The platform runtime (Phase 0). Global so every feature module can inject
 * these services. Registers the two global guards (auth then permissions).
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [
    TenantContextService,
    PrismaService,
    EventBus,
    AuditService,
    SettingsService,
    ModuleRegistry,
    SequenceService,
    JwtTokenService,
    PasswordService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [
    TenantContextService,
    PrismaService,
    EventBus,
    AuditService,
    SettingsService,
    ModuleRegistry,
    SequenceService,
    JwtTokenService,
    PasswordService,
  ],
})
export class KernelModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({ name: 'kernel', version: '1.0.0', dependencies: [] });
  }
}
