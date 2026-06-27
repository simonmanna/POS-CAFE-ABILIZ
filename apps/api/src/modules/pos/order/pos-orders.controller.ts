import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { PosOrdersService } from './pos-orders.service';
import { PosInvoiceService } from '../billing/pos-invoice.service';
import {
  AddOrderItemsDto, CancelOrderDto, CreateOrderDto, GenerateInvoiceDto, MergeOrderDto,
  MoveTableDto, ReceivePaymentDto, SaveOrderItemsDto, SettleCreditDto, WriteOffDto,
} from './dto/order.dto';

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

  @Get(':id')
  @RequirePermissions('pos:read')
  get(@Param('id') id: string) {
    return this.orders.getOrder(id);
  }

  @Post()
  @RequirePermissions('pos:checkout')
  create(@Body() dto: CreateOrderDto) {
    return this.orders.createOrder(dto);
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

  @Post(':id/fire-kitchen')
  @RequirePermissions('pos:checkout')
  fireKitchen(@Param('id') id: string) {
    return this.orders.fireKitchen(id);
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
  receivePayment(@Param('id') id: string, @Body() dto: ReceivePaymentDto) {
    return this.billing.receivePayment(id, dto);
  }

  /** Settle on credit (postpaid house account). */
  @Post(':id/credit')
  @RequirePermissions('pos:checkout')
  settleCredit(@Param('id') id: string, @Body() dto: SettleCreditDto) {
    return this.billing.settleCredit(id, dto);
  }

  /** Write off the outstanding balance of a credit invoice. */
  @Post(':id/write-off')
  @RequirePermissions('pos:reports')
  writeOff(@Param('id') id: string, @Body() dto: WriteOffDto) {
    return this.billing.writeOff(id, dto);
  }
}
