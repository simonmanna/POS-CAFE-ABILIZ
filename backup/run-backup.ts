/**
 * Standalone runner — lives in src/scripts/ (adjust import paths to your layout).
 *
 * Use it from Windows Task Scheduler as a safety net for when the API process
 * itself is down, or for manual runs:
 *
 *   node dist/scripts/run-backup.js full
 *   node dist/scripts/run-backup.js base
 *   node dist/scripts/run-backup.js files
 *
 * If Task Scheduler becomes your PRIMARY scheduler, set
 * BACKUP_CRON_ENABLED=false in .env so the in-app cron doesn't double-run.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BackupService } from '../backup/backup.service';

async function main(): Promise<void> {
  const kind = process.argv[2] ?? 'full';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const backups = app.get(BackupService);
    const result =
      kind === 'base'
        ? await backups.runBaseBackup()
        : kind === 'files'
          ? await backups.runFilesBackup()
          : await backups.runFullBackup();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
