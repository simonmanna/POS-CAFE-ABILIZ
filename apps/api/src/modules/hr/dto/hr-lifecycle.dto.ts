import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

/**
 * Lifecycle DTOs.
 *
 * Every one of these actions is irreversible-ish and shows up in an audit
 * trail, so `reason` is mandatory wherever a human will later ask "why?".
 * `disableAccount` is deliberately required, not optional-with-a-default:
 * whether a departing employee instantly loses their login is a decision, and
 * guessing it silently is wrong in both directions.
 */
export class TerminateEmployeeDto {
  @IsOptional()
  @IsDateString()
  terminationDate?: string;

  @IsString()
  @Length(3, 500)
  reason!: string;

  /** Required: no default. See the class doc. */
  @IsBoolean()
  disableAccount!: boolean;

  /** Voluntary departure — records RESIGNED instead of TERMINATED. */
  @IsOptional()
  @IsBoolean()
  resigned?: boolean;
}

export class SuspendEmployeeDto {
  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsBoolean()
  disableAccount!: boolean;
}

export class ReactivateEmployeeDto {
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;

  /** Re-enable the linked login. Opt-in: it may be disabled for another reason. */
  @IsOptional()
  @IsBoolean()
  enableAccount?: boolean;

  /** Rehire onto probation rather than straight to active. */
  @IsOptional()
  @IsBoolean()
  toProbation?: boolean;
}

export class TransferEmployeeDto {
  @IsOptional()
  @IsUUID()
  toBranchId?: string;

  @IsOptional()
  @IsUUID()
  toDepartmentId?: string;

  @IsOptional()
  @IsUUID()
  toPositionId?: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class ConfirmEmployeeDto {
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

/**
 * Change what a linked account can do. Roles are the only authorization input —
 * employment status never grants or revokes a permission.
 */
export class UpdateAccessDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleIds?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
