import { Controller, Get, Post } from '@nestjs/common';
import { BackupService } from './backup.service';

/**
 * Manual controls + status for the admin UI.
 *
 * IMPORTANT: protect these routes with your existing auth, e.g.
 * @UseGuards(JwtAuthGuard, AdminGuard). Status is fine to show clinic staff
 * (a "Last backup: today 02:00 ✓" badge builds real trust); triggering
 * backups should be admin-only.
 */
@Controller('admin/backups')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get('status')
  status() {
    return this.backups.getStatus();
  }

  @Post('full')
  runFull() {
    return this.backups.runFullBackup();
  }

  @Post('base')
  runBase() {
    return this.backups.runBaseBackup();
  }

  @Post('files')
  runFiles() {
    return this.backups.runFilesBackup();
  }
}
