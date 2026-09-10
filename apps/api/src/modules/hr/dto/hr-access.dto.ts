import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MinLength,
} from 'class-validator';

/**
 * DTOs for the Employee <-> User identity spine.
 *
 * The rest of the HR controller still takes `@Body() dto: any`, which means the
 * global ValidationPipe (whitelist + forbidNonWhitelisted, main.ts:216) never
 * engages for it — an `any` metatype is skipped by class-validator. Every
 * endpoint added here is typed so that unknown fields are rejected rather than
 * silently carried into a Prisma write.
 */

export class LinkUserDto {
  /** An existing user account in the same organization. */
  @IsUUID()
  userId!: string;
}

export class ProvisionUserDto {
  @IsEmail()
  email!: string;

  /**
   * Initial password. Hashed by PasswordService; never stored or echoed.
   *
   * Constraints mirror CreateUserDto exactly. `provisionUser` calls
   * UsersService.create() in process, so that DTO's validation never runs for
   * this path — a laxer rule here would quietly become a second, weaker way to
   * set a password.
   */
  @IsString()
  @MinLength(10, { message: 'password must be at least 10 characters' })
  @Length(0, 128)
  password!: string;

  @IsString()
  @Length(1, 64)
  firstName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 64)
  lastName?: string;

  /** Roles to grant. These decide POS access — employment status never does. */
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  roleIds!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
