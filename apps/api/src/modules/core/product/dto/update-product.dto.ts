import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  MEASUREMENT_METHODS,
  PRODUCT_TYPES,
  type MeasurementMethod,
  type ProductType,
} from '@erp/shared';

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn([...PRODUCT_TYPES])
  productType?: ProductType;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  uomId?: string;

  @IsOptional()
  @IsString()
  taxId?: string;

  @IsOptional()
  @IsNumber()
  salesPrice?: number;

  @IsOptional()
  @IsNumber()
  costPrice?: number;

  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  // ---- Beverage Control (bar alcohol) — digital-weight measurement ----
  @IsOptional()
  @IsIn([...MEASUREMENT_METHODS])
  measurementMethod?: MeasurementMethod;

  @IsOptional()
  @IsNumber()
  containerVolumeMl?: number;

  @IsOptional()
  @IsNumber()
  emptyBottleWeightG?: number;

  @IsOptional()
  @IsNumber()
  actualEmptyWeightG?: number;

  @IsOptional()
  @IsNumber()
  fullBottleWeightG?: number;

  @IsOptional()
  @IsNumber()
  standardPourMl?: number;

  @IsOptional()
  @IsBoolean()
  allowPartialBottle?: boolean;

  @IsOptional()
  @IsNumber()
  varianceToleranceG?: number;
}
