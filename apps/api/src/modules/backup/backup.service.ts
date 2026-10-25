import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as nodemailer from 'nodemailer';
import { SettingsService } from '../../kernel/settings/settings.service';
import { BACKUP_DEFAULTS, BACKUP_SETTING_KEY, MIN_BACKUPS_KEPT, PG_BIN_DEFAULT, SECRET_MASK } from './backup.constants';
import { ENCRYPTED_SUFFIX, decryptFile, encryptFile } from './backup-crypto';
import { BackupFrequency, BackupType, DestinationType, EncryptionType, InternetBehaviour, NotifyChannel, NotifyOn, RestoreScope, RetentionMode } from './backup.dto';
import type { BackupConfigDto, BackupCopyResult, BackupDestinationDto, BackupKind, BackupRunResult, RestoreScopeType } from './backup.dto';

const execFileAsync = promisify(execFile);

interface RestoreRequest {
  scope: RestoreScopeType;
  backupFile: string;
  targetDatabase?: string;
  verifyOnly?: boolean;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  durationMs: number;
  error?: string;
  /** The NEW database the backup was restored into. */
  database?: string;
  checks?: RestoreChecks;
}

export interface RestoreChecks {
  tocEntries: number;
  checksum: 'verified' | 'no-sidecar';
  tables?: { restored: number; live: number };
  migrations?: { restored: number; live: number };
  organizations?: { restored: number; live: number };
}

export interface BackupListItem {
  file: string;
  name: string;
  size: number;
  mtime: Date;
  kind: string;
  encrypted: boolean;
}

interface WalArchiveStatus {
  archiveMode: string;
  failedCount: number;
  lastArchivedWal?: string;
  lastFailedWal?: string;
  error?: string;
}

interface DiskSpaceInfo {
  freeBytes: number;
  totalBytes: number;
  usagePercent: number;
  hasSpace: boolean;
}

export interface BackupHealth {
  status: 'healthy' | 'degraded' | 'critical';
  lastFullBackup?: BackupRunResult;
  lastIncrementalBackup?: BackupRunResult;
  lastRestoreTest?: BackupRunResult;
  walArchiveStatus?: WalArchiveStatus;
  diskSpace?: DiskSpaceInfo;
  issues: string[];
  checkedAt: string;
}

interface PgConnection {
  env: NodeJS.ProcessEnv;
  database: string;
}

