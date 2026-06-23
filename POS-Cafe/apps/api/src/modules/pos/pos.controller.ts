/**
 * POS Phase A — REST controller.
 *
 * Endpoints (existing + Phase A):
 *   POST /pos/checkout       — full sale (idempotent). Supports split tender.
 *   POST /pos/refund         — credit-note + reversing payment.
 *   POST /pos/sales/:id/void — manager-gated void.
 *   GET  /pos/lookup         — barcode/SKU lookup.
 *
 * /pos/holds/*           → PosHoldsController
 * /pos/override/*        → PosOverridesController
 * /pos/reports/*         → PosReportsController
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { IdempotencyInterceptor } from '../../kernel/idempotency/idempotency.interceptor';
import { Idempotent } from '../../kernel/idempotency/idempotent.decorator';
import { PosService, type CheckoutInput, type CheckoutLine, type PaymentTender } from './pos.service';

class CheckoutLineDto implements CheckoutLine {
  @ApiProperty({ required: false }) @IsOptional() @IsString() productId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() sku?: string;
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumber() quantity!: number;
  @ApiProperty() @IsNumber() unitPrice!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() taxId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() discountPercent?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() note?: string;
}

class PaymentTenderDto implements PaymentTender {
  @ApiProperty({ enum: ['cash', 'bank', 'card', 'mobile_money', 'store_credit'] })
  @IsIn(['cash', 'bank', 'card', 'mobile_money', 'store_credit'])
  method!: PaymentTender['method'];
  @ApiProperty() @IsNumber() @Min(0) amount!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() reference?: string;
}

class CheckoutDto implements CheckoutInput {
  @ApiProperty({ required: false }) @IsOptional() @IsString() partnerId?: string;
  @ApiProperty({ type: [CheckoutLineDto] })
  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  lines!: CheckoutLineDto[];
  @ApiProperty({ required: false, description: 'Transaction-level discount percent (0–100). Default 0.' })
  @IsOptional() @IsNumber() transactionDiscountPercent?: number;
  @ApiProperty({ required: false, description: 'Manager user id; required when discount > 10%.' })
  @IsOptional() @IsString() overrideById?: string;
  @ApiProperty({ required: false, type: [PaymentTenderDto], description: 'Split tender. Sum must equal total.' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentTenderDto)
  tenders?: PaymentTenderDto[];
  @ApiProperty({ required: false, enum: ['cash', 'bank', 'card', 'mobile_money'] })
  @IsOptional() @IsString() paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() amountTendered?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() cashSessionId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() branchId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() reference?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
  /** POS Tables (T1): if the sale is being rung on a table, its id. The
   *  server creates a PosTableOrder row and flips the table to OCCUPIED
   *  inside the same transaction; on payment the table is auto-marked DIRTY. */
  @ApiProperty({ required: false }) @IsOptional() @IsString() tableId?: string;
  /** POS Tables (T1): optional guest count shown on the table card. */
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() guestCount?: number;
}

class RefundDto {
  @ApiProperty() @IsString() invoiceId!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() reason?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() cashSessionId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() overrideById?: string;
}

class VoidDto {
  @ApiProperty() @IsString() reason!: string;
  @ApiProperty({ description: 'Manager user id (override is mandatory for a void).' })
  @IsString() overrideById!: string;
}

@ApiTags('pos')
@ApiBearerAuth()
@Controller('pos')
export class PosController {
  constructor(private readonly svc: PosService) {}

  @Post('checkout')
  @RequirePermissions('pos:checkout')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  checkout(@Body() dto: CheckoutDto) {
    return this.svc.checkout(dto);
  }

  @Post('refund')
  @RequirePermissions('pos:refund')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  refund(@Body() dto: RefundDto) {
    return this.svc.refund(dto);
  }

  @Post('sales/:id/void')
  @RequirePermissions('pos:void')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  void(@Param('id') id: string, @Body() dto: VoidDto) {
    return this.svc.voidSale({ invoiceId: id, reason: dto.reason, overrideById: dto.overrideById });
  }

  @Get('lookup')
  @RequirePermissions('pos:read')
  lookup(@Query('sku') sku: string) {
    return this.svc.findBySku(sku);
  }
}