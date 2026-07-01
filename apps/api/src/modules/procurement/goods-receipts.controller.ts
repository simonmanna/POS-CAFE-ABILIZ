import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { GoodsReceiptsService } from './goods-receipts.service';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement/goods-receipts')
export class GoodsReceiptsController {
  constructor(private readonly svc: GoodsReceiptsService) {}

  @Post('adhoc')
  @RequirePermissions('goods_receipt:create')
  createAdhoc(
    @Body()
    body: {
      warehouseId: string;
      branchId?: string;
      partnerId?: string;
      receivedAt?: string;
      notes?: string;
      lines: Array<{
        productId?: string;
        description: string;
        quantity: number;
        unitCost?: number;
        batchNumber?: string;
        expiryDate?: string;
        notes?: string;
      }>;
    },
  ) {
    return this.svc.createAdhoc(body);
  }

  @Get()
  @RequirePermissions('goods_receipt:read')
  list(@Query('status') status?: string, @Query('purchaseOrderId') purchaseOrderId?: string) {
    return this.svc.list({ status, purchaseOrderId });
  }

  @Get(':id')
  @RequirePermissions('goods_receipt:read')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }
}
