import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { ArReportingService } from './ar-reporting.service';

@Controller('reports/ar')
@RequirePermissions(PERMISSIONS.report.ar)
export class ArReportingController {
  constructor(private readonly reporting: ArReportingService) {}

  @Get('aging')
  aging(@Query('asOf') asOf?: string) {
    return this.reporting.aging(asOf);
  }

  @Get('customer-balances')
  customerBalances() {
    return this.reporting.customerBalances();
  }

  @Get('outstanding')
  outstanding() {
    return this.reporting.outstandingInvoices();
  }

  @Get('revenue-by-customer')
  revenueByCustomer(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reporting.revenueByCustomer({ from, to });
  }

  @Get('revenue-by-period')
  revenueByPeriod(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reporting.revenueByPeriod({ from, to });
  }
}
