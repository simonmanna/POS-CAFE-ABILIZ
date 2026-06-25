import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsDateString, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { GoodsReceiptsService } from './goods-receipts.service';

export class GRNLineDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() purchaseOrderLineId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() productId?: string;
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumber() quantity!: number;
  @ApiProperty({ required: false, default: 0 }) @IsOptional() @IsNumber() unitCost?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() batchNumber?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expiryDate?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
}

export class CreateGRNDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() purchaseOrderId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() branchId?: string;
  @ApiProperty() @IsString() warehouseId!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() receivedAt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
  @ApiProperty({ type: [GRNLineDto] })
  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GRNLineDto)
  lines!: GRNLineDto[];
}

@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement/goods-receipts')
export class GoodsReceiptsController {
  constructor(private readonly svc: GoodsReceiptsService) {}

  @Get()
  @RequirePermissions('goods_receipt:read')
  list(@Query('status') status?: string, @Query('purchaseOrderId') poId?: string) {
    return this.svc.list({ status, purchaseOrderId: poId });
  }

  @Get(':id')
  @RequirePermissions('goods_receipt:read')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @RequirePermissions('goods_receipt:create')
  create(@Body() dto: CreateGRNDto) {
    return this.svc.create(dto);
  }

  @Patch(':id/post')
  @RequirePermissions('goods_receipt:post')
  post(@Param('id') id: string) {
    return this.svc.post(id);
  }
}
