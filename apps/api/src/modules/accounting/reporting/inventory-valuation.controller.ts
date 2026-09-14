import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { InventoryValuationReportService } from './inventory-valuation.service';

@Controller('reports/inventory')
export class InventoryValuationController {
  constructor(private readonly reports: InventoryValuationReportService) {}

  /**
   * Inventory valuation. Current value (today) = on-hand × running average;
   * a past `asOf` is rebuilt from the stock ledger up to that moment.
   */
  @Get('valuation')
  @RequirePermissions(PERMISSIONS.report.accounting)
  getValuation(@Query('asOf') asOf?: string) {
    return this.reports.valuation(asOf);
  }

  /** Inventory sub-ledger vs the inventory control account, with the variance explained by source. */
  @Get('gl-tieout')
  @RequirePermissions(PERMISSIONS.report.accounting)
  getTieOut(@Query('asOf') asOf?: string, @Query('tolerance') tolerance?: string) {
    return this.reports.glTieOut(asOf, tolerance != null ? Math.max(0, Number(tolerance) || 0) : 1);
  }
}
