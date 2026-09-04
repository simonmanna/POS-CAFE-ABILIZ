import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { PosPaymentMethodService } from './pos-payment-method.service';
import { POS_TENDER_METHODS } from './tender-account';

class CreatePosPaymentMethodDto {
  @IsString() @IsNotEmpty() code!: string;
  @IsString() @IsNotEmpty() label!: string;
  @IsString() @IsIn(POS_TENDER_METHODS) kind!: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() requiresReference?: boolean;
  @IsOptional() @IsBoolean() trackInShift?: boolean;
}

class UpdatePosPaymentMethodDto {
  @IsOptional() @IsString() @IsNotEmpty() code?: string;
  @IsOptional() @IsString() @IsNotEmpty() label?: string;
  @IsOptional() @IsString() @IsIn(POS_TENDER_METHODS) kind?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() requiresReference?: boolean;
  @IsOptional() @IsBoolean() trackInShift?: boolean;
}

/** Finance-side configuration of the modes the POS Charge dialog offers. */
@Controller('accounts/pos-payment-methods')
export class PosPaymentMethodController {
  constructor(private readonly methods: PosPaymentMethodService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.account.read)
  list() {
    return this.methods.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.account.create)
  create(@Body() dto: CreatePosPaymentMethodDto) {
    return this.methods.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.account.update)
  update(@Param('id') id: string, @Body() dto: UpdatePosPaymentMethodDto) {
    return this.methods.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.account.delete)
  async remove(@Param('id') id: string) {
    await this.methods.remove(id);
  }
}
