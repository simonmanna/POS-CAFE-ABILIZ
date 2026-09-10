import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../kernel/idempotency/idempotency.interceptor';
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  CreatePODto,
  UpdatePODto,
  ReceivePODto,
  PayPODto,
} from './purchase-orders.dto';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly svc: PurchaseOrdersService) {}

  @Get()
  @RequirePermissions('purchase_order:read')
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize: number,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('paymentType') paymentType?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('partnerId') partnerId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.svc.list({ status, paymentType, paymentStatus, partnerId, search, page, pageSize, dateFrom, dateTo });
  }

  @Get(':id')
  @RequirePermissions('purchase_order:read')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  /** Step 1: Register a purchase order */
  @Post()
  @RequirePermissions('purchase_order:create')
  create(@Body() dto: CreatePODto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('purchase_order:update')
  update(@Param('id') id: string, @Body() dto: UpdatePODto) {
    return this.svc.update(id, dto);
  }

  /**
   * Step 2: Receive products against an active PO.
   *
   * Idempotent like the goods-receipt post route: a retry on a flaky
   * connection would otherwise move stock, capitalise inventory and voucher AP
   * a second time. The over-receipt ceiling in applyReceiptToPO caps the
   * damage but does not prevent it on a partially received order.
   */
  @Post(':id/receive')
  @RequirePermissions('purchase_order:receive')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  receive(@Param('id') id: string, @Body() dto: ReceivePODto) {
    return this.svc.receive(id, dto);
  }

  /** Step 3: Register payment (credit purchases only) */
  @Post(':id/pay')
  @RequirePermissions('purchase_order:pay')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  pay(@Param('id') id: string, @Body() dto: PayPODto) {
    return this.svc.pay(id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('purchase_order:cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.cancel(id, body?.reason);
  }

  @Post(':id/activate')
  @RequirePermissions('purchase_order:approve')
  activate(@Param('id') id: string) {
    return this.svc.activate(id);
  }

  @Delete(':id')
  @RequirePermissions('purchase_order:delete')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
