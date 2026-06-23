/**
 * POS P4 — Modifiers + Combos controller.
 * GET endpoints are read-only (`pos:read`); POST endpoints require the
 * product-management permission (re-use `product:create`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosModifiersService } from './pos-modifiers.service';

class CreateGroupDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() minSelect?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() maxSelect?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() sortOrder?: number;
}

class CreateModifierDto {
  @ApiProperty() @IsString() groupId!: string;
  @ApiProperty() @IsString() name!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() priceDelta?: number;
  @ApiProperty({ required: false }) @IsOptional() isDefault?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() sortOrder?: number;
}

class CreateComboItemDto {
  @ApiProperty() @IsString() productId!: string;
  @ApiProperty() @IsNumber() quantity!: number;
}

class CreateComboDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsNumber() price!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() imageUrl?: string;
  @ApiProperty({ type: [CreateComboItemDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CreateComboItemDto)
  items!: CreateComboItemDto[];
}

class AssignGroupDto {
  @ApiProperty() @IsString() modifierGroupId!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() sortOrder?: number;
}

@ApiTags('pos/modifiers')
@ApiBearerAuth()
@Controller('pos/modifiers')
export class PosModifiersController {
  constructor(private readonly svc: PosModifiersService) {}

  @Get('groups')
  @RequirePermissions('pos:read')
  listGroups() {
    return this.svc.listGroups();
  }

  @Post('groups')
  @RequirePermissions('product:create')
  createGroup(@Body() dto: CreateGroupDto) {
    return this.svc.createGroup(dto);
  }

  @Post('modifiers')
  @RequirePermissions('product:create')
  createModifier(@Body() dto: CreateModifierDto) {
    return this.svc.createModifier(dto);
  }

  @Get('combos')
  @RequirePermissions('pos:read')
  listCombos() {
    return this.svc.listCombos();
  }

  @Get('combos/:id')
  @RequirePermissions('pos:read')
  getCombo(@Param('id') id: string) {
    return this.svc.getCombo(id);
  }

  @Post('combos')
  @RequirePermissions('product:create')
  createCombo(@Body() dto: CreateComboDto) {
    return this.svc.createCombo(dto);
  }

  @Get('products/:productId/bundle')
  @RequirePermissions('pos:read')
  getProductBundle(@Param('productId') productId: string) {
    return this.svc.getProductBundle(productId);
  }

  @Post('products/:productId/groups')
  @RequirePermissions('product:create')
  assignGroup(@Param('productId') productId: string, @Body() dto: AssignGroupDto) {
    return this.svc.assignGroupToProduct(productId, dto.modifierGroupId, dto.sortOrder);
  }
}