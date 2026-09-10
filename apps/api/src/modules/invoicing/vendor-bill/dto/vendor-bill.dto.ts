import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { InvoiceLineDto } from '../../invoice/dto/invoice.dto';

export class CreateVendorBillDto {
  /** Supplier partner id. */
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
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  /**
   * PO(s) this bill settles. Writing the link is what makes three-way matching
   * real: without it `VendorBillLink` had no writer anywhere, so the match gate
   * in `post()` was wrapped in a condition that was never true and every bill
   * posted unmatched.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  purchaseOrderIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
}
