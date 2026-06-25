import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePODto, UpdatePODto, LinkBillDto } from './purchase-orders.dto';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly svc: PurchaseOrdersService) {}

  @Get()
  @RequirePermissions('purchase_order:read')
  list(@Query('status') status?: string, @Query('partnerId') partnerId?: string) {
    return this.svc.list({ status, partnerId });
  }

  @Get(':id')
  @RequirePermissions('purchase_order:read')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @RequirePermissions('purchase_order:create')
  create(@Body() dto: CreatePODto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('purchase_order:update')
  update(@Param('id') id: string, @Body() dto: UpdatePODto) {
    return this.svc.update(id, dto);
  }

  @Patch(':id/submit')
  @RequirePermissions('purchase_order:create')
  submit(@Param('id') id: string) {
    return this.svc.submit(id);
  }

  @Patch(':id/approve')
  @RequirePermissions('purchase_order:approve')
  approve(@Param('id') id: string) {
    return this.svc.approve(id);
  }

  @Patch(':id/send')
  @RequirePermissions('purchase_order:send')
  send(@Param('id') id: string) {
    return this.svc.sendToSupplier(id);
  }

  @Patch(':id/cancel')
  @RequirePermissions('purchase_order:cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.cancel(id, body?.reason);
  }

  @Post(':id/link-bill')
  @RequirePermissions('purchase_order:update')
  linkBill(@Param('id') id: string, @Body() dto: LinkBillDto) {
    return this.svc.linkBill(id, dto);
  }

  @Post(':id/recompute-match')
  @RequirePermissions('three_way_match:read')
  recompute(@Param('id') id: string) {
    return this.svc.recomputeMatch(id);
  }

  @Delete(':id')
  @RequirePermissions('purchase_order:delete')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
