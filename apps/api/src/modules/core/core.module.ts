import { Module, OnModuleInit } from '@nestjs/common';
import { ALL_PERMISSIONS } from '@erp/shared';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { PartnerModule } from './partner/partner.module';
import { ProductModule } from './product/product.module';

/**
 * Core master-data module (Phase 1). Owns the universal entities every future
 * vertical builds on. Registers its manifest so the kernel can validate the
 * dependency graph at boot.
 */
@Module({
  imports: [PartnerModule, ProductModule],
})
export class CoreModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'core',
      version: '1.0.0',
      dependencies: ['kernel'],
      permissions: ALL_PERMISSIONS,
    });
  }
}
