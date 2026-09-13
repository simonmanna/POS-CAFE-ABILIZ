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
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { Idempotent } from '../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../kernel/idempotency/idempotency.interceptor';
import { ExpensesService } from './expenses.service';
import {
  ApproveExpenseDto,
  CreateExpenseDto,
  PayExpenseDto,
  RejectExpenseDto,
  UpdateExpenseDto,
  VoidExpenseDto,
} from './dto/expense.dto';

@Controller('expenses')
@UseInterceptors(IdempotencyInterceptor)
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  // ── Static routes first so they don't get swallowed by `:id` ──
  @Get('stats')
  @RequirePermissions(PERMISSIONS.expense.read)
  stats(@Query('dateFrom') dateFrom?: string, @Query('dateTo') dateTo?: string) {
    return this.expenses.stats(dateFrom, dateTo);
  }

  @Get('meta/accounts')
  @RequirePermissions(PERMISSIONS.expense.read)
  accounts() {
    return this.expenses.paymentAccounts();
  }

  @Get('meta/suppliers')
  @RequirePermissions(PERMISSIONS.expense.read)
  suppliers() {
    return this.expenses.suppliers();
  }

  @Get()
  @RequirePermissions(PERMISSIONS.expense.read)
  list(@Query() query: any) {
    return this.expenses.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.expense.read)
  findOne(@Param('id') id: string) {
    return this.expenses.findOne(id);
  }

  @Get(':id/audit')
  @RequirePermissions(PERMISSIONS.expense.read)
  audit(@Param('id') id: string) {
    return this.expenses.getAudit(id);
  }

  @Post()
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.expense.create)
  create(@Body() dto: CreateExpenseDto) {
    return this.expenses.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.expense.update)
  update(@Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expenses.update(id, dto);
  }

  @Post(':id/approve')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.expense.approve)
  approve(@Param('id') id: string, @Body() dto: ApproveExpenseDto) {
    return this.expenses.approve(id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.expense.approve)
  reject(@Param('id') id: string, @Body() dto: RejectExpenseDto) {
    return this.expenses.reject(id, dto.reason);
  }

  @Post(':id/pay')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.expense.post)
  pay(@Param('id') id: string, @Body() dto: PayExpenseDto) {
    return this.expenses.pay(id, dto);
  }

  @Post(':id/void')
  @Idempotent({ required: true })
  @RequirePermissions(PERMISSIONS.expense.cancel)
  voidExpense(@Param('id') id: string, @Body() dto: VoidExpenseDto) {
    return this.expenses.void(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.expense.cancel)
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.expenses.remove(id);
  }
}
