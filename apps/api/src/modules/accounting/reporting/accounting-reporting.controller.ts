import { Controller, Get, Param, Query } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { AccountingReportingService } from './accounting-reporting.service';

@Controller('reports/accounting')
@RequirePermissions(PERMISSIONS.report.accounting)
export class AccountingReportingController {
  constructor(private readonly reporting: AccountingReportingService) {}

  @Get('trial-balance')
  trialBalance(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reporting.trialBalance({ from, to });
  }

  @Get('account-ledger/:accountId')
  accountLedger(
    @Param('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reporting.accountLedger(accountId, { from, to });
  }

  @Get('general-ledger')
  generalLedger(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
  ) {
    return this.reporting.generalLedger({ from, to }, Number(page) || 1, 100);
  }
}
