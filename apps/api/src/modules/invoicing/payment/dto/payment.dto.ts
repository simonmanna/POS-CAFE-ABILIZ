import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { PAYMENT_METHODS, type PaymentMethod } from '@erp/shared';

export class PaymentAllocationDto {
  @IsString()
  documentId!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;
}

export class CreatePaymentDto {
  @IsString()
  partnerId!: string;

  @IsDateString()
  paymentDate!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsIn([...PAYMENT_METHODS])
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations?: PaymentAllocationDto[];
}
