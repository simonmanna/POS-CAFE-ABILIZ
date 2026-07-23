import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { SettingsService } from '../../kernel/settings/settings.service';
import { BACKUP_DEFAULTS, BACKUP_SETTING_KEY, PG_BIN_DEFAULT } from './backup.constants';
import { BackupFrequency, BackupType, CompressionLevel, EncryptionType, InternetBehaviour, RetentionMode } from './backup.dto';
import type { BackupConfigDto, BackupDestinationDto, BackupKind, BackupRunResult } from './backup.dto';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private history: BackupRunResult[] = [];
  private busy = new Set<BackupKind>();
  private config: BackupConfigDto = structuredClone(BACKUP_DEFAULTS) as any;
  private cronJobNames: string[] = [];

  constructor(
    private readonly settingsService: SettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadConfig();
    await this.ensureDirs();
    await this.loadHistory();
    this.reschedule();
  }

  onModuleDestroy(): void {
    this.clearCronJobs();
  }

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
      const setting = await this.settingsService.get(BACKUP_SETTING_KEY);
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

  async updateConfig(partial: Partial<BackupConfigDto>): Promise<BackupConfigDto> {
    const merged = this.deepMerge(structuredClone(BACKUP_DEFAULTS), { ...this.config, ...partial });
    merged.types = partial.types ?? this.config.types;
    merged.destinations = partial.destinations ?? this.config.destinations;
    this.config = merged as BackupConfigDto;
    await this.settingsService.set(BACKUP_SETTING_KEY, this.config as unknown as Record<string, unknown>);
    this.reschedule();
    return this.getConfig();
  }

  // ==========================================================================
  // Dynamic cron scheduling
  // ==========================================================================

  private clearCronJobs(): void {
    for (const name of this.cronJobNames) {
      try { this.schedulerRegistry.deleteCronJob(name); } catch { }
    }
    this.cronJobNames = [];
  }

  private addJob(name: string, cronExpr: string, fn: () => Promise<void>): void {
    const job = new CronJob(cronExpr, fn);
    this.schedulerRegistry.addCronJob(name, job);
    job.start();
    this.cronJobNames.push(name);
  }

  reschedule(): void {
    this.clearCronJobs();
    if (this.config.frequency === BackupFrequency.Manual) {
      this.logger.log('Manual backup mode — no cron scheduled');
      return;
    }
    const times = this.resolveCronExpressions();
    for (const t of times) {
      if (this.config.types.includes(BackupType.Full)) {
        this.addJob(`backup-full-${t.name}`, t.expr, async () => { await this.runFullBackup(); });
      }
      if (this.config.types.includes(BackupType.Incremental)) {
        this.addJob(`backup-inc-${t.name}`, t.expr, async () => { await this.runIncrementalBackup(); });
      }
      if (this.config.includes?.uploadedImages || this.config.includes?.productImages) {
        this.addJob(`backup-files-${t.name}`, t.expr, async () => { await this.runFilesBackup(); });
      }
      if (this.config.includes?.envFile || this.config.includes?.configFiles) {
        this.addJob(`backup-config-${t.name}`, t.expr, async () => { await this.runConfigBackup(); });
      }
    }
    if (this.config.cleanup?.deleteExpired) {
      this.addJob('backup-cleanup', '0 5 * * *', async () => { await this.cleanup(); });
    }
  }

  private resolveCronExpressions(): { name: string; expr: string }[] {
    const f = this.config.frequency;
    switch (f) {
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
        return (this.config.dailyConfig?.times ?? ['02:00']).map((t, i) => {
          const [h, m] = t.split(':').map(Number);
          return { name: `daily-${i}-${t.replace(':', '')}`, expr: `${m} ${h} * * *` };
        });
      case BackupFrequency.Weekly:
        return (this.config.weeklyConfig?.days ?? [0]).map((d) => {
          const [h, m] = (this.config.weeklyConfig?.time ?? '03:00').split(':').map(Number);
          return { name: `weekly-${d}`, expr: `${m} ${h} * * ${d}` };
        });
      case BackupFrequency.Monthly:
        return [{ name: 'monthly', expr: '0 2 1 * *' }];
      case BackupFrequency.CustomMinutes:
        return [{ name: `every-${this.config.customIntervalMinutes}m`, expr: `*/${this.config.customIntervalMinutes} * * * *` }];
      case BackupFrequency.CustomHours:
        return [{ name: `every-${this.config.customIntervalMinutes}h`, expr: `0 */${this.config.customIntervalMinutes} * * *` }];
      case BackupFrequency.Cron:
        return this.config.customCronExpression ? [{ name: 'custom', expr: this.config.customCronExpression }] : [];
      default:
        return [];
    }
  }

  // ==========================================================================
  // Layer 1 — Full database backup
  // ==========================================================================

  async runFullBackup(): Promise<BackupRunResult> {
    if (this.busy.has('full')) return this.skipped('full', 'already running');
    this.busy.add('full');
    const started = Date.now();
    const fileName = this.buildFileName('FULL');
    const dir = this.ensureDestDir('full');
    const file = path.join(dir, fileName);
    try {
      await fs.mkdir(dir, { recursive: true });
      const compress = this.config.advanced?.compressionLevel ?? 6;
      await this.execPg('pg_dump', ['--format=custom', `--compress=${compress}`, '--no-owner', '--no-password', `--file=${file}`]);
      if (this.config.verification?.verifyIntegrity) {
        await this.execPg('pg_restore', ['--list', file]);
      }
      const { size } = await fs.stat(file);
      let checksumSha256: string | undefined;
      if (this.config.verification?.sha256Checksum) {
        checksumSha256 = await this.sha256(file);
      }
      const result: BackupRunResult = {
        kind: 'full', status: 'success', target: file, sizeBytes: size,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        checksumSha256,
      };
      await this.encryptFile(file);
      await this.copyToDestinations(file);
      return await this.record(result);
    } catch (err) {
      await fs.rm(file, { force: true }).catch(() => {});
      return await this.record({
        kind: 'full', status: 'failed', target: file,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('full');
    }
  }

  // ==========================================================================
  // Layer 2 — Incremental (WAL-based)
  // ==========================================================================

  async runIncrementalBackup(): Promise<BackupRunResult> {
    if (this.busy.has('incremental')) return this.skipped('incremental', 'already running');
    this.busy.add('incremental');
    const started = Date.now();
    const fileName = this.buildFileName('INCREMENTAL');
    const dir = this.ensureDestDir('incremental');
    const file = path.join(dir, fileName);
    try {
      await fs.mkdir(dir, { recursive: true });
      await this.execPg('psql', ['-c', 'SELECT pg_switch_wal()']);
      await fs.writeFile(file, `WAL archived at ${new Date().toISOString()}\n`);
      return await this.record({
        kind: 'incremental', status: 'success', target: file,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
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

  // ==========================================================================
  // Layer 3 — Files (robocopy)
  // ==========================================================================

  async runFilesBackup(): Promise<BackupRunResult> {
    if (this.busy.has('files')) return this.skipped('files', 'already running');
    this.busy.add('files');
    const started = Date.now();
    const dest = this.ensureDestDir('files');
    const log = path.join(this.config.destinations[0]?.path ?? BACKUP_DEFAULTS.destinations[0].path, 'logs', 'robocopy.log');
    const uploadsPaths = this.resolveUploadPaths();
    try {
      await fs.mkdir(dest, { recursive: true });
      for (const src of uploadsPaths) {
        const target = path.join(dest, path.basename(src));
        await fs.mkdir(target, { recursive: true });
        try {
          await execFileAsync('robocopy', [src, target, '/E', '/Z', '/R:2', '/W:5', '/NP', '/NDL', '/NFL', `/LOG+:${log}`], { windowsHide: true });
        } catch (e: any) {
          if (typeof e.code === 'number' && e.code >= 8) throw e;
        }
      }
      return await this.record({
        kind: 'files', status: 'success', target: dest,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      return await this.record({
        kind: 'files', status: 'failed', target: dest,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('files');
    }
  }

  // ==========================================================================
  // Layer 4 — Config backup (.env, settings)
  // ==========================================================================

  async runConfigBackup(): Promise<BackupRunResult> {
    if (this.busy.has('config')) return this.skipped('config', 'already running');
    this.busy.add('config');
    const started = Date.now();
    const dest = this.ensureDestDir('config');
    const fileName = this.buildFileName('CONFIG');
    const file = path.join(dest, fileName);
    try {
      await fs.mkdir(dest, { recursive: true });
      const envPaths = ['.env', 'apps/api/.env', 'apps/api/.env.example'];
      const lines: string[] = [];
      for (const p of envPaths) {
        try {
          const content = await fs.readFile(p, 'utf8');
          lines.push(`=== ${p} ===\n${content}`);
        } catch { }
      }
      await fs.writeFile(file, lines.join('\n'), 'utf8');
      return await this.record({
        kind: 'config', status: 'success', target: file,
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      return await this.record({
        kind: 'config', status: 'failed',
        durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('config');
    }
  }

  // ==========================================================================
  // Retention — prune old artifacts
  // ==========================================================================

  async cleanup(): Promise<void> {
    const r = this.config.retention!;
    const dirs = ['full', 'incremental', 'differential', 'files', 'config'];
    for (const sub of dirs) {
      const d = this.ensureDestDir(sub);
      const items = await this.listByMtime(d);
      if (r.mode === RetentionMode.KeepLast) {
        for (const item of items.slice(r.keepLastCount ?? 14)) {
          await fs.rm(item.path, { recursive: true, force: true });
        }
      } else if (r.mode === RetentionMode.KeepByAge) {
        const cutoff = Date.now() - (r.keepDays ?? 30) * 86400000;
        for (const item of items) {
          if (item.mtime < cutoff) await fs.rm(item.path, { recursive: true, force: true });
        }
      } else if (r.mode === RetentionMode.Smart) {
        await this.smartPrune(d, items, r.smartDaily ?? 30, r.smartWeekly ?? 12, r.smartMonthly ?? 12);
      }
    }
    if (this.config.cleanup?.removeFailedFiles) {
      try {
        const dir = this.ensureDestDir('');
        const files = await fs.readdir(dir);
        for (const f of files) {
          if (f.startsWith('failed_') || f.includes('.tmp')) {
            await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
          }
        }
      } catch { }
    }
  }

  private async smartPrune(dir: string, items: { path: string; mtime: number }[], keepDaily: number, keepWeekly: number, keepMonthly: number): Promise<void> {
    const now = Date.now();
    const day = 86400000;
    const keep = new Set<string>();
    for (const item of items) {
      const ageDays = (now - item.mtime) / day;
      if (ageDays <= keepDaily) { keep.add(item.path); continue; }
      if (ageDays <= keepDaily + keepWeekly * 7) {
        const week = Math.floor(ageDays / 7);
        if (week <= keepWeekly) { keep.add(item.path); continue; }
      }
      if (ageDays <= keepDaily + keepWeekly * 7 + keepMonthly * 30) {
        const month = Math.floor(ageDays / 30);
        if (month <= keepMonthly) { keep.add(item.path); }
      }
    }
    for (const item of items) {
      if (!keep.has(item.path)) await fs.rm(item.path, { recursive: true, force: true });
    }
  }

  // ==========================================================================
  // Status
  // ==========================================================================

  getStatus() {
    const lastByKind: Partial<Record<BackupKind, BackupRunResult>> = {};
    for (const r of this.history) {
      if (r.status === 'skipped') continue;
      if (!lastByKind[r.kind]) lastByKind[r.kind] = r;
    }
    return { lastByKind, recent: this.history.slice(0, 20), config: this.getConfig() };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private buildFileName(type: string): string {
    const fmt = this.config.namingFormat ?? 'POS-CAFE_{TYPE}_{DATE}_{TIME}';
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    let name = fmt.replace(/{TYPE}/g, type).replace(/{DATE}/g, date).replace(/{TIME}/g, time);
    name = name.replace(/[<>:"/\\|?*]/g, '_');
    return type === 'FULL' ? `${name}.dump` : type === 'CONFIG' ? `${name}.txt` : `${name}.zip`;
  }

  private ensureDestDir(sub: string): string {
    const base = this.config.destinations[0]?.path ?? BACKUP_DEFAULTS.destinations[0].path;
    return path.join(base, sub);
  }

  private resolveUploadPaths(): string[] {
    const paths: string[] = [];
    const cwd = process.cwd();
    if (this.config.includes?.uploadedImages) paths.push(path.join(cwd, 'apps', 'api', 'var', 'uploads'));
    if (this.config.includes?.productImages) paths.push(path.join(cwd, 'var', 'uploads'));
    return paths.filter((p) => {
      try { return fs.stat(p).then(() => true).catch(() => false); } catch { return false; }
    });
  }

  private async encryptFile(file: string): Promise<void> {
    if (this.config.encryption?.type !== EncryptionType.AES256 || !this.config.encryption.password) return;
    const encFile = `${file}.enc`;
    try {
      await execAsync(`openssl enc -aes-256-cbc -salt -pbkdf2 -in "${file}" -out "${encFile}" -pass pass:"${this.config.encryption.password}"`, { windowsHide: true });
      await fs.rm(file, { force: true });
      await fs.rename(encFile, file);
    } catch (err) {
      this.logger.warn(`Encryption failed for ${file}: ${this.errText(err)}`);
    }
  }

  private async copyToDestinations(sourceFile: string): Promise<void> {
    if (this.config.internetBehaviour === InternetBehaviour.LocalOnly) return;
    for (const dest of this.config.destinations) {
      if (!dest.enabled || dest.type === 'local') continue;
      try {
        const targetDir = path.join(dest.path, 'full');
        await fs.mkdir(targetDir, { recursive: true });
        await fs.cp(sourceFile, path.join(targetDir, path.basename(sourceFile)));
        this.logger.log(`Copied backup to ${dest.label ?? dest.type}: ${targetDir}`);
      } catch (err) {
        this.logger.warn(`Failed to copy to ${dest.label ?? dest.type}: ${this.errText(err)}`);
      }
    }
  }

  private async sha256(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = require('node:fs').createReadStream(file);
      stream.on('data', (d: Buffer) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async record(result: BackupRunResult): Promise<BackupRunResult> {
    this.history.unshift(result);
    this.history = this.history.slice(0, 100);
    if (result.status === 'failed') {
      this.logger.error(`${result.kind} backup FAILED: ${result.error}`);
    } else {
      this.logger.log(`${result.kind} backup ${result.status}: ${result.target ?? ''} (${Math.round(result.durationMs / 1000)}s)`);
    }
    try {
      await fs.appendFile(path.join(this.ensureDestDir(''), 'logs', 'backup-history.jsonl'), JSON.stringify(result) + '\n', 'utf8');
    } catch { }
    return result;
  }

  private skipped(kind: BackupKind, reason: string): BackupRunResult {
    this.logger.warn(`${kind} backup skipped: ${reason}`);
    return { kind, status: 'skipped', durationMs: 0, finishedAt: new Date().toISOString(), error: reason };
  }

  private execPg(tool: string, args: string[]) {
    const pgBin = process.env.PG_BIN ?? PG_BIN_DEFAULT;
    return execFileAsync(path.join(pgBin, `${tool}.exe`), args, {
      windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: { ...process.env },
    });
  }

  private async ensureDirs(): Promise<void> {
    try {
      const base = this.config.destinations[0]?.path ?? BACKUP_DEFAULTS.destinations[0].path;
      if (!base || typeof base !== 'string' || base.trim().length === 0) {
        this.logger.warn(`Invalid backup path "${base}", using fallback`);
        this.config.destinations[0] = { ...BACKUP_DEFAULTS.destinations[0] };
        return this.ensureDirs();
      }
      for (const sub of ['full', 'incremental', 'differential', 'files', 'config', 'logs']) {
        await fs.mkdir(path.join(base, sub), { recursive: true });
      }
    } catch (err) {
      this.logger.error(`Failed to create backup directories: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      const historyFile = path.join(this.ensureDestDir(''), 'logs', 'backup-history.jsonl');
      const raw = await fs.readFile(historyFile, 'utf8');
      this.history = raw.trim().split('\n').slice(-100).reverse().flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      });
    } catch {
      this.history = [];
    }
  }

  private async listByMtime(dir: string): Promise<{ path: string; mtime: number }[]> {
    try {
      const names = await fs.readdir(dir);
      const items = await Promise.all(names.map(async (n) => {
        const p = path.join(dir, n);
        const st = await fs.stat(p);
        return { path: p, mtime: st.mtimeMs };
      }));
      return items.sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  private errText(err: unknown): string {
    const e = err as { stderr?: string | Buffer; message?: string };
    return e?.stderr?.toString().trim() || e?.message || String(err);
  }
}
