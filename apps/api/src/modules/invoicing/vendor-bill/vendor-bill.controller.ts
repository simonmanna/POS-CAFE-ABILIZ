import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { PaginationDto } from '../../../kernel/common/pagination.dto';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { VendorBillService } from './vendor-bill.service';
import { CreateVendorBillDto } from './dto/vendor-bill.dto';

@Controller('expenses')
export class VendorBillController {
  constructor(private readonly bills: VendorBillService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.expense.read)
  list(@Query() query: PaginationDto) {
    return this.bills.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.expense.read)
  findOne(@Param('id') id: string) {
    return this.bills.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.expense.create)
  create(@Body() dto: CreateVendorBillDto) {
    return this.bills.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.expense.update)
  update(@Param('id') id: string, @Body() dto: CreateVendorBillDto) {
    return this.bills.update(id, dto);
  }

  @Post(':id/post')
  @RequirePermissions(PERMISSIONS.expense.post)
  post(@Param('id') id: string) {
    return this.bills.post(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.expense.cancel)
  cancel(@Param('id') id: string) {
    return this.bills.cancel(id);
  }
}
