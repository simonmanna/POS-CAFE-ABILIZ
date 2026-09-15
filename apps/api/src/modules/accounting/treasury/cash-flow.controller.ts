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
  UseInterceptors,
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
import { Idempotent } from '../../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../../kernel/idempotency/idempotency.interceptor';
import { CashFlowService } from './cash-flow.service';
import { MoneyActivityService } from './money-activity.service';
import { MoneyOverviewService } from './money-overview.service';
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
  @IsString() @IsNotEmpty() counterpartAccountId!: string;
  @IsString() @IsNotEmpty() operationType!: string;
  @IsNumber() @Min(0.01) amount!: number;
  @IsString() @IsNotEmpty() description!: string;
  @IsOptional() @IsDateString() date?: string;
}

class TransactionsQueryDto {
  @IsOptional() @Type(() => Number) page: number = 1;
  @IsOptional() @Type(() => Number) pageSize: number = 25;
  @IsOptional() @IsIn(['deposit', 'withdrawal', 'transfer']) type?: 'deposit' | 'withdrawal' | 'transfer';
  @IsOptional() @IsString() search?: string;
}

class MoneyActivityQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(toList) @IsArray() @IsString({ each: true }) categories?: string[];
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsIn(['in', 'out', 'internal', 'adjustment', 'all']) direction?: 'in' | 'out' | 'internal' | 'adjustment' | 'all';
  @IsOptional() @IsString() search?: string;
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
@UseInterceptors(IdempotencyInterceptor)
export class CashFlowController {
  constructor(
    private readonly cashFlow: CashFlowService,
    private readonly movementReport: CashMovementReportService,
    private readonly moneyActivity: MoneyActivityService,
    private readonly moneyOverview: MoneyOverviewService,
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

  /** Money & Accounts overview: balances by type, registers, today, needs-attention, recent activity. */
  @Get('overview')
  @RequirePermissions(PERMISSIONS.account.read)
  overview() {
    return this.moneyOverview.overview();
  }

  /**
   * Money Activity — one row per journal entry touching a money account, with
   * category, derived direction (in / out / internal / adjustment), external vs
   * internal amounts and every money-account leg.
   */
  @Get('activity')
  @RequirePermissions(PERMISSIONS.account.read)
  activity(@Query() query: MoneyActivityQueryDto) {
    return this.moneyActivity.list(query);
  }

  @Get('operation-types')
  @RequirePermissions(PERMISSIONS.treasury.transfer)
  operationTypes() {
    return this.cashFlow.operationTypes();
  }

  @Get('transactions')
  @RequirePermissions(PERMISSIONS.account.read)
  allTransactions(@Query() query: TransactionsQueryDto) {
    return this.cashFlow.getAllTransactions(query.page, query.pageSize, query.type, query.search);
  }

  @Get(':id/transactions')
  @RequirePermissions(PERMISSIONS.account.read)
  transactions(@Param('id') id: string, @Query() query: TransactionsQueryDto) {
    return this.cashFlow.getTransactions(id, query.page, query.pageSize);
  }

  @Post('deposit')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.treasury.transfer)
  deposit(@Body() dto: CashFlowDto) {
    return this.cashFlow.deposit(dto);
  }

  @Post('withdraw')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.treasury.transfer)
  withdraw(@Body() dto: CashFlowDto) {
    return this.cashFlow.withdraw(dto);
  }
}
