import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { CashFlowService } from './cash-flow.service';

export class CashFlowDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  description?: string;
}

class TransactionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  pageSize: number = 25;
}

@Controller('accounts/cash-flow')
export class CashFlowController {
  constructor(private readonly cashFlow: CashFlowService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.account.read)
  listAccounts() {
    return this.cashFlow.getCashAccounts();
  }

  @Get(':id/transactions')
  @RequirePermissions(PERMISSIONS.account.read)
  transactions(
    @Param('id') id: string,
    @Query() query: TransactionsQueryDto,
  ) {
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
