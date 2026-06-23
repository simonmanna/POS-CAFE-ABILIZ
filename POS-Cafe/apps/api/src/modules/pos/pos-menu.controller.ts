/**
 * POS — Menu management HTTP API.
 *
 * Endpoints (all under /api/v1/pos/menu*):
 *   GET    /menu/items                List all (admin view)
 *   GET    /menu/items/available      The shape the POS terminal + digital-menu load on startup
 *   GET    /menu/items/:id            Detail with ingredients
 *   POST   /menu/items                Create
 *   PATCH  /menu/items/:id            Update metadata (price, image, availability, etc.)
 *   PATCH  /menu/items/:id/availability  Quick toggle for 86'ing
 *   DELETE /menu/items/:id            Soft-disable (sets isAvailable=false)
 *
 *   GET    /menu/categories           List active categories (display order)
 *   POST   /menu/categories           Create
 *
 * Auth: global JWT guard is mounted in main.ts (no @UseGuards here). Endpoints
 * are gated by the `@RequirePermissions` decorator where write operations live.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { PosMenuService } from './pos-menu.service';

class CreateMenuItemDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() code?: string;
  @ApiProperty() @IsString() name!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() categoryId?: string;
  @ApiProperty({ required: false, description: 'Minor units (e.g. cents). E.g. 500 = $5.00' })
  @IsOptional() @IsNumber() basePrice?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() image?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() preparationTime?: number;
  @ApiProperty({ required: false, default: true }) @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() displayOrder?: number;
  @ApiProperty({ type: () => [IngredientDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => IngredientDto)
  ingredients!: IngredientDto[];
}
class IngredientDto {
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty({ required: false, default: 1 }) @IsOptional() @IsNumber() quantity?: number;
}

class UpdateMenuItemDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() code?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsNumber() basePrice?: number | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() image?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsNumber() preparationTime?: number | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() displayOrder?: number;
  @ApiProperty({ required: false, type: () => [IngredientDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IngredientDto)
  ingredients?: IngredientDto[];
}

class CreateCategoryDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() parentId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() image?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() icon?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() displayOrder?: number;
}

@Controller('pos/menu')
export class PosMenuController {
  constructor(private readonly svc: PosMenuService) {}

  // ─── Categories ───
  @Get('categories')
  listCategories() { return this.svc.listCategories(); }

  @Post('categories')
  @RequirePermissions('product:create')
  createCategory(@Body() body: CreateCategoryDto) { return this.svc.createCategory(body); }

  @Patch('categories/:id')
  @RequirePermissions('product:update')
  updateCategory(@Param('id') id: string, @Body() body: Partial<CreateCategoryDto>) {
    return this.svc.updateCategory(id, body);
  }

  @Delete('categories/:id')
  @RequirePermissions('product:delete')
  deleteCategory(@Param('id') id: string) { return this.svc.deleteCategory(id); }

  // ─── Items ───
  @Get('items/available')
  available() { return this.svc.listAvailable(); }

  @Get('items')
  list() { return this.svc.listAll(); }

  @Get('items/:id')
  getOne(@Param('id') id: string) { return this.svc.getOne(id); }

  @Post('items')
  @RequirePermissions('product:create')
  create(@Body() body: CreateMenuItemDto) { return this.svc.create(body); }

  @Patch('items/:id')
  @RequirePermissions('product:update')
  update(@Param('id') id: string, @Body() body: UpdateMenuItemDto) {
    return this.svc.update(id, body);
  }

  @Patch('items/:id/availability')
  @RequirePermissions('product:update')
  setAvail(@Param('id') id: string, @Body() body: { isAvailable: boolean }) {
    return this.svc.setAvailability(id, body.isAvailable);
  }

  @Delete('items/:id')
  @RequirePermissions('product:delete')
  remove(@Param('id') id: string) { return this.svc.disable(id); }
}