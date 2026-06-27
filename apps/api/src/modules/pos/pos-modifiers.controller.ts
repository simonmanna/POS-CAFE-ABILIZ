/**
 * POS P4 — Modifiers + Combos controller.
 * GET endpoints are read-only (`pos:read`); POST endpoints require the
 * product-management permission (re-use `product:create`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosModifiersService } from './pos-modifiers.service';

class CreateGroupDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty({ required: false, enum: ['ADD_ON', 'MODIFIER'], default: 'ADD_ON' })
  @IsOptional() @IsIn(['ADD_ON', 'MODIFIER'])
  groupType?: 'ADD_ON' | 'MODIFIER';
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

class UpdateGroupDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() name?: string;
  @ApiProperty({ required: false, enum: ['ADD_ON', 'MODIFIER'] })
  @IsOptional() @IsIn(['ADD_ON', 'MODIFIER'])
  groupType?: 'ADD_ON' | 'MODIFIER';
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() minSelect?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() maxSelect?: number;
  @ApiProperty({ required: false }) @IsOptional() isActive?: boolean;
}

class UpdateModifierDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() priceDelta?: number;
  @ApiProperty({ required: false }) @IsOptional() isDefault?: boolean;
  @ApiProperty({ required: false }) @IsOptional() isActive?: boolean;
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

  // ─── Edit / delete (M-E) ───────────────────────────────────────────────

  @Patch('groups/:id')
  @RequirePermissions('product:create')
  updateGroup(@Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.svc.updateGroup(id, dto);
  }

  @Delete('groups/:id')
  @RequirePermissions('product:create')
  deleteGroup(@Param('id') id: string) {
    return this.svc.deleteGroup(id);
  }

  @Patch('modifiers/:id')
  @RequirePermissions('product:create')
  updateModifier(@Param('id') id: string, @Body() dto: UpdateModifierDto) {
    return this.svc.updateModifier(id, dto);
  }

  @Delete('modifiers/:id')
  @RequirePermissions('product:create')
  deleteModifier(@Param('id') id: string) {
    return this.svc.deleteModifier(id);
  }

  @Delete('products/:productId/groups/:groupId')
  @RequirePermissions('product:create')
  unassignGroup(@Param('productId') productId: string, @Param('groupId') groupId: string) {
    return this.svc.unassignGroupFromProduct(productId, groupId);
  }

  /** M-F — modifier sales report (count + add-on revenue per modifier). */
  @Get('report/sales')
  @RequirePermissions('pos:reports')
  modifierSalesReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.modifierSalesReport(from, to);
  }

  // ─── Menu-item modifiers (MENU) ────────────────────────────────────────

  @Get('menu-items/:menuItemId/bundle')
  @RequirePermissions('pos:read')
  getMenuItemBundle(@Param('menuItemId') menuItemId: string) {
    return this.svc.getMenuItemBundle(menuItemId);
  }

  @Post('menu-items/:menuItemId/groups')
  @RequirePermissions('product:create')
  assignGroupToMenuItem(@Param('menuItemId') menuItemId: string, @Body() dto: AssignGroupDto) {
    return this.svc.assignGroupToMenuItem(menuItemId, dto.modifierGroupId, dto.sortOrder);
  }

  @Delete('menu-items/:menuItemId/groups/:groupId')
  @RequirePermissions('product:create')
  unassignGroupFromMenuItem(@Param('menuItemId') menuItemId: string, @Param('groupId') groupId: string) {
    return this.svc.unassignGroupFromMenuItem(menuItemId, groupId);
  }
}