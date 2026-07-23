import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export type BackupKind = 'full' | 'base' | 'files';

export interface BackupRunResult {
  kind: BackupKind;
  status: 'success' | 'failed' | 'skipped';
  target?: string;
  sizeBytes?: number;
  durationMs: number;
  finishedAt: string;
  error?: string;
}

/**
 * Application-level backups for the clinic database. Lives in src/backup/.
 *
 * Layer 1 (full):        nightly `pg_dump` custom-format dump (logical, portable).
 * Layer 2 (incremental): continuous WAL archiving configured in postgresql.conf
 *                        (see BACKUP_SETUP.md) + weekly `pg_basebackup` here as the
 *                        anchor point. Restore = base backup + WAL replay, which
 *                        gives point-in-time recovery down to the minute.
 * Layer 3 (files):       optional robocopy sync of the uploads folder (x-rays etc.).
 *
 * Connection settings come from the standard libpq env vars:
 * PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);
  private history: BackupRunResult[] = [];
  private busy = new Set<BackupKind>();

  // ---- configuration (override via .env) ----
  private get pgBin(): string {
    return process.env.PG_BIN ?? 'C:\\Program Files\\PostgreSQL\\16\\bin';
  }
  private get backupDir(): string {
    return process.env.BACKUP_DIR ?? 'C:\\ClinicBackups';
  }
  private get fullRetentionDays(): number {
    return Number(process.env.BACKUP_FULL_RETENTION_DAYS ?? 14);
  }
  private get baseBackupsToKeep(): number {
    return Number(process.env.BACKUP_BASE_KEEP ?? 4);
  }
  private get uploadsSrc(): string | undefined {
    return process.env.BACKUP_UPLOADS_SRC; // e.g. C:\clinic\uploads — leave unset to disable
  }
  private get cronEnabled(): boolean {
    // Set BACKUP_CRON_ENABLED=false if you schedule via Task Scheduler instead (see run-backup.ts)
    return (process.env.BACKUP_CRON_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  async onModuleInit(): Promise<void> {
    for (const sub of ['full', 'base', 'wal', 'files', 'logs']) {
      await fs.mkdir(path.join(this.backupDir, sub), { recursive: true });
    }
    await this.loadHistory();
  }

  // ==========================================================================
  // Layer 1 — nightly full logical dump (02:00)
  // ==========================================================================
  @Cron('0 2 * * *', { name: 'backup-full' })
  async scheduledFullBackup(): Promise<void> {
    if (!this.cronEnabled) return;
    await this.runFullBackup();
  }

  async runFullBackup(): Promise<BackupRunResult> {
    if (this.busy.has('full')) return this.skipped('full', 'already running');
    this.busy.add('full');
    const started = Date.now();
    const file = path.join(this.backupDir, 'full', `full_${this.stamp()}.dump`);
    try {
      await this.execPg('pg_dump', [
        '--format=custom',
        '--compress=6',
        '--no-owner',
        '--no-password',
        `--file=${file}`,
      ]);
      // Smoke test: a readable table of contents proves the archive isn't truncated/corrupt.
      await this.execPg('pg_restore', ['--list', file]);
      const { size } = await fs.stat(file);
      return await this.record({
        kind: 'full',
        status: 'success',
        target: file,
        sizeBytes: size,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      await fs.rm(file, { force: true }); // don't leave half-written dumps around
      return await this.record({
        kind: 'full',
        status: 'failed',
        target: file,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('full');
    }
  }

  // ==========================================================================
  // Layer 2 — weekly physical base backup (Sunday 03:00), anchor for WAL replay
  // ==========================================================================
  @Cron('0 3 * * 0', { name: 'backup-base' })
  async scheduledBaseBackup(): Promise<void> {
    if (!this.cronEnabled) return;
    await this.runBaseBackup();
  }

  async runBaseBackup(): Promise<BackupRunResult> {
    if (this.busy.has('base')) return this.skipped('base', 'already running');
    this.busy.add('base');
    const started = Date.now();
    const dest = path.join(this.backupDir, 'base', `base_${this.stamp()}`);
    try {
      await fs.mkdir(dest, { recursive: true });
      await this.execPg('pg_basebackup', [
        `--pgdata=${dest}`,
        '--format=tar',
        '--gzip',
        '--wal-method=stream',
        '--checkpoint=fast',
        '--no-password',
      ]);
      const size = await this.dirSize(dest);
      return await this.record({
        kind: 'base',
        status: 'success',
        target: dest,
        sizeBytes: size,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      await fs.rm(dest, { recursive: true, force: true });
      return await this.record({
        kind: 'base',
        status: 'failed',
        target: dest,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('base');
    }
  }

  // ==========================================================================
  // Layer 3 — uploads folder (x-rays, documents). robocopy only copies changes.
  // ==========================================================================
  @Cron('30 2 * * *', { name: 'backup-files' })
  async scheduledFilesBackup(): Promise<void> {
    if (!this.cronEnabled) return;
    await this.runFilesBackup();
  }

  async runFilesBackup(): Promise<BackupRunResult> {
    if (!this.uploadsSrc) return this.skipped('files', 'BACKUP_UPLOADS_SRC not set');
    if (process.platform !== 'win32') return this.skipped('files', 'robocopy is Windows-only');
    if (this.busy.has('files')) return this.skipped('files', 'already running');
    this.busy.add('files');
    const started = Date.now();
    const dest = path.join(this.backupDir, 'files');
    const log = path.join(this.backupDir, 'logs', 'robocopy.log');
    try {
      await execFileAsync(
        'robocopy',
        [this.uploadsSrc, dest, '/E', '/Z', '/R:2', '/W:5', '/NP', '/NDL', '/NFL', `/LOG+:${log}`],
        { windowsHide: true },
      );
      return await this.record({
        kind: 'files',
        status: 'success',
        target: dest,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      // robocopy exit codes 0–7 mean success (1 = files were copied); 8+ are real failures
      const code = (err as { code?: number }).code;
      if (typeof code === 'number' && code < 8) {
        return await this.record({
          kind: 'files',
          status: 'success',
          target: dest,
          durationMs: Date.now() - started,
          finishedAt: new Date().toISOString(),
        });
      }
      return await this.record({
        kind: 'files',
        status: 'failed',
        target: dest,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
        error: this.errText(err),
      });
    } finally {
      this.busy.delete('files');
    }
  }

  // ==========================================================================
  // Retention — prune old artifacts daily at 04:30, after the nightly backups
  // ==========================================================================
  @Cron('30 4 * * *', { name: 'backup-prune' })
  async scheduledPrune(): Promise<void> {
    if (!this.cronEnabled) return;
    try {
      await this.prune();
    } catch (err) {
      this.logger.error(`Prune failed: ${this.errText(err)}`);
    }
  }

  async prune(): Promise<void> {
    // 1) Full dumps: keep everything younger than fullRetentionDays, but never fewer than 3.
    const cutoff = Date.now() - this.fullRetentionDays * 24 * 60 * 60 * 1000;
    const dumps = await this.listByMtime(path.join(this.backupDir, 'full')); // newest first
    for (const [i, f] of dumps.entries()) {
      if (i >= 3 && f.mtime < cutoff) await fs.rm(f.path, { force: true });
    }

    // 2) Base backups: keep the newest N.
    const bases = await this.listByMtime(path.join(this.backupDir, 'base'));
    const kept = bases.slice(0, this.baseBackupsToKeep);
    for (const b of bases.slice(this.baseBackupsToKeep)) {
      await fs.rm(b.path, { recursive: true, force: true });
    }

    // 3) WAL archive: only needed back to the oldest base backup we kept.
    //    A 6h safety margin covers WAL written while that base backup was running.
    if (kept.length > 0) {
      const oldestKept = kept[kept.length - 1].mtime - 6 * 60 * 60 * 1000;
      for (const w of await this.listByMtime(path.join(this.backupDir, 'wal'))) {
        if (w.mtime < oldestKept) await fs.rm(w.path, { force: true });
      }
    }
  }

  // ==========================================================================
  // Status — for the admin UI ("Last backup: today 02:00 ✓")
  // ==========================================================================
  getStatus(): {
    lastByKind: Partial<Record<BackupKind, BackupRunResult>>;
    recent: BackupRunResult[];
  } {
    const lastByKind: Partial<Record<BackupKind, BackupRunResult>> = {};
    for (const r of this.history) {
      if (r.status === 'skipped') continue;
      if (!lastByKind[r.kind]) lastByKind[r.kind] = r; // history is newest-first
    }
    return { lastByKind, recent: this.history.slice(0, 20) };
  }

  // ---- internals -----------------------------------------------------------

  private async record(result: BackupRunResult): Promise<BackupRunResult> {
    this.history.unshift(result);
    this.history = this.history.slice(0, 100);
    if (result.status === 'failed') {
      this.logger.error(`${result.kind} backup FAILED: ${result.error}`);
      await this.onFailure(result);
    } else {
      this.logger.log(
        `${result.kind} backup ${result.status}: ${result.target ?? ''} (${Math.round(result.durationMs / 1000)}s)`,
      );
    }
    try {
      await fs.appendFile(
        path.join(this.backupDir, 'logs', 'backup-history.jsonl'),
        JSON.stringify(result) + '\n',
        'utf8',
      );
    } catch {
      /* history file is best-effort */
    }
    return result;
  }

  /** Wire this to email / WhatsApp / healthchecks.io. A backup that fails silently is worse than none. */
  private async onFailure(_result: BackupRunResult): Promise<void> {
    // TODO: notify yourself here.
  }

  private skipped(kind: BackupKind, reason: string): BackupRunResult {
    this.logger.warn(`${kind} backup skipped: ${reason}`);
    return {
      kind,
      status: 'skipped',
      durationMs: 0,
      finishedAt: new Date().toISOString(),
      error: reason,
    };
  }

  private execPg(tool: string, args: string[]) {
    const exe = path.join(this.pgBin, process.platform === 'win32' ? `${tool}.exe` : tool);
    return execFileAsync(exe, args, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env, // PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
    });
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await fs.readFile(
        path.join(this.backupDir, 'logs', 'backup-history.jsonl'),
        'utf8',
      );
      const lines = raw.trim().split('\n').slice(-100).reverse();
      this.history = lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as BackupRunResult];
        } catch {
          return [];
        }
      });
    } catch {
      this.history = [];
    }
  }

  private async listByMtime(dir: string): Promise<{ path: string; mtime: number }[]> {
    try {
      const names = await fs.readdir(dir);
      const items = await Promise.all(
        names.map(async (n) => {
          const p = path.join(dir, n);
          const st = await fs.stat(p);
          return { path: p, mtime: st.mtimeMs };
        }),
      );
      return items.sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    for (const item of await this.listByMtime(dir)) {
      const st = await fs.stat(item.path);
      total += st.isDirectory() ? await this.dirSize(item.path) : st.size;
    }
    return total;
  }

  private stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    // Windows filenames can't contain ':' — keep this format path-safe
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  private errText(err: unknown): string {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = e?.stderr?.toString().trim();
    return stderr || e?.message || String(err);
  }
}
