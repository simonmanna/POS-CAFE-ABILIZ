import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { IdempotencyInterceptor } from '../../kernel/idempotency/idempotency.interceptor';
import { Idempotent } from '../../kernel/idempotency/idempotent.decorator';
import { GoodsReceiptsService } from './goods-receipts.service';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement/goods-receipts')
export class GoodsReceiptsController {
  constructor(private readonly svc: GoodsReceiptsService) {}

  @Post('adhoc')
  @RequirePermissions('goods_receipt:create')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
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

  /**
   * Draft-only GRN. Creates the paper record and stops — stock does NOT move and
   * nothing posts to the GL until {@link post} is called. Kept as a distinct
   * endpoint because a receiving clerk capturing a delivery note is a real step,
   * but it is no longer a third posting path: `create` cannot post, only `post`
   * can, and `post` is the single audited draft→posted transition.
   */
  @Post()
  @RequirePermissions('goods_receipt:create')
  createDraft(
    @Body()
    body: {
      purchaseOrderId?: string;
      warehouseId: string;
      branchId?: string;
      partnerId?: string;
      receivedAt?: string;
      notes?: string;
      lines: Array<{
        purchaseOrderLineId?: string;
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
    return this.svc.createDraft(body);
  }

  /**
   * Posting is the irreversible step: it moves stock, capitalises inventory
   * and (for a PO-linked receipt) vouchers the payable. It used to reuse
   * `goods_receipt:create`, so whoever could key in a delivery note could also
   * commit it — no segregation of duties on the only money-moving transition
   * in the module.
   */
  @Patch(':id/post')
  @RequirePermissions('goods_receipt:post')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  post(@Param('id') id: string) {
    return this.svc.post(id);
  }

  @Get()
  @RequirePermissions('goods_receipt:read')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.list({ page: Number(page), pageSize: Number(pageSize), search, status });
  }

  @Get(':id')
  @RequirePermissions('goods_receipt:read')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  /**
   * Posted reversal: returns the goods out of stock, mirrors the receipt's
   * journals in the current period and rolls the PO back. Refused once billed/paid.
   */
  @Patch(':id/reverse')
  @RequirePermissions('goods_receipt:cancel')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  reverse(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.svc.reverse(id, body?.reason);
  }
}
