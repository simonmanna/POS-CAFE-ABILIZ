import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';
import {
  STOCK_MOVE_TYPES,
  STOCK_DISTRIBUTION_STRATEGIES,
  type StockMoveType,
  type StockDistributionStrategy,
} from '@erp/shared';

export class ReceiveStockDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

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
  reference?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** Receipt driven by a vendor bill. Posts Dr Stock / Cr GRNI inside the bill's transaction. */
export class ReceiveFromBillDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsNumber()
  @Min(0)
  unitCost!: number;

  @IsString()
  @IsNotEmpty()
  billId!: string;

  @IsDateString()
  billDate!: string;

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

export class IssueStockDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  /// Ledger move type to record (default 'issue'). Doc wrappers pass 'waste',
  /// 'expiry_write_off', 'return_to_supplier', etc.
  @IsOptional()
  @IsIn([...STOCK_MOVE_TYPES])
  moveType?: StockMoveType;

  /// Batch distribution strategy for batch-tracked products.
  @IsOptional()
  @IsIn([...STOCK_DISTRIBUTION_STRATEGIES])
  distStrategy?: StockDistributionStrategy;

  /// MANUAL strategy: consume only from this batch number.
  @IsOptional()
  @IsString()
  batchNumber?: string;
}

export class AdjustStockDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  @Min(0)
  countedQuantity!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class TransferStockDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  @IsNotEmpty()
  fromLocationId!: string;

  @IsString()
  @IsNotEmpty()
  toLocationId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}