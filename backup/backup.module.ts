import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/**
 * Lives in src/backup/. Requires: npm i @nestjs/schedule
 *
 * Register once in AppModule:
 *
 *   imports: [ScheduleModule.forRoot(), BackupModule, ...]
 *
 * (If you already call ScheduleModule.forRoot() for other cron jobs, just add
 * BackupModule.)
 */
@Module({
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
