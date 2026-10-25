import * as fs from 'node:fs';
import { BackupFrequency, BackupType, CompressionLevel, DestinationType, EncryptionType, InternetBehaviour, RetentionMode } from './backup.dto';

export const BACKUP_SETTING_KEY = 'backup.config';

/** Shown in API responses in place of stored secrets; sending it back keeps the stored value. */
export const SECRET_MASK = '********';

/** Retention never deletes below this many newest backups, whatever the policy says. */
export const MIN_BACKUPS_KEPT = 3;

// Auto-detect the PostgreSQL bin directory on Windows. Elsewhere the client
// tools are expected on PATH ('' → bare tool name).
function detectPgBin(): string {
  if (process.platform !== 'win32') return '';
  const versions = ['18', '17', '16', '15', '14', '13', '12'];
  for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
    for (const version of versions) {
      const binPath = `${base}\\${version}\\bin`;
      if (fs.existsSync(`${binPath}\\pg_dump.exe`)) return binPath;
    }
  }
  return '';
}

export const PG_BIN_DEFAULT = process.env.PG_BIN || detectPgBin();

function envFrequency(): BackupFrequency {
  const v = process.env.BACKUP_FREQUENCY as BackupFrequency | undefined;
  return v && Object.values(BackupFrequency).includes(v) ? v : BackupFrequency.Daily;
}

function envTime(): string {
  const v = process.env.BACKUP_TIME ?? '';
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '02:00';
}

const envRetentionDays = Number(process.env.BACKUP_FULL_RETENTION_DAYS) || 0;

export const BACKUP_DEFAULTS = {
  frequency: envFrequency(),
  dailyConfig: { times: [envTime()] },
  weeklyConfig: { days: [0], time: envTime() },
  customCronExpression: '',
  customIntervalMinutes: 60,
  types: [BackupType.Full],
  includes: {
    database: true,
    schemaOnly: false,
    databaseData: true,
    uploadedImages: true,
    productImages: true,
    customerDocuments: true,
    generatedReports: false,
    attachments: false,
    envFile: true,
    configFiles: true,
    posSettings: true,
    orgSettings: true,
    printerConfig: true,
    receiptTemplates: true,
    kitchenPrinterSettings: true,
    logs: false,
    auditLogs: false,
    scheduledTasks: false,
  },
  destinations: [
    { type: DestinationType.Local, path: process.env.BACKUP_DIR || 'backup', label: 'Local Backup', enabled: true },
  ],
  retention: {
    mode: envRetentionDays > 0 ? RetentionMode.KeepByAge : RetentionMode.KeepLast,
    keepLastCount: 14,
    keepDays: envRetentionDays > 0 ? envRetentionDays : 30,
    smartDaily: 14,
    smartWeekly: 8,
    smartMonthly: 12,
  },
  compression: CompressionLevel.Normal,
  // The env password (BACKUP_ENCRYPTION_PASSWORD) is read at use time and never
  // copied into this object: whatever is here gets persisted to the settings
  // table and served to the settings page.
  encryption: { type: EncryptionType.None, password: '' },
  verification: { verifyIntegrity: true, testRestore: true, sha256Checksum: true },
  notifications: {
    on: ['failed'],
    channels: ['desktop'],
    emailAddress: process.env.BACKUP_NOTIFY_EMAIL || '',
    phoneNumber: '',
  },
  cleanup: { deleteExpired: true, deleteTempFiles: true, removeFailedFiles: true },
  internetBehaviour: InternetBehaviour.LocalOnly,
  namingFormat: 'POS-CAFE_{TYPE}_{DATE}_{TIME}',
  schedule: { time: envTime(), dayOfWeek: 7, timezone: 'UTC', customIntervalMinutes: 60, cronExpression: '' },
  advanced: {
    maxThreads: 1,
    compressionLevel: 6,
    pauseBusinessHours: false,
    businessHoursStart: '08:00',
    businessHoursEnd: '22:00',
    skipIfBusy: false,
    retryCount: 2,
    retryDelayMinutes: 5,
    backupTimeoutMinutes: 60,
    maxDiskUsageGb: 999999,
    autoDiskSpaceCheck: true,
  },
};
