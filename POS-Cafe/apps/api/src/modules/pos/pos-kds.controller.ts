/**
 * POS P5 — KDS controller. Read access via pos:read; lifecycle via pos:checkout.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosKdsService } from './pos-kds.service';

class SendToKitchenItemDto {
  @IsString() productId!: string;
  @IsString() productName!: string;
  @IsOptional() @IsString() notes?: string;
}

class SendToKitchenDto {
  @IsString() label!: string;
  @IsOptional() @IsString() tableId?: string;
  @IsArray() @Type(() => SendToKitchenItemDto)
  items!: SendToKitchenItemDto[];
}

@ApiTags('pos/kds')
@ApiBearerAuth()
@Controller('pos/kds')
export class PosKdsController {
  constructor(private readonly svc: PosKdsService) {}

  @Get('tickets')
  @RequirePermissions('pos:read')
  list(
    @Query('station') station?: 'bar' | 'kitchen' | 'cafe',
    @Query('status') status?: 'new' | 'preparing' | 'ready' | 'served' | 'cancelled',
  ) {
    return this.svc.listTickets(station, status);
  }

  @Get('stream')
  @RequirePermissions('pos:read')
  stream(
    @Res() res: Response,
    @Query('station') station?: 'bar' | 'kitchen' | 'cafe',
  ) {
    return this.svc.streamTickets(res, station);
  }

  @Get('tickets/:id')
  @RequirePermissions('pos:read')
  get(@Param('id') id: string) {
    return this.svc.getTicket(id);
  }

  @Post('tickets/:id/transition')
  @RequirePermissions('pos:checkout')
  transition(@Param('id') id: string, @Body() body: { action: 'start' | 'ready' | 'serve' | 'cancel' }) {
    return this.svc.transition(id, body.action);
  }

  @Post('send-to-kitchen')
  @RequirePermissions('pos:checkout')
  sendToKitchen(@Body() dto: SendToKitchenDto) {
    return this.svc.createTicketsFromCart({
      label: dto.label,
      tableId: dto.tableId,
      items: dto.items,
    });
  }
}