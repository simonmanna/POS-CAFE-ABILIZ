// Load apps/api/.env first: run from Task Scheduler or a bare shell, nothing
// else provides DATABASE_URL / BACKUP_DIR / BACKUP_ENCRYPTION_PASSWORD.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BackupService } from '../modules/backup/backup.service';

/**
 *   node dist/scripts/run-backup.js [full|files|config|incremental|test-restore|cleanup]
 *
 * Exit code 1 when the run failed, so a scheduler can alert on it.
 */
async function main(): Promise<void> {
  const kind = process.argv[2] ?? 'full';
  // This process only runs the one job: no cron, no catch-up timer.
  process.env.BACKUP_CRON_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const backups = app.get(BackupService);
    const result =
      kind === 'incremental'
        ? await backups.runIncrementalBackup()
        : kind === 'files'
          ? await backups.runFilesBackup()
          : kind === 'config'
            ? await backups.runConfigBackup()
            : kind === 'test-restore'
              ? await backups.runRestoreTest(process.argv[3])
              : kind === 'cleanup'
                ? await backups.cleanup()
                : await backups.runFullBackup();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 'status' in result && result.status === 'failed' ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
