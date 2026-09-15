import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export const INVENTORY_COUNT_TYPES = ['opening', 'closing', 'cycle', 'spot'] as const;

/** Accept `a,b` query strings as well as JSON arrays. */
const toIdList = ({ value }: { value: unknown }) =>
  value == null || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
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

  /// Blind count: counters never see system quantities or variances while counting.
  @IsOptional()
  @IsBoolean()
  blind?: boolean;

  /// Partial count: only products in these categories (cycle counts).
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @IsString({ each: true })
  scopeCategoryIds?: string[];

  /// Partial count: only these products (spot checks).
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @IsString({ each: true })
  scopeProductIds?: string[];

  /// Discard an open draft that already has counts entered and start over.
  /// Without it, start() resumes that draft instead of wiping someone's work.
  @IsOptional()
  @IsBoolean()
  restart?: boolean;
}

/** Read-only look at the sheet a count of this location would produce. */
export class PreviewCountQueryDto {
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsOptional()
  @IsIn([...INVENTORY_COUNT_TYPES])
  countType?: InventoryCountTypeDto;

  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @IsString({ each: true })
  scopeCategoryIds?: string[];

  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @IsString({ each: true })
  scopeProductIds?: string[];
}

/** One counted row in a draft save. `countedQty` null = not yet counted. */
export class SaveCountLineDto {
  @IsString()
  @IsNotEmpty()
  lineId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
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

  /** User-visible label e.g. "Opening Count – Jul 01, 2026". */
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Submit a count. A physical count overwrites system on-hand, so any movement
 * that happened AFTER a line was physically counted would be silently absorbed
 * into the variance (masking shrinkage, or erasing real sales). Submit therefore
 * refuses when such movements exist unless the supervisor explicitly accepts
 * them via `force`.
 */
export class SubmitCountDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  /** Required when `force` is true — recorded on the session and audited. */
  @IsOptional()
  @IsString()
  forceReason?: string;
}
