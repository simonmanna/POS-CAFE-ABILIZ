/**
 * POS Phase A — Reports controller.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosReportsService } from './pos-reports.service';

@ApiTags('pos/reports')
@ApiBearerAuth()
@Controller('pos/reports')
export class PosReportsController {
  constructor(private readonly svc: PosReportsService) {}

  @Get('x-report')
  @RequirePermissions('pos:reports')
  xReport(@Query('cashSessionId') cashSessionId?: string) {
    return this.svc.xReport(cashSessionId);
  }

  @Get('z-report')
  @RequirePermissions('pos:reports')
  zReport(@Query('cashSessionId') cashSessionId?: string) {
    return this.svc.zReport(cashSessionId);
  }

  @Get('z-report/:cashSessionId')
  @RequirePermissions('pos:reports')
  getZReport(@Param('cashSessionId') cashSessionId: string) {
    return this.svc.getZReportSnapshot(cashSessionId);
  }

  @Get('sales-by-hour')
  @RequirePermissions('pos:reports')
  salesByHour(@Query('date') date: string) {
    return this.svc.salesByHour(date);
  }

  @Get('top-items')
  @RequirePermissions('pos:reports')
  topItems(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.topItems(fromDate, toDate, limit ? Number(limit) : 20);
  }

  @Get('sales-summary')
  @RequirePermissions('pos:reports')
  salesSummary(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('groupBy') groupBy: 'day' | 'week' | 'month',
  ) {
    return this.svc.salesSummary(fromDate, toDate, groupBy);
  }
}