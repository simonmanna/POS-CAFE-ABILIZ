import { Module, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { AccountingModule } from '../accounting/accounting.module';

import { TaxCalculationService } from './tax/tax-calculation.service';
import { DocumentBuilderService } from './document/document-builder.service';
import { InvoiceService } from './invoice/invoice.service';
import { InvoiceController } from './invoice/invoice.controller';
import { CreditNoteService } from './credit-note/credit-note.service';
import { CreditNoteController } from './credit-note/credit-note.controller';
import { VendorBillService } from './vendor-bill/vendor-bill.service';
import { VendorBillController } from './vendor-bill/vendor-bill.controller';
import { PaymentService } from './payment/payment.service';
import { PaymentController } from './payment/payment.controller';
import { ArReportingService } from './reporting/ar-reporting.service';
import { ArReportingController } from './reporting/ar-reporting.controller';

/**
 * Phase 3 — universal document framework + Accounts Receivable. Depends on the
 * accounting engine; future verticals (POS, School...) only create documents.
 */
@Module({
  imports: [AccountingModule],
  controllers: [
    InvoiceController,
    CreditNoteController,
    VendorBillController,
    PaymentController,
    ArReportingController,
  ],
  providers: [
    TaxCalculationService,
    DocumentBuilderService,
    InvoiceService,
    CreditNoteService,
    VendorBillService,
    PaymentService,
    ArReportingService,
  ],
})
export class InvoicingModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'invoicing',
      version: '1.0.0',
      dependencies: ['accounting'],
      permissions: [
        ...Object.values(PERMISSIONS.invoice),
        ...Object.values(PERMISSIONS.creditNote),
        ...Object.values(PERMISSIONS.expense),
        ...Object.values(PERMISSIONS.payment),
        PERMISSIONS.report.ar,
      ],
    });
  }
}
