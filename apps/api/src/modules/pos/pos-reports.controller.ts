/**
 * POS Phase A — Reports controller.
 *
 * Every range report takes the same filter vocabulary (`waiterId`,
 * `paymentMethod`, `orderType`, `search`) so a filter chosen on one tab means
 * the same thing on the next. Unknown filter values are rejected by the service
 * rather than silently ignored — a filter that quietly does nothing is worse
 * than an error, because the numbers still look plausible.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosReportsService } from './pos-reports.service';

/** Treat empty strings from the query string as "no filter". */
const opt = (v?: string): string | undefined => (v && v.trim() ? v.trim() : undefined);

@ApiTags('pos/reports')
@ApiBearerAuth()
@Controller('pos/reports')
export class PosReportsController {
  constructor(private readonly svc: PosReportsService) {}

  @Get('filter-options')
  @RequirePermissions('pos:reports')
  filterOptions(@Query('fromDate') fromDate: string, @Query('toDate') toDate: string) {
    return this.svc.filterOptions(fromDate, toDate);
  }

  @Get('x-report')
  @RequirePermissions('pos:reports')
  xReport(@Query('cashSessionId') cashSessionId?: string) {
    return this.svc.xReport(opt(cashSessionId));
  }

  @Get('z-report')
  @RequirePermissions('pos:reports')
  zReport(@Query('cashSessionId') cashSessionId?: string) {
    return this.svc.zReport(opt(cashSessionId));
  }

  @Get('z-report/:cashSessionId')
  @RequirePermissions('pos:reports')
  getZReport(@Param('cashSessionId') cashSessionId: string) {
    return this.svc.getZReportSnapshot(cashSessionId);
  }

  @Get('sales-by-hour')
  @RequirePermissions('pos:reports')
  salesByHour(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('hours') hours?: string,
    @Query('orderType') orderType?: string,
    @Query('waiterId') waiterId?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.svc.salesByHour(fromDate, toDate, opt(hours), {
      orderType: opt(orderType),
      waiterId: opt(waiterId),
      paymentMethod: opt(paymentMethod),
    });
  }

  @Get('top-items')
  @RequirePermissions('pos:reports')
  topItems(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('limit') limit?: string,
    @Query('categoryId') categoryId?: string,
    @Query('orderType') orderType?: string,
    @Query('waiterId') waiterId?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.svc.topItems(fromDate, toDate, limit ? Number(limit) : 20, opt(categoryId), {
      orderType: opt(orderType),
      waiterId: opt(waiterId),
      paymentMethod: opt(paymentMethod),
    });
  }

  @Get('sales-summary')
  @RequirePermissions('pos:reports')
  salesSummary(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('groupBy') groupBy: 'day' | 'week' | 'month',
    @Query('orderType') orderType?: string,
    @Query('waiterId') waiterId?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.svc.salesSummary(fromDate, toDate, groupBy, {
      orderType: opt(orderType),
      waiterId: opt(waiterId),
      paymentMethod: opt(paymentMethod),
    });
  }

  @Get('sold-items')
  @RequirePermissions('pos:reports')
  soldItems(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('categoryId') categoryId?: string,
    @Query('waiterId') waiterId?: string,
    @Query('orderType') orderType?: string,
    @Query('search') search?: string,
    @Query('itemSearch') itemSearch?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.svc.soldItems(
      fromDate,
      toDate,
      opt(categoryId),
      opt(waiterId),
      opt(orderType),
      opt(search),
      opt(itemSearch),
      opt(paymentMethod),
    );
  }

  @Get('sales-report')
  @RequirePermissions('pos:reports')
  salesReport(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('waiterId') waiterId?: string,
    @Query('search') search?: string,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('orderType') orderType?: string,
  ) {
    return this.svc.salesReport(fromDate, toDate, opt(waiterId), opt(search), opt(paymentMethod), opt(orderType));
  }

  @Get('order-report')
  @RequirePermissions('pos:reports')
  orderReport(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('orderType') orderType?: string,
    @Query('status') status?: string,
    @Query('waiterId') waiterId?: string,
    @Query('search') search?: string,
    @Query('includeCancelled') includeCancelled?: string,
  ) {
    return this.svc.orderReport(
      fromDate,
      toDate,
      opt(orderType),
      opt(status),
      opt(waiterId),
      opt(search),
      includeCancelled === 'true' || includeCancelled === '1',
    );
  }

  @Get('cashier-report')
  @RequirePermissions('pos:reports')
  cashierReport(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('waiterId') waiterId?: string,
    @Query('search') search?: string,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('orderType') orderType?: string,
  ) {
    return this.svc.cashierReport(fromDate, toDate, opt(waiterId), opt(search), opt(paymentMethod), opt(orderType));
  }

  @Get('cashier-shift-summary')
  @RequirePermissions('pos:reports')
  cashierShiftSummary(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('cashierId') cashierId?: string,
    @Query('registerId') registerId?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.cashierShiftSummary(fromDate, toDate, opt(cashierId), opt(registerId), opt(status));
  }

  @Get('waiter-report')
  @RequirePermissions('pos:reports')
  waiterReport(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('waiterId') waiterId?: string,
    @Query('orderType') orderType?: string,
    @Query('search') search?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.svc.waiterReport(fromDate, toDate, opt(waiterId), opt(orderType), opt(search), opt(paymentMethod));
  }

  @Get('item-sales')
  @RequirePermissions('pos:reports')
  itemSales(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('itemKey') itemKey?: string,
    @Query('categoryId') categoryId?: string,
    @Query('waiterId') waiterId?: string,
    @Query('orderType') orderType?: string,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('itemSearch') itemSearch?: string,
  ) {
    return this.svc.itemSales(
      fromDate,
      toDate,
      opt(itemKey),
      opt(categoryId),
      opt(waiterId),
      opt(orderType),
      opt(paymentMethod),
      opt(itemSearch),
    );
  }

  @Get('items-by-group')
  @RequirePermissions('pos:reports')
  itemsByGroup(
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('orderType') orderType?: string,
    @Query('waiterId') waiterId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.svc.itemsByGroup(fromDate, toDate, opt(orderType), opt(waiterId), opt(categoryId), opt(paymentMethod));
  }
}
