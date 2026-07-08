/**
 * POS Module (Phase 8) — Reference implementation of the cafe POS vertical.
 *
 * Phases built on top of the core vertical:
 *   - A: sells, holds, overrides, X/Z reports, voids, refunds
 *   - B: receipts (PDF / ESC/POS / email / reprint)
 *   - D (Sprint P3-P5): modifiers, combos, KDS
 *   - E (Sprint P7): loyalty, store credit, customer tabs
 *   - F (Digital Menu): QR session, public menu, online orders
 *   - T1 (ADR-012): tables management (table CRUD, merge, transfer, split,
 *                   reservations, utilization / revenue / reservation reports)
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { CoreModule } from '../core/core.module';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { AuthModule } from '../../kernel/auth/auth.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { PosWorkflowsInitializer } from './pos.workflows';
import { PosHoldsService } from './pos-holds.service';
import { PosHoldsController } from './pos-holds.controller';
import { PosOverridesService } from './pos-overrides.service';
import { PosOverridesController } from './pos-overrides.controller';
import { PosAuthService } from './pos-auth.service';
import { PosAuthController } from './pos-auth.controller';
import { PosShiftService } from './pos-shift.service';
import { PosShiftController } from './pos-shift.controller';
import { PosReportsService } from './pos-reports.service';
import { PosReportsController } from './pos-reports.controller';
import { PosReceiptsService } from './pos-receipts.service';
import { PosReceiptsController } from './pos-receipts.service';
import { PosModifiersService } from './pos-modifiers.service';
import { PosModifiersController } from './pos-modifiers.controller';
import { PosKdsService } from './pos-kds.service';
import { PosKdsController } from './pos-kds.controller';
import { PosLoyaltyService } from './pos-loyalty.service';
import { PosLoyaltyController } from './pos-loyalty.controller';
import { DigitalMenuService } from './digital-menu.service';
import { DigitalMenuController } from './digital-menu.controller';
import { DigitalMenuPublicController } from './digital-menu-public.controller';
import { PosMenuService } from './pos-menu.service';
import { PosMenuController } from './pos-menu.controller';
import { PosVariantService } from './pos-variant.service';
import { PosAccompanimentService } from './pos-accompaniment.service';
import { PosTablesService } from './pos-tables.service';
import { PosTablesController } from './pos-tables.controller';
import { PosReservationsService } from './pos-reservations.service';
import { PosReservationsController } from './pos-reservations.controller';
import { PosTableReportsService } from './pos-table-reports.service';
import { PosPrintLifecycleService } from './pos-print-lifecycle.service';
import { PosOrdersService } from './order/pos-orders.service';
import { PosOrdersController, PosBillingController } from './order/pos-orders.controller';
import { PosInvoiceService } from './billing/pos-invoice.service';
import { PosCustomerStatementService, PosCustomerStatementController } from './billing/pos-customer-statement.controller';
import { PosSplitService } from './split/pos-split.service';
import { PosSplitController } from './split/pos-split.controller';
import {
  PosTableReportsController,
  PosReservationReportsController,
} from './pos-table-reports.controller';
import { ReservationWorker } from '../../kernel/workers/reservation-worker';

export const POS_PERMISSIONS = {
  pos: {
    read: 'pos:read',
    checkout: 'pos:checkout',
    refund: 'pos:refund',
    openSession: 'pos:open_session',
    closeSession: 'pos:close_session',
    hold: 'pos:hold',
    discount: 'pos:discount',
    void: 'pos:void',
    override: 'pos:override',
    reports: 'pos:reports',
    deleteItem: 'pos:delete_item',
  },
  // ADR-012 — Tables Management
  tables: {
    view: 'tables:view',
    create: 'tables:create',
    edit: 'tables:edit',
    delete: 'tables:delete',
    transfer: 'tables:transfer',
    merge: 'tables:merge',
    split: 'tables:split',
    clean: 'tables:clean',
    reserve: 'tables:reserve',
  },
};

@Module({
  imports: [CoreModule, AccountingModule, InventoryModule, InvoicingModule, AuthModule],
  controllers: [
    PosController,
    PosAuthController,
    PosShiftController,
    PosHoldsController,
    PosOverridesController,
    PosReportsController,
    PosReceiptsController,
    PosModifiersController,
    PosKdsController,
    PosLoyaltyController,
    DigitalMenuController,
    DigitalMenuPublicController,
    PosMenuController,
    PosTablesController,
    PosReservationsController,
    PosTableReportsController,
    PosReservationReportsController,
    PosOrdersController,
    PosBillingController,
    PosSplitController,
    PosCustomerStatementController,
  ],
  providers: [
    PosService,
    PosOrdersService,
    PosInvoiceService,
    PosCustomerStatementService,
    PosSplitService,
    PosWorkflowsInitializer,
    PosShiftService,
    PosHoldsService,
    PosOverridesService,
    PosAuthService,
    PosReportsService,
    PosReceiptsService,
    PosModifiersService,
    PosKdsService,
    PosLoyaltyService,
    DigitalMenuService,
    PosMenuService,
    PosVariantService,
    PosAccompanimentService,
    PosTablesService,
    PosReservationsService,
    PosTableReportsService,
    ReservationWorker,
    PosPrintLifecycleService,
  ],
  exports: [
    PosService, PosOrdersService, PosInvoiceService,
    PosHoldsService, PosOverridesService, PosReportsService,
    PosReceiptsService, PosModifiersService, PosVariantService, PosAccompanimentService, PosKdsService,
    PosLoyaltyService, DigitalMenuService,
    PosTablesService, PosReservationsService, PosTableReportsService,
  ],
})
export class PosModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'pos',
      version: '1.4.0',
      dependencies: ['core', 'accounting', 'inventory', 'invoicing'],
      permissions: [
        ...Object.values(POS_PERMISSIONS.pos),
        ...Object.values(POS_PERMISSIONS.tables),
      ],
    });
  }
}