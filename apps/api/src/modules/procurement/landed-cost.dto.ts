import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';

export const LANDED_COST_KINDS = ['freight', 'duty', 'insurance', 'handling', 'other'] as const;
export const LANDED_COST_ALLOCATION_METHODS = ['value', 'quantity', 'equal'] as const;

export class LandedCostChargeDto {
  @IsIn([...LANDED_COST_KINDS])
  kind!: (typeof LANDED_COST_KINDS)[number];

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;
}

export class CreateLandedCostDto {
  @IsString()
  @IsNotEmpty()
  goodsReceiptId!: string;

  /// Account credited on post: freight accrual, AP clearing, bank…
  @IsString()
  @IsNotEmpty()
  creditAccountId!: string;

  @IsOptional()
  @IsIn([...LANDED_COST_ALLOCATION_METHODS])
  allocationMethod?: (typeof LANDED_COST_ALLOCATION_METHODS)[number];

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LandedCostChargeDto)
  charges!: LandedCostChargeDto[];
}
