import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** A modifier add-on selected on a line (price already known by the client). */
export class OrderLineModifierDto {
  @IsString() modifierId!: string;
  @IsString() name!: string;
  @IsNumber() priceDelta!: number;
}

/** One cart line. Mirrors PosService.CheckoutLine but as a validated DTO. */
export class OrderLineDto {
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() menuItemId?: string;
  @IsOptional() @IsString() sku?: string;
  @IsString() description!: string;
  @IsNumber() @Min(0) quantity!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsNumber() discountPercent?: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineModifierDto)
  modifiers?: OrderLineModifierDto[];
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) accompanimentOptionIds?: string[];
  @IsOptional() @IsString() comboId?: string;
  @IsOptional() @IsBoolean() taxInclusive?: boolean;
}

export class CreateOrderDto {
  @IsOptional() @IsIn(['dine_in', 'takeaway', 'delivery']) orderType?: 'dine_in' | 'takeaway' | 'delivery';
  @IsOptional() @IsString() tableId?: string;
  @IsOptional() @IsString() partnerId?: string;
  @IsOptional() @IsString() waiterId?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() cashSessionId?: string;
  @IsOptional() @IsNumber() guestCount?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines?: OrderLineDto[];
}

/** Auto-save: replace the order's whole item set with exactly these lines. */
export class SaveOrderItemsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines!: OrderLineDto[];
  @IsOptional() @IsNumber() expectedVersion?: number;
  @IsOptional() @IsNumber() guestCount?: number;
  @IsOptional() @IsString() partnerId?: string;
  @IsOptional() @IsNumber() transactionDiscountPercent?: number;
}

/** Add a round of items (append) — optionally fire the new items to the kitchen. */
export class AddOrderItemsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines!: OrderLineDto[];
  @IsOptional() @IsBoolean() sendToKitchen?: boolean;
  @IsOptional() @IsNumber() guestCount?: number;
  @IsOptional() @IsString() overrideById?: string;
  @IsOptional() @IsNumber() transactionDiscountPercent?: number;
}

export class CancelOrderDto {
  @IsOptional() @IsString() reason?: string;
}

export class MoveTableDto {
  @IsString() targetTableId!: string;
}

/** Merge another open order's items into this one. */
export class MergeOrderDto {
  @IsString() sourceOrderId!: string;
}

/** Generate the bill/invoice from an order. paymentMode is optional intent. */
export class GenerateInvoiceDto {
  @IsOptional() @IsIn(['cash', 'card', 'mobile_money', 'mixed', 'credit'])
  paymentMode?: 'cash' | 'card' | 'mobile_money' | 'mixed' | 'credit';
  @IsOptional() @IsNumber() transactionDiscountPercent?: number;
  @IsOptional() @IsString() branchId?: string;
}

export class TenderDto {
  @IsIn(['cash', 'bank', 'card', 'mobile_money', 'store_credit'])
  method!: 'cash' | 'bank' | 'card' | 'mobile_money' | 'store_credit';
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsString() reference?: string;
}

/** Receive one or more payments against an invoice. */
export class ReceivePaymentDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TenderDto) tenders?: TenderDto[];
  @IsOptional() @IsIn(['cash', 'bank', 'card', 'mobile_money']) paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
  @IsOptional() @IsNumber() amountTendered?: number;
  @IsOptional() @IsString() cashSessionId?: string;
}

/** Settle an invoice on credit (postpaid house account). */
export class SettleCreditDto {
  @IsOptional() @IsString() partnerId?: string;
  @IsOptional() @IsString() notes?: string;
}

export class WriteOffDto {
  @IsString() reason!: string;
}
