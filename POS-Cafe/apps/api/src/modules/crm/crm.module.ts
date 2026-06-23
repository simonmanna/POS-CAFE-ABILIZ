import { Module, OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { CoreModule } from '../core/core.module';
import { CrmService } from './crm.service';
import { DealsController, ActivitiesController } from './crm.controller';

/**
 * CRM module (Phase F.7). Sales pipeline + activity timeline.
 * Built on top of Partner (no new partner tables). Reuses existing permissions
 * (partner:read / partner:update) — CRM is an extension of partner management.
 */
@Module({
  imports: [CoreModule],
  controllers: [DealsController, ActivitiesController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'crm',
      version: '1.0.0',
      dependencies: ['core'],
      permissions: [
        // CRM uses partner permissions — no new keys.
        'partner:read',
        'partner:update',
      ],
    });
  }
}
