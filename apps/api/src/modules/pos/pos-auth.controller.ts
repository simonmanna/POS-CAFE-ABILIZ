/**
 * POS PIN authentication — cashier login + user switching.
 *
 * Uses the existing `User.pinHash` (bcrypt) field. No JWT issued; the frontend
 * stores the verified userId + permissions in a session-level store and sends
 * the userId in the `X-Pos-User` header on subsequent requests.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosAuthService } from './pos-auth.service';
import { IsString, Length } from 'class-validator';

class PinLoginDto {
  @IsString() userId!: string;
  @IsString() @Length(4, 8) pin!: string;
}

@ApiTags('pos/auth')
@ApiBearerAuth()
@Controller('pos/auth')
export class PosAuthController {
  constructor(private readonly svc: PosAuthService) {}

  /** List active staff for POS terminal PIN login (requires pos:read). */
  @Get('staff')
  @HttpCode(200)
  @RequirePermissions('pos:read')
  listStaff() {
    return this.svc.listStaff();
  }

  /** Cashier logs into the POS terminal with their user ID + PIN. */
  @Post('pin-login')
  @HttpCode(200)
  @RequirePermissions('pos:read')
  pinLogin(@Body() dto: PinLoginDto) {
    return this.svc.pinLogin(dto.userId, dto.pin);
  }
}
