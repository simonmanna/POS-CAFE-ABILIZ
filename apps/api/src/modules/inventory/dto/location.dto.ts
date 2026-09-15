import { Type } from 'class-transformer';
import { IsInt, Min, Max, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { LOCATION_TYPES, DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@erp/shared';
import { type LocationType } from '@erp/shared';

/** `transit` is system-managed (created by the first transit transfer dispatch). */
const USER_LOCATION_TYPES = LOCATION_TYPES.filter((t) => t !== 'transit');

export class LocationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = DEFAULT_PAGE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsIn([...LOCATION_TYPES])
  type?: LocationType;
}

export class CreateLocationDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsIn([...USER_LOCATION_TYPES], { message: 'type must be a user-managed location type (transit is system-managed)' })
  type?: LocationType;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn([...USER_LOCATION_TYPES], { message: 'type must be a user-managed location type (transit is system-managed)' })
  type?: LocationType;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
