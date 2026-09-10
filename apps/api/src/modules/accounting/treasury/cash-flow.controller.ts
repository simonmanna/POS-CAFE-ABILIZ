import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { CashFlowService } from './cash-flow.service';
import {
  CashMovementReportService,
  type CashMovementGrouping,
} from './cash-movement-report.service';

/** `?accountIds=a,b` and `?accountIds=a&accountIds=b` both arrive as a string[]. */
const toList = ({ value }: { value: unknown }): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((v) => String(v).trim())
    .filter(Boolean);

class CreateCashAccountDto {
  @IsString() @IsNotEmpty() code!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsIn(['cash', 'bank', 'mobile_money', 'petty_cash']) accountType!: string;
  @IsOptional() @IsString() currencyId?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() accountNumber?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateCashAccountDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() currencyId?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() accountNumber?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class CashFlowDto {
  @IsString() @IsNotEmpty() accountId!: string;
  @IsNumber() @Min(0.01) amount!: number;
  @IsOptional() @IsString() description?: string;
}

class TransactionsQueryDto {
  @IsOptional() @Type(() => Number) page: number = 1;
  @IsOptional() @Type(() => Number) pageSize: number = 25;
}

class CashFlowReportQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(toList) @IsArray() @IsString({ each: true }) accountIds?: string[];
  @IsOptional() @Transform(toList) @IsArray() @IsString({ each: true }) accountTypes?: string[];
  @IsOptional() @Transform(toList) @IsArray() @IsString({ each: true }) categories?: string[];
  @IsOptional() @IsIn(['in', 'out', 'all']) direction?: 'in' | 'out' | 'all';
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minAmount?: number;
  @IsOptional() @IsIn(['day', 'week', 'month']) groupBy?: CashMovementGrouping;
  @IsOptional() @Type(() => Number) page: number = 1;
  @IsOptional() @Type(() => Number) pageSize: number = 50;
}

@Controller('accounts/cash-flow')
export class CashFlowController {
  constructor(
    private readonly cashFlow: CashFlowService,
    private readonly movementReport: CashMovementReportService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.account.read)
  listAccounts() {
    return this.cashFlow.getCashAccounts();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.account.create)
  create(@Body() dto: CreateCashAccountDto) {
    return this.cashFlow.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.account.update)
  update(@Param('id') id: string, @Body() dto: UpdateCashAccountDto) {
    return this.cashFlow.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.account.delete)
  remove(@Param('id') id: string) {
    return this.cashFlow.remove(id);
  }

  /**
   * Cash Flow Report — every cash movement (in / out / transfer) across the
   * payment accounts, with summary, per-account and per-category rollups and a
   * trend series all derived from the same filtered set.
   */
  @Get('report')
  @RequirePermissions(PERMISSIONS.account.read)
  report(@Query() query: CashFlowReportQueryDto) {
    return this.movementReport.report(query);
  }

  @Get('transactions')
  @RequirePermissions(PERMISSIONS.account.read)
  allTransactions(@Query() query: TransactionsQueryDto) {
    return this.cashFlow.getAllTransactions(query.page, query.pageSize);
  }

  @Get(':id/transactions')
  @RequirePermissions(PERMISSIONS.account.read)
  transactions(@Param('id') id: string, @Query() query: TransactionsQueryDto) {
    return this.cashFlow.getTransactions(id, query.page, query.pageSize);
  }

  @Post('deposit')
  @RequirePermissions(PERMISSIONS.treasury.transfer)
  deposit(@Body() dto: CashFlowDto) {
    return this.cashFlow.deposit(dto.accountId, dto.amount, dto.description);
  }

  @Post('withdraw')
  @RequirePermissions(PERMISSIONS.treasury.transfer)
  withdraw(@Body() dto: CashFlowDto) {
    return this.cashFlow.withdraw(dto.accountId, dto.amount, dto.description);
  }
}
