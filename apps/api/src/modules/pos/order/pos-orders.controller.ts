import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { IdempotencyInterceptor } from '../../../kernel/idempotency/idempotency.interceptor';
import { Idempotent } from '../../../kernel/idempotency/idempotent.decorator';
import { PosOrdersService } from './pos-orders.service';
import { PosInvoiceService } from '../billing/pos-invoice.service';
import {
  AddOrderItemsDto, CancelOrderDto, CreateOrderDto, GenerateInvoiceDto, MergeOrderDto, QuoteOrderDto,
  MoveTableDto, ReceivePaymentDto, SaveOrderItemsDto, SettleCreditDto, VoidOrderItemDto, WriteOffDto,
} from './dto/order.dto';

class RefundLineDto {
  @ApiProperty() @IsString() lineId!: string;
  @ApiProperty() @IsNumber() @Min(0) quantity!: number;
}

class RefundInvoiceDto {
  @IsOptional() @IsString() approvalToken?: string;
  @IsOptional() @IsString() overridePin?: string;
  @IsIn(['restock', 'waste', 'no_return']) stockDisposition!: 'restock' | 'waste' | 'no_return';
  @ApiProperty({ required: false }) @IsOptional() @IsString() reason?: string;
  @ApiProperty({ description: 'Manager user id; a void/refund of a settled sale requires an override.' })
  @IsString() overrideById!: string;
  @ApiProperty({ required: false, description: "Cashier's current open cash session, so the refund's cash-out reconciles on this shift." })
  @IsOptional() @IsString() cashSessionId?: string;
  @ApiProperty({ required: false, type: [RefundLineDto], description: 'Partial refund: subset of the invoice lines + quantities. Omit for a full refund.' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RefundLineDto)
  lines?: RefundLineDto[];
}

class FireKitchenDto {
  @ApiProperty({ required: false, description: 'Fire only this course (1=starter, 2=main, …). Omit to fire all pending items.' })
  @IsOptional() @IsNumber() course?: number;
}

@ApiTags('pos/orders')
@ApiBearerAuth()
@Controller('pos/orders')
export class PosOrdersController {
  constructor(
    private readonly orders: PosOrdersService,
    private readonly billing: PosInvoiceService,
  ) {}

  @Get()
  @RequirePermissions('pos:read')
  list(@Query('status') status?: string, @Query('tableId') tableId?: string, @Query('cashSessionId') cashSessionId?: string) {
    return this.orders.list({ status, tableId, cashSessionId });
  }

  @Get('by-table/:tableId')
  @RequirePermissions('pos:read')
  byTable(@Param('tableId') tableId: string) {
    return this.orders.getOpenOrderForTable(tableId);
  }

  /** Live open-orders feed + count for the Odoo-style Orders panel. Declared above
   *  `:id` so "open" isn't captured as an order id. */
  @Get('open')
  @RequirePermissions('pos:read')
  listOpen(
    @Query('orderType') orderType?: string,
    @Query('cashSessionId') cashSessionId?: string,
    @Query('branchId') branchId?: string,
    @Query('search') search?: string,
  ) {
    return this.orders.listOpenOrders({ orderType, cashSessionId, branchId, search });
  }

  @Get(':id')
  @RequirePermissions('pos:read')
  get(@Param('id') id: string) {
    return this.orders.getOrder(id);
  }

  /** Milestone timeline for an order — projected from the event ledger, not
   *  from denormalized columns (Phase B). Declared after `:id`; distinct path. */
  @Get(':id/milestones')
  @RequirePermissions('pos:read')
  milestones(@Param('id') id: string) {
    return this.orders.getMilestones(id);
  }

  @Post('quote')
  @RequirePermissions('pos:checkout')
  quote(@Body() dto: QuoteOrderDto) { return this.orders.quote(dto); }

  @Post()
  @RequirePermissions('pos:checkout')
  async create(@Body() dto: CreateOrderDto) {
    const order = await this.orders.createOrder(dto);
    // Menu items pinned to a prep station reach the KDS as soon as they are
    // ordered. Done here rather than in createOrder so the checkout path (which
    // fires the whole order once, right after creating it) keeps one ticket.
    await this.orders.autoSendRoutedLines(order.id);
    return order;
  }

