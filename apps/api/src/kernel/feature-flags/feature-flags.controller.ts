import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-token.service';
import { FeatureFlagsService } from './feature-flags.service';

class SetFlagDto {
  @ApiProperty() @IsString() key!: string;
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true, required: false })
  @IsOptional() payload?: Record<string, unknown>;
}

class SetModuleConfigDto {
  @ApiProperty({ type: 'object', additionalProperties: true, required: false })
  @IsOptional() config?: Record<string, unknown>;
}

@ApiTags('feature-flags')
@ApiBearerAuth()
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(private readonly svc: FeatureFlagsService) {}

  @Get() list() { return this.svc.list(); }
  @Post() set(@Body() dto: SetFlagDto) { return this.svc.set(dto.key, dto.enabled, dto.payload); }
  @Delete(':key') unset(@Param('key') key: string) { return this.svc.unset(key).then(() => ({ ok: true })); }

  @Get('modules') modules() { return this.svc.listModules(); }
  @Post('modules/:name/enable') enable(@Param('name') name: string, @Body() dto: SetModuleConfigDto) {
    return this.svc.enableModule(name, dto.config);
  }
  @Patch('modules/:name/disable') disable(@Param('name') name: string) {
    return this.svc.disableModule(name).then(() => ({ ok: true }));
  }
}
