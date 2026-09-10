import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { GrniReconciliationService } from './grni-reconciliation.service';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement/reports')
export class GrniReconciliationController {
  constructor(private readonly svc: GrniReconciliationService) {}

  /**
   * GRNI reconciliation: open (received-but-unbilled) receipt value, aged, next
   * to the 2150 GL balance it should tie to.
   */
  @Get('grni')
  @RequirePermissions('goods_receipt:read')
  grni(
    @Query('partnerId') partnerId?: string,
    @Query('asOf') asOf?: string,
    @Query('minAgeDays') minAgeDays?: string,
  ) {
    return this.svc.report({
      partnerId,
      asOf,
      minAgeDays: minAgeDays ? Number(minAgeDays) : undefined,
    });
  }
}
