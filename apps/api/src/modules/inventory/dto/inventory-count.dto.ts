import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export const INVENTORY_COUNT_TYPES = ['opening', 'closing'] as const;
export type InventoryCountTypeDto = (typeof INVENTORY_COUNT_TYPES)[number];

/** Start (or resume) a count for a location + type. */
export class StartCountDto {
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsOptional()
  @IsIn([...INVENTORY_COUNT_TYPES])
  countType?: InventoryCountTypeDto;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** One counted row in a draft save. `countedQty` null = not yet counted. */
export class SaveCountLineDto {
  @IsString()
  @IsNotEmpty()
  lineId!: string;

  @IsOptional()
  @IsNumber()
  countedQty?: number | null;

  @IsOptional()
  @IsString()
  reason?: string;
}

/** Persist the supervisor's in-progress counts (upsert per line). */
export class SaveCountDraftDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveCountLineDto)
  lines!: SaveCountLineDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}
