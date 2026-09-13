import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, UseInterceptors } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { Idempotent } from '../../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../../kernel/idempotency/idempotency.interceptor';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/payment.dto';

class VoidPaymentDto {
  @IsString() @IsNotEmpty() reason!: string;
  /** Required when the cash was taken in a shift that is already closed. */
  @IsOptional() @IsString() correctionSessionId?: string;
}

@Controller()
@UseInterceptors(IdempotencyInterceptor)
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  // ---- Customer receipts (inbound) ----
  @Get('payments')
  @RequirePermissions(PERMISSIONS.payment.read)
  listReceipts(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize: number,
    @Query('search') search?: string,
    @Query('partnerId') partnerId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.payments.list({ page, pageSize, search }, 'inbound', partnerId, dateFrom, dateTo);
  }

  @Get('payments/:id')
  @RequirePermissions(PERMISSIONS.payment.read)
  findOne(@Param('id') id: string) {
    return this.payments.findOne(id);
  }

  @Post('payments')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.payment.create)
  createReceipt(@Body() dto: CreatePaymentDto) {
    return this.payments.createReceipt(dto);
  }

  @Post('payments/:id/void')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.payment.void)
  voidPayment(@Param('id') id: string, @Body() dto: VoidPaymentDto) {
    return this.payments.void(id, dto);
  }

  // ---- Supplier payments (outbound) ----
  @Get('supplier-payments')
  @RequirePermissions(PERMISSIONS.payment.read)
  listSupplierPayments(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize: number,
    @Query('search') search?: string,
    @Query('partnerId') partnerId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.payments.list({ page, pageSize, search }, 'outbound', partnerId, dateFrom, dateTo);
  }

  @Post('supplier-payments')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.payment.create)
  createSupplierPayment(@Body() dto: CreatePaymentDto) {
    return this.payments.createSupplierPayment(dto);
  }
}
