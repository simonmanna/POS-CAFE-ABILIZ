import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, ValidateIf } from 'class-validator';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-token.service';
import { ReportAccessService } from './report-access.service';

class SetRoleReportsDto {
  /** Report ids the role may see. `null` clears the override. */
  @ValidateIf((o) => o.reports !== null)
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  reports!: string[] | null;
}

@ApiTags('reports')
@Controller('reports/access')
export class ReportAccessController {
  constructor(private readonly access: ReportAccessService) {}

  /** Catalog of configurable reports. Drives the admin matrix. */
  @Get('catalog')
  @RequirePermissions(PERMISSIONS.role.read)
  catalog() {
    return this.access.catalog();
  }

  /** Every role with its effective report visibility. */
  @Get('roles')
  @RequirePermissions(PERMISSIONS.role.read)
  roles() {
    return this.access.listRoleVisibility();
  }

  @Put('roles/:roleId')
  @RequirePermissions(PERMISSIONS.role.update)
  setRole(@Param('roleId') roleId: string, @Body() dto: SetRoleReportsDto) {
    return this.access.setRoleVisibility(roleId, dto.reports ?? null);
  }

  /**
   * Reports visible to the caller. No permission beyond a session: it only ever
   * narrows what the caller's own roles already allow.
   */
  @Get('me')
  async me(@CurrentUser() user: AuthUser | undefined) {
    return { reports: await this.access.reportsForUser(user?.sub) };
  }
}
