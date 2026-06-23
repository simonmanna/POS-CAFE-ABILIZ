import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsDateString, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class POLineDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() productId?: string;
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumber() quantity!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() unitOfMeasureId?: string;
  @ApiProperty() @IsNumber() unitPrice!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() taxId?: string;
  @ApiProperty({ required: false, default: 0 }) @IsOptional() @IsNumber() taxRate?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
}

export class CreatePODto {
  @ApiProperty() @IsString() partnerId!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() branchId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expectedDeliveryDate?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() currencyCode?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() exchangeRate?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() terms?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() requestId?: string;
  @ApiProperty({ type: [POLineDto] })
  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => POLineDto)
  lines!: POLineDto[];
}

export class UpdatePODto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expectedDeliveryDate?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() terms?: string;
}

export class LinkBillDto {
  @ApiProperty() @IsString() vendorBillId!: string;
  @ApiProperty() @IsNumber() amount!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
}
