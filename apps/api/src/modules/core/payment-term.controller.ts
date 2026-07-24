import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsNumber, IsString, Min } from 'class-validator';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PaymentTermService } from './payment-term.service';

class UpsertPaymentTermDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsInt() @Min(0) netDays?: number;
  @IsOptional() @IsInt() @Min(0) discountDays?: number;
  @IsOptional() @IsNumber() discountPercent?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('payment-terms')
export class PaymentTermController {
  constructor(private readonly terms: PaymentTermService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.account.read)
  list() {
    return this.terms.list();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.account.read)
  get(@Param('id') id: string) {
    return this.terms.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.account.create)
  create(@Body() dto: UpsertPaymentTermDto) {
    return this.terms.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.account.update)
  update(@Param('id') id: string, @Body() dto: Partial<UpsertPaymentTermDto>) {
    return this.terms.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.account.delete)
  remove(@Param('id') id: string) {
    return this.terms.remove(id);
  }
}
