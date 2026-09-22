import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsDateString, IsIn, IsNotEmpty, IsNumber,
  IsOptional, IsPositive, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { STOCK_DISTRIBUTION_STRATEGIES, type StockDistributionStrategy } from '@erp/shared';

// ---------------------------------------------------------------------------
// Direct Stock In
// ---------------------------------------------------------------------------

export class DirectStockInItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsNumber()
  unitCost?: number;

  @IsOptional()
  @IsString()
  batchNumber?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class DirectStockInDto {
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  /// Staff member responsible for the stock-in. Required.
  @IsString()
  @IsNotEmpty()
  responsibleById!: string;

  /// Staff member who approved the stock-in. Required while the org's
  /// inventory.stockInApprovalNeeded setting is on (default); optional when it
  /// is off. When it is not the authenticated caller, `approverPin` must prove
  /// the approval.
  @IsOptional()
  @IsString()
  approvedById?: string;

  /// Approver's override PIN (or `password:<pw>`). Required unless the caller
  /// self-approves while holding inventory_doc:approve.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  approverPin?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DirectStockInItemDto)
  items!: DirectStockInItemDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Direct Stock Out
// ---------------------------------------------------------------------------

export class DirectStockOutItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsIn([...STOCK_DISTRIBUTION_STRATEGIES])
  distStrategy?: StockDistributionStrategy;

  @IsOptional()
  @IsString()
  batchNumber?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class DirectStockOutDto {
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  /// Staff member responsible for the stock-out. Required.
  @IsString()
  @IsNotEmpty()
  responsibleById!: string;

  /// Staff member who approved the stock-out. Required while the org's
  /// inventory.stockOutApprovalNeeded setting is on (default); optional when it
  /// is off. When it is not the authenticated caller, `approverPin` must prove
  /// the approval.
  @IsOptional()
  @IsString()
  approvedById?: string;

  /// Approver's override PIN (or `password:<pw>`). Required unless the caller
  /// self-approves while holding inventory_doc:approve.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  approverPin?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DirectStockOutItemDto)
  items!: DirectStockOutItemDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Stock Ledger Query
// ---------------------------------------------------------------------------

export class StockLedgerQueryDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  referenceType?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  pageSize?: number = 25;
}
