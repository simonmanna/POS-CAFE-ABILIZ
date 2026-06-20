import { Module, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';

import { AccountService } from './account/account.service';
import { AccountController } from './account/account.controller';
import { JournalService } from './journal/journal.service';
import { JournalController } from './journal/journal.controller';
import { AccountMappingService } from './account-mapping/account-mapping.service';
import { AccountMappingController } from './account-mapping/account-mapping.controller';
import { FiscalPeriodService } from './posting/fiscal-period.service';
import { AccountDeterminationService } from './posting/account-determination.service';
import { PostingService } from './posting/posting.service';
import { JournalEntryService } from './journal-entry/journal-entry.service';
import { JournalEntryController } from './journal-entry/journal-entry.controller';
import { BankAccountService } from './treasury/bank-account.service';
import { TreasuryService } from './treasury/treasury.service';
import { TreasuryController } from './treasury/treasury.controller';
import { AccountingReportingService } from './reporting/accounting-reporting.service';
import { AccountingReportingController } from './reporting/accounting-reporting.controller';

/**
 * Phase 2 — the financial engine. Exports PostingService + account
 * determination so higher modules (invoicing, POS, payroll...) post through it.
 */
@Module({
  controllers: [
    AccountController,
    JournalController,
    AccountMappingController,
    JournalEntryController,
    TreasuryController,
    AccountingReportingController,
  ],
  providers: [
    AccountService,
    JournalService,
    AccountMappingService,
    FiscalPeriodService,
    AccountDeterminationService,
    PostingService,
    JournalEntryService,
    BankAccountService,
    TreasuryService,
    AccountingReportingService,
  ],
  exports: [PostingService, AccountDeterminationService, FiscalPeriodService],
})
export class AccountingModule implements OnModuleInit {
  constructor(private readonly registry: ModuleRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'accounting',
      version: '1.0.0',
      dependencies: ['core'],
      permissions: [
        ...Object.values(PERMISSIONS.account),
        ...Object.values(PERMISSIONS.journal),
        ...Object.values(PERMISSIONS.journalEntry),
        ...Object.values(PERMISSIONS.accountMapping),
        ...Object.values(PERMISSIONS.bankAccount),
        ...Object.values(PERMISSIONS.treasury),
      ],
    });
  }
}
