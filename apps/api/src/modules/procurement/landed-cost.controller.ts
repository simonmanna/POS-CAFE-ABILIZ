import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { Idempotent } from '../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../kernel/idempotency/idempotency.interceptor';
import { LandedCostService } from './landed-cost.service';
import { CreateLandedCostDto } from './landed-cost.dto';

@Controller('procurement/landed-costs')
@UseInterceptors(IdempotencyInterceptor)
export class LandedCostController {
  constructor(private readonly landedCosts: LandedCostService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.procurement.goodsReceipt.read)
  list(@Query('goodsReceiptId') goodsReceiptId?: string) {
    return this.landedCosts.list(goodsReceiptId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.procurement.goodsReceipt.read)
  get(@Param('id') id: string) {
    return this.landedCosts.get(id);
  }

  @Post()
  @Idempotent()
  @RequirePermissions(PERMISSIONS.procurement.goodsReceipt.create)
  create(@Body() dto: CreateLandedCostDto) {
    return this.landedCosts.create(dto);
  }

  @Post(':id/post')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.procurement.goodsReceipt.post)
  post(@Param('id') id: string) {
    return this.landedCosts.post(id);
  }

  @Post(':id/cancel')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.procurement.goodsReceipt.cancel)
  cancel(@Param('id') id: string) {
    return this.landedCosts.cancel(id);
  }
}
