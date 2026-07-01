import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class InvoiceLineDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @IsPositive({ message: 'Quantity must be greater than 0' })
  quantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'Unit price must be at least 0.01' })
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'Discount percent cannot be negative' })
  @Max(100, { message: 'Discount percent cannot exceed 100' })
  discountPercent?: number;

  @IsOptional()
  @IsString()
  taxId?: string;
}

export class CreateInvoiceDto {
  @IsString()
  partnerId!: string;

  @IsDateString()
  issueDate!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  currencyId?: string;

  @IsOptional()
  @IsNumber()
  exchangeRate?: number;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
}
