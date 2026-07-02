import { Module, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { AccountingModule } from '../accounting/accounting.module';
import { LocationService } from './location.service';
import { StockService } from './stock.service';
import { StockDocService } from './stock-doc.service';
import { DirectStockService } from './direct-stock.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryController } from './inventory.controller';
import { InventoryCountService } from './inventory-count.service';
import { InventoryCountController } from './inventory-count.controller';
import { CostResolverService } from './costing/cost-resolver.service';
import { StockPostingService } from './posting/stock-posting.service';

@Module({
  imports: [AccountingModule],
  controllers: [InventoryController, InventoryCountController],
  providers: [LocationService, StockService, StockDocService, DirectStockService, InventoryQueryService, InventoryCountService, CostResolverService, StockPostingService],
  exports: [LocationService, StockService, StockDocService, DirectStockService, InventoryQueryService, InventoryCountService, CostResolverService, StockPostingService],
})
export class InventoryModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'inventory',
      version: '1.2.0',
      dependencies: ['core', 'accounting'],
      permissions: [
        ...Object.values(PERMISSIONS.inventoryLocation),
        ...Object.values(PERMISSIONS.inventory),
        ...Object.values(PERMISSIONS.inventoryDoc),
        ...Object.values(PERMISSIONS.inventoryCount),
      ],
    });
  }
}
