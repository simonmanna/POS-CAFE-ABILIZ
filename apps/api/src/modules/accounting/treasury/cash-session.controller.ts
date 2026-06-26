import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { Idempotent } from '../../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../../kernel/idempotency/idempotency.interceptor';
import { CashSessionService } from './cash-session.service';
import { IsNumber, IsOptional, IsString, Min, IsIn } from 'class-validator';
import { PaginationDto } from '../../../kernel/common/pagination.dto';

class OpenSessionDto {
  @IsString() cashRegisterId!: string;
  @IsOptional() @IsNumber() @Min(0) openingFloat?: number;
  @IsOptional() @IsString() notes?: string;
}

class CloseSessionDto {
  @IsNumber() closingCounted!: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() varianceReason?: string;
  @IsOptional() @IsString() @IsIn(['pending_review', 'approved', 'rejected']) varianceStatus?: string;
}

class RecordMovementDto {
  @IsOptional() @IsString() sessionId?: string;
  @IsString() movementType!: 'pay_in' | 'pay_out' | 'adjustment';
  @IsNumber() amount!: number;
  @IsOptional() @IsString() reason?: string;
}

class BankDepositDto {
  @IsNumber() @Min(0) amount!: number;
  @IsString() bankName!: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsNumber() @Min(0) remainingFloat?: number;
  @IsOptional() @IsString() notes?: string;
}

class VarianceUpdateDto {
  @IsString() reason!: string;
  @IsOptional() @IsString() @IsIn(['pending_review', 'approved', 'rejected']) status?: string;
}

@Controller('cash-sessions')
@UseInterceptors(IdempotencyInterceptor)
export class CashSessionController {
  constructor(private readonly sessions: CashSessionService) {}

  @Get('open')
  @RequirePermissions(PERMISSIONS.cashSession.read)
  findOpen() {
    return this.sessions.findOpen();
  }

  @Get('history')
  @RequirePermissions(PERMISSIONS.cashSession.read)
  history(
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('registerId') registerId?: string,
  ) {
    return this.sessions.history(
      page ? Math.max(1, Number(page)) : 1,
      perPage ? Math.min(100, Math.max(1, Number(perPage))) : 20,
      registerId,
    );
  }

  @Get('report/daily')
  @RequirePermissions(PERMISSIONS.cashSession.read)
  dailyReconciliation(@Query('date') date: string) {
    return this.sessions.dailyReconciliation(date);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.cashSession.read)
  findOne(@Param('id') id: string) {
    return this.sessions.findById(id);
  }

  @Get(':id/movements')
  @RequirePermissions(PERMISSIONS.cashSession.read)
  getMovements(@Param('id') id: string) {
    return this.sessions.getMovements(id);
  }

  @Get(':id/expected')
  @RequirePermissions(PERMISSIONS.cashSession.read)
  async expected(@Param('id') id: string) {
    const value = await this.sessions.expectedCash(id);
    return { sessionId: id, expectedCash: value.toString() };
  }

  @Post('open')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.cashSession.open)
  open(@Body() dto: OpenSessionDto) {
    return this.sessions.open(dto);
  }

  @Post('close')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.cashSession.close)
  close(@Body() dto: CloseSessionDto) {
    return this.sessions.close({
      closingCounted: dto.closingCounted,
      notes: dto.notes,
      varianceReason: dto.varianceReason,
      varianceStatus: dto.varianceStatus,
    });
  }

  @Post('movement')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.cashSession.open)
  recordMovement(@Body() dto: RecordMovementDto) {
    return this.sessions.recordMovement(dto.sessionId, {
      movementType: dto.movementType,
      amount: dto.amount,
      reason: dto.reason,
    });
  }

  @Post(':id/banking')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.cashSession.close)
  banking(@Param('id') id: string, @Body() dto: BankDepositDto) {
    return this.sessions.recordBankDeposit(id, dto);
  }

  @Patch(':id/variance')
  @RequirePermissions(PERMISSIONS.cashSession.close)
  updateVariance(@Param('id') id: string, @Body() dto: VarianceUpdateDto) {
    return this.sessions.updateVariance(id, {
      reason: dto.reason,
      status: dto.status as any,
    });
  }
}