import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { CrmService } from './crm.service';

class CreateDealDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsString() partnerId!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() ownerId?: string;
  @ApiProperty({ required: false, default: 'lead' })
  @IsOptional() @IsIn(['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])
  stage?: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
  @ApiProperty({ required: false, default: 0 }) @IsOptional() @IsNumber() amount?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() currencyCode?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expectedClose?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
}

class UpdateDealDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() name?: string;
  @ApiProperty({ required: false })
  @IsOptional() @IsIn(['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])
  stage?: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() amount?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expectedClose?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() ownerId?: string;
}

class CreateActivityDto {
  @ApiProperty({ enum: ['call', 'email', 'meeting', 'note', 'task'] })
  @IsIn(['call', 'email', 'meeting', 'note', 'task'])
  type!: 'call' | 'email' | 'meeting' | 'note' | 'task';
  @ApiProperty() @IsString() title!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() body?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() subjectType?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() subjectId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() dealId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() partnerId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() dueAt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() duration?: number;
}

class UpdateActivityDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() title?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() body?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() dueAt?: string;
  @ApiProperty({ required: false, enum: ['todo', 'in_progress', 'done', 'cancelled'] })
  @IsOptional() @IsIn(['todo', 'in_progress', 'done', 'cancelled'])
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() completed?: boolean;
}

@ApiTags('crm')
@ApiBearerAuth()
@Controller('crm/deals')
export class DealsController {
  constructor(private readonly svc: CrmService) {}

  @Get()
  @RequirePermissions('partner:read')  // CRM uses partner-level access
  list(@Query('stage') stage?: string, @Query('partnerId') partnerId?: string) {
    return this.svc.listDeals({ stage, partnerId });
  }

  @Get(':id')
  @RequirePermissions('partner:read')
  findOne(@Param('id') id: string) {
    return this.svc.findDeal(id);
  }

  @Post()
  @RequirePermissions('partner:update')
  create(@Body() dto: CreateDealDto) {
    return this.svc.createDeal(dto);
  }

  @Patch(':id')
  @RequirePermissions('partner:update')
  update(@Param('id') id: string, @Body() dto: UpdateDealDto) {
    return this.svc.updateDeal(id, dto);
  }

  @Patch(':id/stage')
  @RequirePermissions('partner:update')
  changeStage(
    @Param('id') id: string,
    @Body() body: { stage: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost' },
  ) {
    return this.svc.changeStage(id, body.stage);
  }

  @Delete(':id')
  @RequirePermissions('partner:update')
  remove(@Param('id') id: string) {
    return this.svc.removeDeal(id);
  }
}

@ApiTags('crm')
@ApiBearerAuth()
@Controller('crm/activities')
export class ActivitiesController {
  constructor(private readonly svc: CrmService) {}

  @Get()
  list(
    @Query('type') type?: string,
    @Query('dealId') dealId?: string,
    @Query('partnerId') partnerId?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.listActivities({ type, dealId, partnerId, status });
  }

  @Get('upcoming')
  @RequirePermissions('partner:read')
  upcoming(@Query('limit') limit?: string) {
    return this.svc.upcomingTasks(Number(limit ?? 20));
  }

  @Post()
  @RequirePermissions('partner:update')
  create(@Body() dto: CreateActivityDto) {
    return this.svc.createActivity(dto);
  }

  @Patch(':id')
  @RequirePermissions('partner:update')
  update(@Param('id') id: string, @Body() dto: UpdateActivityDto) {
    return this.svc.updateActivity(id, dto);
  }

  @Post(':id/complete')
  @RequirePermissions('partner:update')
  complete(@Param('id') id: string) {
    return this.svc.completeActivity(id);
  }

  @Delete(':id')
  @RequirePermissions('partner:update')
  remove(@Param('id') id: string) {
    return this.svc.removeActivity(id);
  }
}
