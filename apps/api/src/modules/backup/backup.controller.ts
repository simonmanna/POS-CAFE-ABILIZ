import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { BackupService } from './backup.service';
import { BackupConfigDto } from './backup.dto';

@Controller('admin/backups')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get('status')
  @RequirePermissions(PERMISSIONS.backup.read)
  status() {
    return this.backups.getStatus();
  }

  @Get('settings')
  @RequirePermissions(PERMISSIONS.backup.read)
  getSettings() {
    return this.backups.getConfig();
  }

  @Put('settings')
  @RequirePermissions(PERMISSIONS.backup.update)
  updateSettings(@Body() dto: BackupConfigDto) {
    return this.backups.updateConfig(dto);
  }

  @Post('full')
  @RequirePermissions(PERMISSIONS.backup.run)
  runFull() {
    return this.backups.runFullBackup();
  }

  @Post('incremental')
  @RequirePermissions(PERMISSIONS.backup.run)
  runIncremental() {
    return this.backups.runIncrementalBackup();
  }

  @Post('files')
  @RequirePermissions(PERMISSIONS.backup.run)
  runFiles() {
    return this.backups.runFilesBackup();
  }

  @Post('config')
  @RequirePermissions(PERMISSIONS.backup.run)
  runConfig() {
    return this.backups.runConfigBackup();
  }

  @Post('cleanup')
  @RequirePermissions(PERMISSIONS.backup.run)
  cleanup() {
    return this.backups.cleanup();
  }
}
