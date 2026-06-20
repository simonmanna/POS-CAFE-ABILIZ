import { Module, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { LocationService } from './location.service';
import { StockService } from './stock.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryController } from './inventory.controller';

@Module({
  controllers: [InventoryController],
  providers: [LocationService, StockService, InventoryQueryService],
  exports: [LocationService, StockService, InventoryQueryService],
})
export class InventoryModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'inventory',
      version: '1.0.0',
      dependencies: ['core'],
      permissions: [
        ...Object.values(PERMISSIONS.inventoryLocation),
        ...Object.values(PERMISSIONS.inventory),
      ],
    });
  }
}