  /** Auto-save: replace the order's whole item set. */
  @Put(':id/items')
  @RequirePermissions('pos:checkout')
  saveItems(@Param('id') id: string, @Body() dto: SaveOrderItemsDto) {
    return this.orders.saveItems(id, dto);
  }

  /** Add a round of items (append). */
  @Post(':id/items')
  @RequirePermissions('pos:checkout')
  addItems(@Param('id') id: string, @Body() dto: AddOrderItemsDto) {
    return this.orders.addItems(id, dto);
  }

  /**
   * A-016 — void a single line. The ONLY way an already-fired item may leave an
   * order: `saveItems` rejects that removal, so this audited, manager-approved
   * path cannot be sidestepped by a plain auto-save.
   */
  @Delete(':id/items/:itemId')
  @RequirePermissions('pos:void')
  voidItem(@Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: VoidOrderItemDto) {
    return this.orders.voidItem(id, itemId, dto);
  }

  @Post(':id/fire-kitchen')
  @RequirePermissions('pos:checkout')
  fireKitchen(@Param('id') id: string, @Body() body: FireKitchenDto) {
    return this.orders.fireKitchen(id, { course: body?.course ?? null });
  }

  @Post(':id/move')
  @RequirePermissions('tables:transfer')
  move(@Param('id') id: string, @Body() dto: MoveTableDto) {
    return this.orders.moveTable(id, dto.targetTableId);
  }

  @Post(':id/merge')
  @RequirePermissions('tables:merge')
  merge(@Param('id') id: string, @Body() dto: MergeOrderDto) {
    return this.orders.mergeOrders(id, dto.sourceOrderId);
  }

  @Post(':id/cancel')
  @RequirePermissions('pos:checkout')
  cancel(@Param('id') id: string, @Body() dto: CancelOrderDto) {
    return this.orders.cancelOrder(id, dto.reason);
  }

  @Post(':id/reopen')
  @RequirePermissions('pos:override')
  reopen(@Param('id') id: string) {
    return this.orders.reopenOrder(id);
  }

  /** Generate the bill/invoice from this order (deduct stock, post AR). */
  @Post(':id/invoice')
  @RequirePermissions('pos:checkout')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  generateInvoice(@Param('id') id: string, @Body() dto: GenerateInvoiceDto) {
    return this.billing.generateInvoice(id, dto);
  }
}

@ApiTags('pos/invoices')
@ApiBearerAuth()
@Controller('pos/invoices')
export class PosBillingController {
  constructor(private readonly billing: PosInvoiceService) {}

  /** Receive one or more payments and settle the invoice. */
  @Post(':id/payments')
  @RequirePermissions('pos:checkout')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  receivePayment(@Param('id') id: string, @Body() dto: ReceivePaymentDto) {
    return this.billing.receivePayment(id, dto);
  }

  /** Settle on credit (postpaid house account). */
  @Post(':id/credit')
  @RequirePermissions('pos:checkout')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  settleCredit(@Param('id') id: string, @Body() dto: SettleCreditDto) {
    return this.billing.settleCredit(id, dto);
  }

  /**
   * Void / refund a settled invoice (the new Order→Invoice→Receipt pipeline).
   * Reverses the GL, restocks, returns cash, marks the invoice refunded — all in
   * one transaction. Manager override is mandatory.
   */
  @Post(':id/refund')
  @RequirePermissions('pos:refund')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  refund(@Param('id') id: string, @Body() dto: RefundInvoiceDto) {
    return this.billing.refund(id, dto.reason, {
      overrideById: dto.overrideById,
      overridePin: dto.overridePin,
      stockDisposition: dto.stockDisposition,
      cashSessionId: dto.cashSessionId,
      requireOverride: true,
      lines: dto.lines,
    });
  }

  /** Write off the outstanding balance of a credit invoice. */
  @Post(':id/write-off')
  @RequirePermissions('pos:write_off')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true })
  writeOff(@Param('id') id: string, @Body() dto: WriteOffDto) {
    return this.billing.writeOff(id, dto);
  }
}
