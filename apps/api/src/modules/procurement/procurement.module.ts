import { Module, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { CoreModule } from '../core/core.module';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicingModule } from '../invoicing/invoicing.module';

import { PurchaseRequestsService } from './purchase-requests.service';
import { PurchaseRequestsController } from './purchase-requests.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { GoodsReceiptsService } from './goods-receipts.service';
import { GoodsReceiptsController } from './goods-receipts.controller';
import { DebitNotesService } from './debit-notes.service';
import { DebitNotesController } from './debit-notes.controller';
import { GrniReconciliationService } from './grni-reconciliation.service';
import { GrniReconciliationController } from './grni-reconciliation.controller';
import { LandedCostService } from './landed-cost.service';
import { LandedCostController } from './landed-cost.controller';

/**
 * Procurement module (Phase F.6).
 *
 * Owns the buy-side chain: PurchaseRequest → PurchaseOrder → GoodsReceiptNote.
 * Vendor bills are created through InvoicingModule (vendor_bill document) and
 * linked back via VendorBillLink. ThreeWayMatch reconciles quantities and
 * prices; status=blocked lines require an AP override before the bill can post.
 *
 * Debit notes also live here because they are the buy-side counterpart of
 * credit notes (supplier-issued or customer-issued).
 */
@Module({
  imports: [CoreModule, AccountingModule, InventoryModule, InvoicingModule],
  controllers: [
    PurchaseRequestsController,
    PurchaseOrdersController,
    GoodsReceiptsController,
    DebitNotesController,
    GrniReconciliationController,
    LandedCostController,
  ],
  providers: [
    PurchaseRequestsService,
    PurchaseOrdersService,
    GoodsReceiptsService,
    DebitNotesService,
    GrniReconciliationService,
    LandedCostService,
  ],
  exports: [
    PurchaseOrdersService,
    PurchaseRequestsService,
    GoodsReceiptsService,
    DebitNotesService,
    GrniReconciliationService,
  ],
})
export class ProcurementModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'procurement',
      version: '1.0.0',
      dependencies: ['core', 'accounting', 'inventory', 'invoicing'],
      // Driven from the shared catalog. Hand-listing drifted: the activate
      // route enforces `purchase_order:approve` but it was never registered, so
      // it could not be granted from the roles UI at all, and
      // `goods_receipt:post`/`cancel` were missing entirely.
      permissions: [
        ...Object.values(PERMISSIONS.procurement.purchaseRequest),
        ...Object.values(PERMISSIONS.procurement.purchaseOrder),
        ...Object.values(PERMISSIONS.procurement.goodsReceipt),
        ...Object.values(PERMISSIONS.procurement.threeWayMatch),
        ...Object.values(PERMISSIONS.debitNote),
      ],
    });
  }
}