/** Destinations written with plain file copies (and verified by re-hashing the copy). */
const FOLDER_DESTINATIONS = new Set<DestinationType>([DestinationType.Local, DestinationType.ExternalDrive, DestinationType.NetworkFolder]);
/** Sub-folders that hold dated artifacts subject to retention. `files` is a mirror and never pruned. */
const ARTIFACT_KINDS = ['full', 'config', 'incremental'] as const;
const CHECKSUM_SUFFIX = '.sha256';
const PARTIAL_SUFFIX = '.partial';
const GB = 1024 * 1024 * 1024;
const HEALTH_CACHE_MS = 60_000;
const CATCH_UP_DELAY_MS = 2 * 60_000;

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private history: BackupRunResult[] = [];
  private busy = new Set<BackupKind>();
  private config: BackupConfigDto = structuredClone(BACKUP_DEFAULTS) as any;
  private cronJobNames: string[] = [];
  private scheduleError: string | undefined;
  private catchUpTimer: NodeJS.Timeout | undefined;
  private healthCache: { at: number; value: BackupHealth } | undefined;
  private readonly warnedOnce = new Set<string>();
  private mailer: nodemailer.Transporter | null | undefined;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // ==========================================================================
  // Config
  // ==========================================================================

  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] ?? {}, source[key]);
      } else {
        result[key] = source[key] ?? target[key];
      }
    }
    return result;
  }

  private async loadConfig(): Promise<void> {
    try {
      // Server-wide: one database dump covers every tenant.
      const setting = await this.settingsService.getServerWide(BACKUP_SETTING_KEY);
      if (setting?.value && typeof setting.value === 'object') {
        this.config = this.deepMerge(structuredClone(BACKUP_DEFAULTS), setting.value) as BackupConfigDto;
      }
    } catch {
      this.logger.warn('Failed to load backup config from DB, using defaults');
    }
  }

  getConfig(): BackupConfigDto {
    return structuredClone(this.config) as BackupConfigDto;
  }

  /** Config as served to the settings page: stored secrets replaced by a mask. */
  getPublicConfig(): BackupConfigDto {
    const cfg = this.getConfig();
    if (cfg.encryption?.password) cfg.encryption.password = SECRET_MASK;
    for (const d of cfg.destinations ?? []) {
      if (d.secretKey) d.secretKey = SECRET_MASK;
    }
    return cfg;
  }

  async updateConfig(partial: Partial<BackupConfigDto>): Promise<BackupConfigDto> {
    const incoming = structuredClone(partial);
    // The page only ever sees the mask; sending it back means "unchanged".
    if (incoming.encryption?.password === SECRET_MASK) incoming.encryption.password = this.config.encryption?.password ?? '';
    incoming.destinations?.forEach((d, i) => {
      if (d.secretKey !== SECRET_MASK) return;
      const prev = this.config.destinations[i];
      d.secretKey = prev && prev.type === d.type ? prev.secretKey : undefined;
    });

    const merged = this.deepMerge(structuredClone(BACKUP_DEFAULTS), { ...this.config, ...incoming });
    merged.types = incoming.types ?? this.config.types;
    merged.destinations = incoming.destinations ?? this.config.destinations;
    const problems = this.validateConfig(merged as BackupConfigDto);
    if (problems.length) throw new BadRequestException(problems);

    this.config = merged as BackupConfigDto;
    await this.settingsService.setServerWide(BACKUP_SETTING_KEY, this.config);
    this.reschedule();
    this.healthCache = undefined;
    return this.getPublicConfig();
  }

  /** Rejects configs that would silently stop backups or crash the scheduler on boot. */
  private validateConfig(cfg: BackupConfigDto): string[] {
    const problems: string[] = [];
    if (!cfg.types?.includes(BackupType.Full)) problems.push('Full (database) backups cannot be turned off');
    if (!this.primaryDestination(cfg)) problems.push('At least one enabled "Local Folder" destination with a path is required');
    for (const d of cfg.destinations ?? []) {
      if (d.enabled !== false && FOLDER_DESTINATIONS.has(d.type) && !d.path?.trim()) problems.push(`Destination "${d.label || d.type}" has no folder path`);
    }
    if (cfg.frequency === BackupFrequency.CustomMinutes && !(cfg.customIntervalMinutes! >= 1 && cfg.customIntervalMinutes! <= 59)) {
      problems.push('"Every X minutes" must be between 1 and 59');
    }
    if (cfg.frequency === BackupFrequency.CustomHours && !(cfg.customIntervalMinutes! >= 1 && cfg.customIntervalMinutes! <= 23)) {
      problems.push('"Every X hours" must be between 1 and 23');
    }
    try {
      for (const t of this.resolveCronExpressions(cfg)) new CronJob(t.expr, () => undefined);
      if (cfg.frequency === BackupFrequency.Cron && !cfg.customCronExpression?.trim()) problems.push('Cron expression is empty');
    } catch (err) {
      problems.push(`Invalid schedule: ${this.errText(err)}`);
    }
    if (cfg.namingFormat && !(cfg.namingFormat.includes('{DATE}') && cfg.namingFormat.includes('{TIME}'))) {
      problems.push('Backup naming must contain {DATE} and {TIME}, or backups overwrite each other');
    }
    if (cfg.encryption?.type === EncryptionType.AES256 && !cfg.encryption.password && !process.env.BACKUP_ENCRYPTION_PASSWORD) {
      problems.push('AES-256 encryption needs a password');
    }
    return problems;
  }

  // ==========================================================================
  // Dynamic cron scheduling
  // ==========================================================================

  private schedulerEnabled(): boolean {
    return process.env.BACKUP_CRON_ENABLED !== 'false';
  }

  private clearCronJobs(): void {
    for (const name of this.cronJobNames) {
      try { this.schedulerRegistry.deleteCronJob(name); } catch { /* already gone */ }
    }
    this.cronJobNames = [];
  }

  private addJob(name: string, cronExpr: string, fn: () => Promise<unknown>): void {
    try {
      const job = new CronJob(cronExpr, () => {
        fn().catch((err) => this.logger.error(`Scheduled ${name} crashed: ${this.errText(err)}`));
      });
      this.schedulerRegistry.addCronJob(name, job);
      job.start();
      this.cronJobNames.push(name);
    } catch (err) {
      // A bad persisted schedule must never take the API down at boot.
      this.scheduleError = `Backup schedule "${cronExpr}" is invalid: ${this.errText(err)}`;
      this.logger.error(this.scheduleError);
    }
  }

  reschedule(): void {
    this.clearCronJobs();
    this.scheduleError = undefined;
    if (!this.schedulerEnabled()) {
      this.logger.warn('BACKUP_CRON_ENABLED=false - automatic backups are OFF on this server');
      return;
    }
    if (this.config.frequency === BackupFrequency.Manual) {
      this.logger.log('Manual backup mode - no cron scheduled');
      return;
    }
    let times: { name: string; expr: string }[];
    try {
      times = this.resolveCronExpressions(this.config);
    } catch (err) {
      this.scheduleError = `Backup schedule is invalid: ${this.errText(err)}`;
      this.logger.error(this.scheduleError);
      return;
    }
    for (const t of times) {
      this.addJob(`backup-full-${t.name}`, t.expr, () => this.runScheduledFull());
      if (this.config.types.includes(BackupType.Incremental)) {
        this.addJob(`backup-inc-${t.name}`, t.expr, () => this.runIncrementalBackup());
      }
      if (this.config.includes?.uploadedImages || this.config.includes?.productImages) {
        this.addJob(`backup-files-${t.name}`, t.expr, () => this.runFilesBackup());
      }
      if (this.config.includes?.envFile || this.config.includes?.configFiles) {
        this.addJob(`backup-config-${t.name}`, t.expr, () => this.runConfigBackup());
      }
    }
    if (this.config.cleanup?.deleteExpired) {
      this.addJob('backup-cleanup', '0 5 * * *', () => this.cleanup());
    }
  }

  private resolveCronExpressions(cfg: BackupConfigDto): { name: string; expr: string }[] {
    const hhmm = (t: string) => {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t ?? '');
      if (!m) throw new Error(`"${t}" is not a HH:MM time`);
      return { h: Number(m[1]), m: Number(m[2]) };
    };
    switch (cfg.frequency) {
      case BackupFrequency.EveryHour:
        return [{ name: 'hourly', expr: '0 * * * *' }];
      case BackupFrequency.Every2Hours:
        return [{ name: '2h', expr: '0 */2 * * *' }];
      case BackupFrequency.Every4Hours:
        return [{ name: '4h', expr: '0 */4 * * *' }];
      case BackupFrequency.Every6Hours:
        return [{ name: '6h', expr: '0 */6 * * *' }];
      case BackupFrequency.Every12Hours:
        return [{ name: '12h', expr: '0 */12 * * *' }];
      case BackupFrequency.Daily:
        return (cfg.dailyConfig?.times?.length ? cfg.dailyConfig.times : ['02:00']).map((t, i) => {
          const { h, m } = hhmm(t);
          return { name: `daily-${i}-${h}${m}`, expr: `${m} ${h} * * *` };
        });
      case BackupFrequency.Weekly: {
        const { h, m } = hhmm(cfg.weeklyConfig?.time ?? '03:00');
        return (cfg.weeklyConfig?.days?.length ? cfg.weeklyConfig.days : [0]).map((d) => ({ name: `weekly-${d}`, expr: `${m} ${h} * * ${d}` }));
      }
      case BackupFrequency.Monthly:
        return [{ name: 'monthly', expr: '0 2 1 * *' }];
      case BackupFrequency.CustomMinutes:
        return [{ name: `every-${cfg.customIntervalMinutes}m`, expr: `*/${cfg.customIntervalMinutes} * * * *` }];
      case BackupFrequency.CustomHours:
        return [{ name: `every-${cfg.customIntervalMinutes}h`, expr: `0 */${cfg.customIntervalMinutes} * * *` }];
      case BackupFrequency.Cron:
        return cfg.customCronExpression?.trim() ? [{ name: 'custom', expr: cfg.customCronExpression.trim() }] : [];
      default:
        return [];
    }
  }

  /** Hours between two scheduled full backups (Infinity when manual). */
  private expectedIntervalHours(): number {
    switch (this.config.frequency) {
      case BackupFrequency.EveryHour: return 1;
      case BackupFrequency.Every2Hours: return 2;
      case BackupFrequency.Every4Hours: return 4;
      case BackupFrequency.Every6Hours: return 6;
      case BackupFrequency.Every12Hours: return 12;
      case BackupFrequency.Weekly: return 24 * 7;
      case BackupFrequency.Monthly: return 24 * 31;
      case BackupFrequency.CustomMinutes: return Math.max(1, this.config.customIntervalMinutes ?? 60) / 60;
      case BackupFrequency.CustomHours: return Math.max(1, this.config.customIntervalMinutes ?? 1);
      case BackupFrequency.Manual: return Infinity;
      default: return 24;
    }
  }

  /** Scheduled path: retries, then proves the new dump restores. */
  async runScheduledFull(): Promise<BackupRunResult> {
    const attempts = 1 + Math.max(0, this.config.advanced?.retryCount ?? 0);
    const delayMs = Math.max(0, this.config.advanced?.retryDelayMinutes ?? 5) * 60_000;
    let result!: BackupRunResult;
    for (let i = 1; i <= attempts; i++) {
      result = await this.runFullBackup({ notify: i === attempts });
      if (result.status !== 'failed') break;
      if (i < attempts) {
        this.logger.warn(`Full backup attempt ${i}/${attempts} failed; retrying in ${delayMs / 60_000} min`);
        await new Promise((r) => setTimeout(r, delayMs).unref?.());
      }
    }
    if (result.status === 'success' && this.config.verification?.testRestore) {
      await this.runRestoreTest(result.target);
    }
    return result;
  }

  /** The server PC may be off at the scheduled time: back up soon after it starts instead. */
  private scheduleCatchUp(): void {
    if (!this.schedulerEnabled() || this.config.frequency === BackupFrequency.Manual) return;
    this.catchUpTimer = setTimeout(() => {
      const last = this.lastSuccessful('full');
      const ageHours = last ? (Date.now() - new Date(last.finishedAt).getTime()) / 3_600_000 : Infinity;
      if (ageHours <= this.expectedIntervalHours() + 1) return;
      this.logger.warn(`Last successful full backup is ${Number.isFinite(ageHours) ? `${ageHours.toFixed(1)}h old` : 'missing'} - running a catch-up backup`);
      this.runScheduledFull().catch((err) => this.logger.error(`Catch-up backup crashed: ${this.errText(err)}`));
    }, CATCH_UP_DELAY_MS);
    this.catchUpTimer.unref?.();
  }

  // ==========================================================================
  // Layer 1 — Full database backup
  // ==========================================================================

  async runFullBackup(options: { notify?: boolean } = {}): Promise<BackupRunResult> {
    if (this.busy.has('full')) return this.skipped('full', 'already running');
    this.busy.add('full');
    const started = Date.now();
    const dir = path.join(this.primaryDir(), 'full');
    const baseName = this.buildFileName('FULL');
    const password = this.encryptionPassword();
    const finalPath = path.join(dir, password ? `${baseName}${ENCRYPTED_SUFFIX}` : baseName);
    const tmpDump = path.join(dir, `${baseName}${PARTIAL_SUFFIX}`);
    const tmpEnc = `${finalPath}${PARTIAL_SUFFIX}`;
    let database: string | undefined;
    try {
      const pg = this.pgConnection();
      database = pg.database;
      await fs.mkdir(dir, { recursive: true });
      await this.assertDiskSpace(dir);

      const compress = this.config.advanced?.compressionLevel ?? 6;
      await this.execPg('pg_dump', [
        '--format=custom', `--compress=${compress}`, '--no-owner', '--no-password',
        '--lock-wait-timeout=300000', `--file=${tmpDump}`, `--dbname=${pg.database}`,
      ], pg.env, this.timeoutMs());

      // Always read the archive back: a dump whose TOC cannot be listed is not a backup.
      const toc = await this.tocEntries(tmpDump, pg.env);
      if (toc === 0) throw new Error('pg_dump produced an archive with no entries');

      if (password) {
        await encryptFile(tmpDump, tmpEnc, password);
        await fs.rm(tmpDump, { force: true });
        await fs.rename(tmpEnc, finalPath);
      } else {
        await fs.rename(tmpDump, finalPath);
      }
      const { size } = await fs.stat(finalPath);
      const checksumSha256 = await this.sha256(finalPath);
      await this.writeChecksum(finalPath, checksumSha256);
      const copies = await this.copyToDestinations(finalPath, 'full', checksumSha256);
      const warnings = copies.filter((c) => !c.ok).map((c) => `Copy to ${c.destination} failed: ${c.error}`);
      return await this.record({
        kind: 'full', status: 'success', target: finalPath, sizeBytes: size,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        checksumSha256, encrypted: !!password, database, copies,
        warnings: warnings.length ? warnings : undefined,
      }, options.notify ?? true);
    } catch (err) {
      for (const f of [tmpDump, tmpEnc, finalPath, `${finalPath}${CHECKSUM_SUFFIX}`]) await fs.rm(f, { force: true }).catch(() => {});
      return await this.record({
        kind: 'full', status: 'failed', target: finalPath, database,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      }, options.notify ?? true);
    } finally {
      this.busy.delete('full');
    }
  }

  // ==========================================================================
  // Layer 2 — Incremental (WAL). Needs archive_mode=on on the PostgreSQL server.
  // ==========================================================================

  async runIncrementalBackup(): Promise<BackupRunResult> {
    if (this.busy.has('incremental')) return this.skipped('incremental', 'already running');
    this.busy.add('incremental');
    const started = Date.now();
    const dir = path.join(this.primaryDir(), 'incremental');
    const file = path.join(dir, this.buildFileName('INCREMENTAL'));
    try {
      const wal = await this.getWalArchiveStatus();
      if (wal.error) throw new Error(wal.error);
      if (wal.archiveMode === 'off') {
        return await this.record({
          kind: 'incremental', status: 'skipped', durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
          error: 'WAL archiving is off on the PostgreSQL server (archive_mode=off). Incremental backups need archive_mode and archive_command configured - see docs/backup-recovery.md.',
        });
      }
      await fs.mkdir(dir, { recursive: true });
      const lsn = await this.psql('SELECT pg_walfile_name(pg_switch_wal())');
      await fs.writeFile(file, `WAL segment switched at ${new Date().toISOString()}\nclosed segment: ${lsn}\nlast archived: ${wal.lastArchivedWal ?? '-'}\n`, 'utf8');
      return await this.record({
        kind: 'incremental', status: 'success', target: file,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        warnings: wal.failedCount > 0 ? [`WAL archiver has ${wal.failedCount} failures (last failed: ${wal.lastFailedWal ?? '?'})`] : undefined,
      });
    } catch (err) {
      return await this.record({
        kind: 'incremental', status: 'failed',
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('incremental');
    }
  }

  private async getWalArchiveStatus(): Promise<WalArchiveStatus> {
    try {
      const out = await this.psql(
        "SELECT current_setting('archive_mode'), failed_count, coalesce(last_archived_wal, ''), coalesce(last_failed_wal, '') FROM pg_stat_archiver",
      );
      const [archiveMode, failed, lastArchived, lastFailed] = out.split('|');
      return { archiveMode, failedCount: Number(failed) || 0, lastArchivedWal: lastArchived || undefined, lastFailedWal: lastFailed || undefined };
    } catch (err) {
      return { archiveMode: 'unknown', failedCount: 0, error: this.errText(err) };
    }
  }

  // ==========================================================================
  // Layer 3 — Uploaded files (mirror; deleted files are kept in the backup)
  // ==========================================================================

  async runFilesBackup(): Promise<BackupRunResult> {
    if (this.busy.has('files')) return this.skipped('files', 'already running');
    this.busy.add('files');
    const started = Date.now();
    const primaryTarget = path.join(this.primaryDir(), 'files', 'uploads');
    try {
      const src = this.uploadsDir();
      if (!src) {
        return await this.record({
          kind: 'files', status: 'skipped', durationMs: 0, finishedAt: new Date().toISOString(),
          error: `uploads are not stored on this server (STORAGE_DRIVER=${process.env.STORAGE_DRIVER})`,
        });
      }
      if (!(await this.exists(src))) {
        return await this.record({
          kind: 'files', status: 'success', target: primaryTarget,
          durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
          warnings: [`No uploads folder at ${src} yet - nothing to copy`],
        });
      }
      await this.mirrorFolder(src, primaryTarget);
      const copies: BackupCopyResult[] = [];
      for (const dest of this.secondaryDestinations().filter((d) => FOLDER_DESTINATIONS.has(d.type))) {
        const target = path.join(dest.path, 'files', 'uploads');
        try {
          await this.mirrorFolder(src, target);
          copies.push({ destination: this.destLabel(dest), ok: true, target });
        } catch (err) {
          copies.push({ destination: this.destLabel(dest), ok: false, error: this.errText(err) });
        }
      }
      const warnings = copies.filter((c) => !c.ok).map((c) => `Copy to ${c.destination} failed: ${c.error}`);
      return await this.record({
        kind: 'files', status: 'success', target: primaryTarget, copies,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (err) {
      return await this.record({
        kind: 'files', status: 'failed', target: primaryTarget,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('files');
    }
  }

  private uploadsDir(): string | null {
    if ((process.env.STORAGE_DRIVER ?? 'local') !== 'local') return null;
    // Same resolution as FilesService, so the backup copies the folder the API serves.
    return path.resolve(process.env.STORAGE_LOCAL_DIR ?? './var/uploads');
  }

  private async mirrorFolder(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    if (process.platform === 'win32') {
      const log = path.join(this.primaryDir(), 'logs', 'robocopy.log');
      await fs.mkdir(path.dirname(log), { recursive: true });
      try {
        // No /PURGE or /MIR: files deleted from the live folder stay in the backup.
        await execFileAsync('robocopy', [src, dest, '/E', '/COPY:DAT', '/R:2', '/W:5', '/NP', '/NDL', '/NFL', `/LOG+:${log}`], { windowsHide: true });
      } catch (e: any) {
        // robocopy exit codes 0-7 are success variants; 8+ means something failed.
        if (!(typeof e.code === 'number' && e.code < 8)) throw new Error(`robocopy exit ${e.code} (see ${log})`);
      }
    } else {
      await fs.cp(src, dest, { recursive: true, force: true, preserveTimestamps: true });
    }
  }

  // ==========================================================================
  // Layer 4 — Server configuration (.env)
  // ==========================================================================

  async runConfigBackup(): Promise<BackupRunResult> {
    if (this.busy.has('config')) return this.skipped('config', 'already running');
    this.busy.add('config');
    const started = Date.now();
    const dir = path.join(this.primaryDir(), 'config');
    const baseName = this.buildFileName('CONFIG');
    const password = this.encryptionPassword();
    const file = path.join(dir, password ? `${baseName}${ENCRYPTED_SUFFIX}` : baseName);
    const tmp = path.join(dir, `${baseName}${PARTIAL_SUFFIX}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      const sections: string[] = [`# POS-CAFE server configuration, captured ${new Date().toISOString()} from ${process.cwd()}`];
      for (const p of this.envFileCandidates()) {
        try {
          const content = await fs.readFile(p, 'utf8');
          // The encryption key must never sit next to the files it protects.
          sections.push(`=== ${p} ===\n${content.replace(/^(\s*BACKUP_ENCRYPTION_PASSWORD\s*=).*$/gm, '$1"<redacted - stored separately from backups>"')}`);
        } catch { /* not present on this install */ }
      }
      if (sections.length === 1) throw new Error(`no .env file found (looked in ${this.envFileCandidates().join(', ')})`);
      await fs.writeFile(tmp, sections.join('\n\n'), 'utf8');
      if (password) {
        await encryptFile(tmp, `${file}${PARTIAL_SUFFIX}`, password);
        await fs.rm(tmp, { force: true });
        await fs.rename(`${file}${PARTIAL_SUFFIX}`, file);
      } else {
        await fs.rename(tmp, file);
      }
      const checksum = await this.sha256(file);
      await this.writeChecksum(file, checksum);
      const copies = await this.copyToDestinations(file, 'config', checksum);
      const warnings = copies.filter((c) => !c.ok).map((c) => `Copy to ${c.destination} failed: ${c.error}`);
      if (!password) warnings.push('Config backup holds server secrets in plain text - set BACKUP_ENCRYPTION_PASSWORD');
      return await this.record({
        kind: 'config', status: 'success', target: file, encrypted: !!password, checksumSha256: checksum, copies,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (err) {
      for (const f of [tmp, `${file}${PARTIAL_SUFFIX}`]) await fs.rm(f, { force: true }).catch(() => {});
      return await this.record({
        kind: 'config', status: 'failed',
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('config');
    }
  }

  private envFileCandidates(): string[] {
    const cwd = process.cwd();
    const list = [path.join(cwd, '.env'), path.join(cwd, 'apps', 'api', '.env')];
    if (path.basename(cwd) === 'api' && path.basename(path.dirname(cwd)) === 'apps') list.push(path.join(cwd, '..', '..', '.env'));
    return [...new Set(list.map((p) => path.resolve(p)))];
  }

  // ==========================================================================
  // RESTORE — always into a NEW database. The live database is never touched
  // from inside the running API; switching over is an operator step with the
  // API stopped (docs/backup-recovery.md, scripts/restore-backup.cjs).
  // ==========================================================================

  async restore(dto: RestoreRequest): Promise<RestoreResult> {
    const started = Date.now();
    const fail = (message: string, err?: unknown): RestoreResult => ({
      success: false, message, durationMs: Date.now() - started, error: err ? this.errText(err) : undefined,
    });
    if (!dto.backupFile?.trim()) return fail('Backup file path is required');
    if (dto.scope && dto.scope !== RestoreScope.Database) {
      return fail(`Restoring "${dto.scope}" is a manual step - see docs/backup-recovery.md`);
    }

    let file: string;
    let pg: PgConnection;
    try {
      file = await this.resolveBackupFile(dto.backupFile);
      pg = this.pgConnection();
    } catch (err) {
      return fail(this.errText(err), err);
    }

    let prepared: { dumpPath: string; cleanup: () => Promise<void> } | undefined;
    let created: string | undefined;
    try {
      const checksum = await this.verifyChecksum(file);
      prepared = await this.prepareDump(file);
      const tocEntries = await this.tocEntries(prepared.dumpPath, pg.env);
      if (tocEntries === 0) throw new Error('backup archive has no entries');

      if (dto.verifyOnly) {
        return {
          success: true, durationMs: Date.now() - started, checks: { tocEntries, checksum },
          message: `Backup is readable: ${tocEntries} archive entries, checksum ${checksum === 'verified' ? 'verified' : 'not available (no .sha256 file)'}`,
        };
      }

      const target = dto.targetDatabase?.trim() || this.scratchDbName(pg.database, 'restored');
      if (!/^[A-Za-z0-9_]{1,63}$/.test(target)) throw new Error('targetDatabase may only contain letters, digits and _ (max 63)');
      if (target.toLowerCase() === pg.database.toLowerCase()) {
        throw new Error(`Refusing to restore over the live database "${pg.database}". Restore into a new database, then switch over with the API stopped (docs/backup-recovery.md).`);
      }
      if (await this.databaseExists(target)) throw new Error(`Database "${target}" already exists - choose a new name`);

      this.logger.warn(`Restoring ${path.basename(file)} into NEW database "${target}"`);
      await this.execPg('createdb', ['--no-password', '--template=template0', target], pg.env);
      created = target;
      await this.execPg('pg_restore', ['--no-owner', '--no-password', '--exit-on-error', `--dbname=${target}`, prepared.dumpPath], pg.env, this.timeoutMs(2));

      const checks: RestoreChecks = { tocEntries, checksum, ...(await this.compareWithLive(target)) };
      const problems = this.checkProblems(checks);
      if (problems.length) throw new Error(`restored database looks incomplete: ${problems.join('; ')}`);
      created = undefined; // keep it: the caller asked for this database
      this.logger.log(`Restore completed: ${path.basename(file)} -> ${target}`);
      return {
        success: true, database: target, checks, durationMs: Date.now() - started,
        message: `Restored into new database "${target}". The live database "${pg.database}" was not changed. To run the café on it, stop the API and follow docs/backup-recovery.md.`,
      };
    } catch (err) {
      return fail(`Restore failed: ${this.errText(err)}`, err);
    } finally {
      if (created) await this.dropDatabase(created);
      await prepared?.cleanup();
    }
  }

  /** Restores a backup into a throwaway database, checks it, drops it. */
  async runRestoreTest(backupFile?: string): Promise<BackupRunResult> {
    if (this.busy.has('restore_test')) return this.skipped('restore_test', 'already running');
    this.busy.add('restore_test');
    const started = Date.now();
    let target: string | undefined;
    let file = backupFile;
    try {
      const pg = this.pgConnection();
      if (!file) {
        const latest = (await this.listBackups('full'))[0];
        if (!latest) throw new Error('No full backup available to test');
        file = latest.file;
      }
      await this.dropLeftoverScratchDbs(pg.database);
      target = this.scratchDbName(pg.database, 'restoretest');
      const r = await this.restore({ scope: RestoreScope.Database, backupFile: file, targetDatabase: target });
      if (!r.success) throw new Error(r.error ?? r.message);
      const c = r.checks!;
      return await this.record({
        kind: 'restore_test', status: 'success', target: file, database: target,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        warnings: [`${c.tocEntries} entries, ${c.tables?.restored ?? '?'} tables, ${c.migrations?.restored ?? '?'} migrations, ${c.organizations?.restored ?? '?'} organizations restored`],
      });
    } catch (err) {
      return await this.record({
        kind: 'restore_test', status: 'failed', target: file, database: target,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      if (target) await this.dropDatabase(target);
      this.busy.delete('restore_test');
    }
  }

  /** Accepts a file name or path, but only for backups inside a configured backup folder. */
  private async resolveBackupFile(input: string): Promise<string> {
    const roots = [this.primaryDir(), ...this.secondaryDestinations().filter((d) => FOLDER_DESTINATIONS.has(d.type)).map((d) => path.resolve(d.path))]
      .map((r) => path.join(r, 'full'));
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.join(roots[0], path.basename(input));
    if (!/\.dump(\.enc)?$/i.test(candidate)) throw new Error('Not a database backup file (.dump or .dump.enc)');
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new Error(`Backup file not found: ${path.basename(candidate)}`);
    }
    for (const root of roots) {
      const realRoot = await fs.realpath(root).catch(() => root);
      const rel = path.relative(realRoot, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
    }
    throw new Error('Backup file must be inside a configured backup folder');
  }

  private async verifyChecksum(file: string): Promise<'verified' | 'no-sidecar'> {
    let expected: string | undefined;
    try {
      expected = (await fs.readFile(`${file}${CHECKSUM_SUFFIX}`, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase();
    } catch {
      return 'no-sidecar';
    }
    const actual = await this.sha256(file);
    if (expected !== actual) throw new Error(`Checksum mismatch for ${path.basename(file)}: file is corrupted or was modified`);
    return 'verified';
  }

  /** Decrypts `.enc` backups to a temporary file next to the backups (never the OS temp dir). */
  private async prepareDump(file: string): Promise<{ dumpPath: string; cleanup: () => Promise<void> }> {
    if (!file.endsWith(ENCRYPTED_SUFFIX)) return { dumpPath: file, cleanup: async () => undefined };
    const tmpDir = path.join(this.primaryDir(), 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const dumpPath = path.join(tmpDir, `${path.basename(file, ENCRYPTED_SUFFIX)}.${crypto.randomBytes(4).toString('hex')}${PARTIAL_SUFFIX}`);
    const cleanup = async () => { await fs.rm(dumpPath, { force: true }).catch(() => {}); };
    const passwords = this.candidatePasswords();
    if (!passwords.length) throw new Error('Backup is encrypted but no password is configured (BACKUP_ENCRYPTION_PASSWORD)');
    let lastErr: unknown;
    for (const pw of passwords) {
      try {
        await decryptFile(file, dumpPath, pw);
        return { dumpPath, cleanup };
      } catch (err) {
        lastErr = err;
        await cleanup();
      }
    }
    throw lastErr;
  }

  private async compareWithLive(target: string): Promise<Omit<RestoreChecks, 'tocEntries' | 'checksum'>> {
    const sql = `SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'),
      (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
      (SELECT count(*) FROM "Organization")`;
    const parse = (s: string) => s.split('|').map((n) => Number(n));
    const [rt, rm, ro] = parse(await this.psql(sql, target));
    const [lt, lm, lo] = parse(await this.psql(sql));
    return {
      tables: { restored: rt, live: lt },
      migrations: { restored: rm, live: lm },
      organizations: { restored: ro, live: lo },
    };
  }

  private checkProblems(c: RestoreChecks): string[] {
    const p: string[] = [];
    // Table counts are only comparable at the same schema version: an older
    // backup legitimately predates tables added by later migrations.
    const sameSchema = c.migrations && c.migrations.restored === c.migrations.live;
    if (sameSchema && c.tables && c.tables.restored < c.tables.live) p.push(`${c.tables.restored} tables restored, live has ${c.tables.live}`);
    if (c.migrations && c.migrations.restored === 0) p.push('no applied migrations in the restored database');
    if (c.organizations && c.organizations.live > 0 && c.organizations.restored === 0) p.push('no organizations in the restored database');
    return p;
  }

  private scratchDbName(live: string, purpose: 'restoretest' | 'restored'): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const suffix = `_${purpose}_${stamp}`;
    const prefix = live.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63 - suffix.length);
    return `${prefix}${suffix}`;
  }

  private async dropLeftoverScratchDbs(live: string): Promise<void> {
    const prefix = live.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63 - '_restoretest_00000000000000'.length);
    try {
      const out = await this.psql(`SELECT datname FROM pg_database WHERE datname ~ '^${prefix}_restoretest_[0-9]{14}$'`);
      for (const name of out.split('\n').map((s) => s.trim()).filter(Boolean)) await this.dropDatabase(name);
    } catch (err) {
      this.logger.warn(`Could not sweep leftover restore-test databases: ${this.errText(err)}`);
    }
  }

  private async databaseExists(name: string): Promise<boolean> {
    // `name` is validated as [A-Za-z0-9_] before it gets here.
    return (await this.psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`)) === '1';
  }

  private async dropDatabase(name: string): Promise<void> {
    try {
      const pg = this.pgConnection();
      if (name.toLowerCase() === pg.database.toLowerCase()) throw new Error('refusing to drop the live database');
      await this.execPg('dropdb', ['--no-password', '--if-exists', name], pg.env);
    } catch (err) {
      this.logger.error(`Could not drop scratch database "${name}": ${this.errText(err)}`);
    }
  }

  async listBackups(kind?: BackupKind): Promise<BackupListItem[]> {
    const kinds = kind ? [kind] : [...ARTIFACT_KINDS];
    const results: BackupListItem[] = [];
    for (const sub of kinds) {
      if (!(ARTIFACT_KINDS as readonly string[]).includes(sub)) continue;
      for (const item of await this.listArtifacts(path.join(this.primaryDir(), sub))) {
        results.push({ file: item.path, name: path.basename(item.path), size: item.size, mtime: new Date(item.mtime), kind: sub, encrypted: item.path.endsWith(ENCRYPTED_SUFFIX) });
      }
    }
    return results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  // ==========================================================================
  // Retention — prune old artifacts in every folder destination
  // ==========================================================================

  async cleanup(): Promise<{ deleted: number; errors: string[] }> {
    const r = this.config.retention ?? BACKUP_DEFAULTS.retention;
    const roots = [this.primaryDir(), ...this.secondaryDestinations().filter((d) => FOLDER_DESTINATIONS.has(d.type)).map((d) => path.resolve(d.path))];
    let deleted = 0;
    const errors: string[] = [];
    const remove = async (p: string) => {
      try {
        await fs.rm(p, { force: true });
        await fs.rm(`${p}${CHECKSUM_SUFFIX}`, { force: true });
        deleted++;
      } catch (err) {
        errors.push(`${p}: ${this.errText(err)}`);
      }
    };

    for (const root of roots) {
      for (const sub of ARTIFACT_KINDS) {
        const dir = path.join(root, sub);
        const items = await this.listArtifacts(dir);
        const keep = sub === 'config'
          ? new Set(items.slice(0, 50).map((i) => i.path))
          : this.retentionKeepSet(items, r);
        // Never prune below a floor - a run of failed nights must not age out the last good backups.
        for (const i of items.slice(0, MIN_BACKUPS_KEPT)) keep.add(i.path);
        for (const item of items) if (!keep.has(item.path)) await remove(item.path);

        if (this.config.cleanup?.deleteTempFiles !== false) await this.removeStalePartials(dir);
      }
    }
    if (this.config.cleanup?.deleteTempFiles !== false) await this.removeStalePartials(path.join(this.primaryDir(), 'tmp'));
    if (deleted || errors.length) this.logger.log(`Backup retention: removed ${deleted} old artifact(s)${errors.length ? `, ${errors.length} error(s)` : ''}`);
    return { deleted, errors };
  }

  private retentionKeepSet(items: { path: string; mtime: number }[], r: NonNullable<BackupConfigDto['retention']>): Set<string> {
    if (r.mode === RetentionMode.KeepByAge) {
      const cutoff = Date.now() - (r.keepDays ?? 30) * 86_400_000;
      return new Set(items.filter((i) => i.mtime >= cutoff).map((i) => i.path));
    }
    if (r.mode === RetentionMode.Smart) {
      // Grandfather-father-son: newest backup of each of the last N days, weeks and months.
      const keep = new Set<string>();
      const take = (bucket: (d: Date) => string, count: number) => {
        const seen = new Set<string>();
        for (const i of items) {
          const k = bucket(new Date(i.mtime));
          if (seen.has(k)) continue;
          if (seen.size >= count) break;
          seen.add(k);
          keep.add(i.path);
        }
      };
      take((d) => d.toDateString(), r.smartDaily ?? 14);
      take((d) => String(Math.floor((d.getTime() / 86_400_000 + 3) / 7)), r.smartWeekly ?? 8);
      take((d) => `${d.getFullYear()}-${d.getMonth()}`, r.smartMonthly ?? 12);
      return keep;
    }
    return new Set(items.slice(0, r.keepLastCount ?? 14).map((i) => i.path));
  }

  private async removeStalePartials(dir: string): Promise<void> {
    try {
      for (const n of await fs.readdir(dir)) {
        if (!n.endsWith(PARTIAL_SUFFIX)) continue;
        const p = path.join(dir, n);
        const st = await fs.stat(p);
        if (Date.now() - st.mtimeMs > 6 * 3_600_000) await fs.rm(p, { force: true });
      }
    } catch { /* folder may not exist */ }
  }

  // ==========================================================================
  // Status & health
  // ==========================================================================

  getStatus() {
    const lastByKind: Partial<Record<BackupKind, BackupRunResult>> = {};
    for (const r of this.history) {
      if (r.status === 'skipped' && r.kind !== 'incremental') continue;
      if (!lastByKind[r.kind]) lastByKind[r.kind] = r;
    }
    const envPassword = !!process.env.BACKUP_ENCRYPTION_PASSWORD;
    return {
      lastByKind,
      recent: this.history.slice(0, 20),
      config: this.getPublicConfig(),
      server: {
        primaryDir: this.primaryDir(),
        schedulerEnabled: this.schedulerEnabled(),
        encryptionActive: !!this.encryptionPassword(),
        encryptionEnforcedByEnv: envPassword,
        scheduleError: this.scheduleError,
      },
    };
  }

  async getHealthStatus(): Promise<BackupHealth> {
    if (this.healthCache && Date.now() - this.healthCache.at < HEALTH_CACHE_MS) return this.healthCache.value;
    const critical: string[] = [];
    const degraded: string[] = [];

    const lastFull = this.history.find((r) => r.kind === 'full' && r.status !== 'skipped');
    const lastGoodFull = this.lastSuccessful('full');
    const interval = this.expectedIntervalHours();
    if (!lastGoodFull) {
      critical.push('No full backup found');
    } else {
      const ageHours = (Date.now() - new Date(lastGoodFull.finishedAt).getTime()) / 3_600_000;
      const staleAfter = Number.isFinite(interval) ? interval + Math.max(12, interval / 2) : 24 * 7;
      if (ageHours > staleAfter) critical.push(`Last successful full backup was ${ageHours.toFixed(1)}h ago (expected every ${Number.isFinite(interval) ? `${interval}h` : 'manual run'})`);
    }
    if (lastFull?.status === 'failed') critical.push(`Last full backup FAILED: ${lastFull.error ?? 'unknown error'}`);
    for (const w of lastFull?.status === 'success' ? lastFull.warnings ?? [] : []) degraded.push(w);

    const lastRestoreTest = this.history.find((r) => r.kind === 'restore_test' && r.status !== 'skipped');
    if (lastRestoreTest?.status === 'failed') critical.push(`Last restore test FAILED: ${lastRestoreTest.error ?? 'unknown error'}`);
    if (this.config.verification?.testRestore && lastGoodFull) {
      const lastOkTest = this.lastSuccessful('restore_test');
      if (!lastOkTest || Date.now() - new Date(lastOkTest.finishedAt).getTime() > 8 * 86_400_000) degraded.push('No successful restore test in the last 8 days');
    }

    if (this.scheduleError) critical.push(this.scheduleError);
    if (!this.schedulerEnabled()) degraded.push('Automatic backups are off on this server (BACKUP_CRON_ENABLED=false)');
    else if (this.config.frequency === BackupFrequency.Manual) degraded.push('Backups are manual only - nothing runs automatically');
    if (!this.encryptionPassword()) degraded.push('Backups are not encrypted (set BACKUP_ENCRYPTION_PASSWORD)');
    if (!this.secondaryDestinations().length) degraded.push('No second backup destination (USB drive, NAS or cloud): a disk failure or theft loses the data and the backups together');
    for (const w of this.warnedOnce) degraded.push(w);

    let walArchiveStatus: WalArchiveStatus | undefined;
    if (this.config.types.includes(BackupType.Incremental)) {
      walArchiveStatus = await this.getWalArchiveStatus();
      if (walArchiveStatus.archiveMode === 'off') degraded.push('Incremental backups are selected but WAL archiving is off on the PostgreSQL server');
      if (walArchiveStatus.failedCount > 0) degraded.push(`WAL archiver has ${walArchiveStatus.failedCount} failures`);
    }

    const diskSpace = await this.checkDiskSpace(this.primaryDir());
    if (!diskSpace.hasSpace) degraded.push(`Low disk space for backups: ${(diskSpace.freeBytes / GB).toFixed(2)} GB free`);

    const value: BackupHealth = {
      status: critical.length ? 'critical' : degraded.length ? 'degraded' : 'healthy',
      lastFullBackup: lastFull,
      lastIncrementalBackup: this.history.find((r) => r.kind === 'incremental'),
      lastRestoreTest,
      walArchiveStatus,
      diskSpace,
      issues: [...critical, ...degraded],
      checkedAt: new Date().toISOString(),
    };
    this.healthCache = { at: Date.now(), value };
    return value;
  }

  private lastSuccessful(kind: BackupKind): BackupRunResult | undefined {
    return this.history.find((r) => r.kind === kind && r.status === 'success');
  }

  // ==========================================================================
  // Destinations
  // ==========================================================================

  private primaryDestination(cfg: BackupConfigDto = this.config): BackupDestinationDto | undefined {
    return cfg.destinations?.find((d) => d.enabled !== false && d.type === DestinationType.Local && d.path?.trim());
  }

  private primaryDir(): string {
    return path.resolve(this.primaryDestination()?.path ?? BACKUP_DEFAULTS.destinations[0].path);
  }

  private secondaryDestinations(): BackupDestinationDto[] {
    const primary = this.primaryDestination();
    return (this.config.destinations ?? []).filter((d) => d !== primary && d.enabled !== false && (d.path?.trim() || !FOLDER_DESTINATIONS.has(d.type)));
  }

  private destLabel(d: BackupDestinationDto): string {
    return d.label?.trim() || `${d.type} ${d.path}`;
  }

  private async copyToDestinations(sourceFile: string, kind: string, checksum: string): Promise<BackupCopyResult[]> {
    const results: BackupCopyResult[] = [];
    for (const dest of this.secondaryDestinations()) {
      const label = this.destLabel(dest);
      try {
        if (FOLDER_DESTINATIONS.has(dest.type)) {
          const target = await this.copyToFolder(sourceFile, path.join(path.resolve(dest.path), kind), checksum);
          results.push({ destination: label, ok: true, target });
        } else if (this.config.internetBehaviour === InternetBehaviour.LocalOnly) {
          results.push({ destination: label, ok: false, error: 'not uploaded: Internet Behaviour is "Backup Locally Only"' });
        } else {
          await this.uploadToCloud(sourceFile, dest);
          results.push({ destination: label, ok: true });
        }
      } catch (err) {
        this.logger.warn(`Copy to ${label} failed: ${this.errText(err)}`);
        results.push({ destination: label, ok: false, error: this.errText(err) });
      }
    }
    return results;
  }

  /** Copies, re-hashes the copy (catches bad USB sticks / flaky shares), then publishes it. */
  private async copyToFolder(sourceFile: string, dir: string, checksum: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, path.basename(sourceFile));
    const tmp = `${target}${PARTIAL_SUFFIX}`;
    try {
      await fs.copyFile(sourceFile, tmp);
      const copied = await this.sha256(tmp);
      if (copied !== checksum) throw new Error('copy does not match the original (checksum mismatch)');
      await fs.rename(tmp, target);
      await this.writeChecksum(target, checksum);
      return target;
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Cloud uploads shell out to the provider CLI, without a shell, secrets via env. */
  private async uploadToCloud(file: string, dest: BackupDestinationDto): Promise<void> {
    const name = path.basename(file);
    const folder = (dest.path ?? '').replace(/^[\\/]+|[\\/]+$/g, '') || 'POS-CAFE-backups';
    const opts = { windowsHide: true, timeout: this.timeoutMs() || undefined };
    switch (dest.type) {
      case DestinationType.S3:
        await execFileAsync('aws', ['s3', 'cp', file, `s3://${dest.bucket || 'backups'}/${folder}/${name}`, '--only-show-errors'], {
          ...opts, env: { ...process.env, AWS_ACCESS_KEY_ID: dest.accessKey, AWS_SECRET_ACCESS_KEY: dest.secretKey, AWS_DEFAULT_REGION: dest.region || 'us-east-1' },
        });
        return;
      case DestinationType.Azure:
        await execFileAsync('az', ['storage', 'blob', 'upload', '--container-name', dest.bucket || 'backups', '--file', file, '--name', `${folder}/${name}`, '--overwrite', '--only-show-errors'], {
          ...opts, env: { ...process.env, AZURE_STORAGE_ACCOUNT: dest.accessKey, AZURE_STORAGE_KEY: dest.secretKey },
        });
        return;
      case DestinationType.GoogleDrive:
      case DestinationType.Dropbox:
      case DestinationType.OneDrive: {
        // `bucket` names the rclone remote (set up once with `rclone config`).
        const defaults: Record<string, string> = { [DestinationType.GoogleDrive]: 'gdrive', [DestinationType.Dropbox]: 'dropbox', [DestinationType.OneDrive]: 'onedrive' };
        const remote = dest.bucket || defaults[dest.type];
        await execFileAsync('rclone', ['copyto', file, `${remote}:${folder}/${name}`], opts);
        return;
      }
      case DestinationType.SFTP:
        // path = "host:/remote/dir", accessKey = user; key-based auth only (no password prompts in a service).
        await execFileAsync('scp', ['-B', '-o', 'BatchMode=yes', file, `${dest.accessKey ? `${dest.accessKey}@` : ''}${dest.path.replace(/\/+$/, '')}/${name}`], opts);
        return;
      case DestinationType.FTP:
        await execFileAsync('curl', ['--silent', '--show-error', '--fail', '--ftp-create-dirs', '--user', `${dest.accessKey ?? ''}:${dest.secretKey ?? ''}`, '-T', file, `ftp://${dest.path.replace(/^ftp:\/\//, '').replace(/\/+$/, '')}/${name}`], opts);
        return;
      default:
        throw new Error(`Unsupported destination type: ${dest.type}`);
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private buildFileName(type: string): string {
    const fmt = this.config.namingFormat || 'POS-CAFE_{TYPE}_{DATE}_{TIME}';
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    let name = fmt.replace(/{TYPE}/g, type).replace(/{DATE}/g, date).replace(/{TIME}/g, time);
    name = name.replace(/[<>:"/\\|?*]/g, '_');
    return type === 'FULL' ? `${name}.dump` : type === 'CONFIG' ? `${name}.txt` : `${name}.wal.txt`;
  }

  /**
   * Connection for the PostgreSQL client tools. The database is ALWAYS the one
   * in DATABASE_URL — the database the API actually writes to. PGHOST/PGPORT/
   * PGDATABASE are ignored: a stale PGDATABASE (e.g. the frozen legacy DB)
   * would otherwise produce nightly "successful" backups of the wrong data.
   * PGUSER (+PGPASSWORD) may name a different role for the backup tools.
   */
  private pgConnection(): PgConnection {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PGDATABASE;
    delete env.PGSERVICE;
    const url = process.env.DATABASE_URL;
    let database: string;
    if (url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new Error('DATABASE_URL is not a valid postgres:// URL');
      }
      database = decodeURIComponent(u.pathname.replace(/^\//, ''));
      env.PGHOST = u.hostname.replace(/^\[|\]$/g, '') || 'localhost';
      env.PGPORT = u.port || '5432';
      const overrideUser = process.env.PGUSER?.trim();
      if (overrideUser) {
        env.PGUSER = overrideUser;
        env.PGPASSWORD = process.env.PGPASSWORD ?? '';
      } else {
        env.PGUSER = decodeURIComponent(u.username);
        env.PGPASSWORD = decodeURIComponent(u.password);
      }
      const sslmode = u.searchParams.get('sslmode');
      if (sslmode) env.PGSSLMODE = sslmode;
      const pgDb = process.env.PGDATABASE?.trim();
      if (pgDb && pgDb !== database) {
        this.warnOnce(`PGDATABASE="${pgDb}" in .env differs from the DATABASE_URL database "${database}"; backups use "${database}". Remove PGDATABASE from .env.`);
      }
    } else {
      database = process.env.PGDATABASE?.trim() ?? '';
    }
    if (!database) throw new Error('DATABASE_URL is not set - cannot tell which database to back up');
    if (!env.PGPASSWORD) delete env.PGPASSWORD; // let libpq fall back to pgpass.conf
    return { env, database };
  }

  private encryptionPassword(): string {
    if (process.env.BACKUP_ENCRYPTION_PASSWORD) return process.env.BACKUP_ENCRYPTION_PASSWORD;
    if (this.config.encryption?.type === EncryptionType.AES256 && this.config.encryption.password) return this.config.encryption.password;
    return '';
  }

  /** Every password a backup may have been written with (env first, then the settings page). */
  private candidatePasswords(): string[] {
    return [...new Set([process.env.BACKUP_ENCRYPTION_PASSWORD, this.config.encryption?.password].filter((p): p is string => !!p))];
  }

  private timeoutMs(factor = 1): number {
    const minutes = this.config.advanced?.backupTimeoutMinutes ?? 60;
    return minutes > 0 ? minutes * 60_000 * factor : 0;
  }

  private async assertDiskSpace(dir: string): Promise<void> {
    const space = await this.checkDiskSpace(dir);
    const lastSize = this.lastSuccessful('full')?.sizeBytes ?? 0;
    const need = Math.max(GB, lastSize * 2);
    if (space.totalBytes > 0 && space.freeBytes < need) {
      throw new Error(`Insufficient disk space: ${(space.freeBytes / GB).toFixed(2)} GB free, need ${(need / GB).toFixed(2)} GB`);
    }
  }

  private async checkDiskSpace(dir: string): Promise<DiskSpaceInfo> {
    try {
      await fs.mkdir(dir, { recursive: true });
      const s = await fs.statfs(dir);
      const freeBytes = Number(s.bsize) * Number(s.bavail);
      const totalBytes = Number(s.bsize) * Number(s.blocks);
      const need = Math.max(GB, (this.lastSuccessful('full')?.sizeBytes ?? 0) * 2);
      return { freeBytes, totalBytes, usagePercent: totalBytes ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0, hasSpace: freeBytes >= need };
    } catch {
      // Unknown is not "full": never block a backup on a failed probe.
      return { freeBytes: 0, totalBytes: 0, usagePercent: 0, hasSpace: true };
    }
  }

  private async tocEntries(dumpPath: string, env: NodeJS.ProcessEnv): Promise<number> {
    const { stdout } = await this.execPg('pg_restore', ['--list', dumpPath], env);
    return stdout.split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
  }

  private async sha256(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      createReadStream(file)
        .on('data', (d) => hash.update(d))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
  }

  /** `sha256sum -c` compatible sidecar, so copies can be checked by hand too. */
  private async writeChecksum(file: string, checksum: string): Promise<void> {
    await fs.writeFile(`${file}${CHECKSUM_SUFFIX}`, `${checksum} *${path.basename(file)}\n`, 'utf8');
  }

  private async record(result: BackupRunResult, notify = true): Promise<BackupRunResult> {
    this.history.unshift(result);
    this.history = this.history.slice(0, 200);
    this.healthCache = undefined;

    if (result.status === 'failed') {
      this.logger.error(`${result.kind} backup FAILED: ${result.error}`);
    } else {
      this.logger.log(`${result.kind} backup ${result.status}: ${result.target ?? result.error ?? ''} (${Math.round(result.durationMs / 1000)}s)`);
      for (const w of result.warnings ?? []) this.logger.warn(`${result.kind} backup: ${w}`);
    }

    try {
      const logDir = path.join(this.primaryDir(), 'logs');
      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(path.join(logDir, 'backup-history.jsonl'), JSON.stringify(result) + '\n', 'utf8');
    } catch (err) {
      this.logger.error(`Failed to persist backup history: ${this.errText(err)}`);
    }

    if (notify) await this.notify(result).catch((err) => this.logger.warn(`Backup notification failed: ${this.errText(err)}`));
    return result;
  }

  private async notify(result: BackupRunResult): Promise<void> {
    // Healthchecks.io-style dead-man's switch: success pings keep the check
    // green, /fail turns it red, and silence (server off, API down) alerts too.
    const pingUrl = process.env.BACKUP_HEALTHCHECKS_PING_URL?.replace(/\/+$/, '');
    if (pingUrl && (result.kind === 'full' || result.kind === 'restore_test') && result.status !== 'skipped') {
      const failed = result.status === 'failed';
      if (failed || result.kind === 'full') {
        await fetch(failed ? `${pingUrl}/fail` : pingUrl, {
          method: 'POST', body: failed ? `${result.kind}: ${result.error}` : `full backup ${result.target}`,
          headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(10_000),
        }).catch((err) => this.logger.warn(`Healthcheck ping failed: ${this.errText(err)}`));
      }
    }

    const n = this.config.notifications;
    if (!n) return;
    const event = result.status === 'failed' || result.warnings?.some((w) => /failed/i.test(w))
      ? NotifyOn.Failed
      : result.status === 'skipped' ? NotifyOn.Skipped : NotifyOn.Completed;
    if (!n.on?.includes(event)) return;
    const what = result.status === 'failed' ? 'FAILED' : event === NotifyOn.Failed ? 'needs attention' : event === NotifyOn.Completed ? 'completed' : 'skipped';
    const subject = `POS-CAFE backup ${what}: ${result.kind}`;
    const body = [subject, result.error, ...(result.warnings ?? []), result.target].filter(Boolean).join('\n');
    if (n.channels?.includes(NotifyChannel.Desktop)) this.logger.warn(`BACKUP NOTICE: ${body}`);
    if (n.channels?.includes(NotifyChannel.Email) && n.emailAddress) await this.sendEmail(n.emailAddress, subject, body);
  }

  private async sendEmail(to: string, subject: string, body: string): Promise<void> {
    if (this.mailer === undefined) {
      this.mailer = process.env.SMTP_HOST
        ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
        })
        : null;
    }
    if (!this.mailer) {
      this.logger.warn(`Backup email to ${to} not sent: SMTP_HOST is not configured`);
      return;
    }
    await this.mailer.sendMail({ from: process.env.SMTP_FROM ?? 'no-reply@cafe-pos.local', to, subject, text: body });
  }

  private skipped(kind: BackupKind, reason: string): BackupRunResult {
    this.logger.warn(`${kind} backup skipped: ${reason}`);
    return { kind, status: 'skipped', durationMs: 0, finishedAt: new Date().toISOString(), error: reason };
  }

  private warnOnce(message: string): void {
    if (this.warnedOnce.has(message)) return;
    this.warnedOnce.add(message);
    this.logger.warn(message);
  }

  private execPg(tool: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 0): Promise<{ stdout: string; stderr: string }> {
    const pgBin = process.env.PG_BIN || PG_BIN_DEFAULT;
    const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
    return execFileAsync(pgBin ? path.join(pgBin, exe) : exe, args, {
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutMs || undefined,
      env,
    });
  }

  /** One-value-per-column, one-row-per-line psql query against the live (or given) database. */
  private async psql(sql: string, database?: string): Promise<string> {
    const pg = this.pgConnection();
    const { stdout } = await this.execPg('psql', ['--no-password', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', `--dbname=${database ?? pg.database}`, '-c', sql], pg.env);
    return stdout.trim();
  }

  private async exists(p: string): Promise<boolean> {
    return fs.stat(p).then(() => true, () => false);
  }

  private async ensureDirs(): Promise<void> {
    const base = this.primaryDir();
    try {
      for (const sub of ['full', 'incremental', 'files', 'config', 'logs']) {
        await fs.mkdir(path.join(base, sub), { recursive: true });
      }
    } catch (err) {
      this.logger.error(`Failed to create backup directories under ${base}: ${this.errText(err)}`);
    }
  }

  private async loadHistory(): Promise<void> {
    const historyFile = path.join(this.primaryDir(), 'logs', 'backup-history.jsonl');
    try {
      const lines = (await fs.readFile(historyFile, 'utf8')).trim().split('\n');
      this.history = lines.slice(-200).reverse().flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      });
      if (lines.length > 5000) await fs.writeFile(historyFile, lines.slice(-1000).join('\n') + '\n', 'utf8');
    } catch {
      this.history = [];
    }
  }

  private async listArtifacts(dir: string): Promise<{ path: string; mtime: number; size: number }[]> {
    try {
      const names = (await fs.readdir(dir)).filter((n) => !n.endsWith(CHECKSUM_SUFFIX) && !n.endsWith(PARTIAL_SUFFIX));
      const items = await Promise.all(names.map(async (n) => {
        const p = path.join(dir, n);
        const st = await fs.stat(p);
        return st.isFile() ? [{ path: p, mtime: st.mtimeMs, size: st.size }] : [];
      }));
      return items.flat().sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  private errText(err: unknown): string {
    const e = err as { stderr?: string | Buffer; message?: string; killed?: boolean; signal?: string };
    if (e?.killed && e.signal) return `timed out (killed with ${e.signal})`;
    return e?.stderr?.toString().trim() || e?.message || String(err);
  }

  async onModuleInit(): Promise<void> {
    await this.loadConfig();
    await this.ensureDirs();
    await this.loadHistory();
    this.reschedule();
    this.scheduleCatchUp();
    try {
      this.pgConnection();
    } catch (err) {
      this.logger.error(`Backups cannot run: ${this.errText(err)}`);
    }
  }

  onModuleDestroy(): void {
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.clearCronJobs();
  }
}
