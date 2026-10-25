import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { BackupService } from '../../src/modules/backup/backup.service';
import { SettingsService } from '../../src/kernel/settings/settings.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BadRequestException } from '@nestjs/common';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { BackupFrequency, BackupType, DestinationType, EncryptionType, InternetBehaviour, RetentionMode, RestoreScope } from '../../src/modules/backup/backup.dto';
import { BACKUP_DEFAULTS, SECRET_MASK } from '../../src/modules/backup/backup.constants';
import { decryptFile, encryptFile } from '../../src/modules/backup/backup-crypto';

describe('BackupService', () => {
  let service: BackupService;
  let mockSettingsService: Partial<SettingsService>;
  let mockSchedulerRegistry: Partial<SchedulerRegistry>;
  let backupDir: string;

  beforeEach(async () => {
    mockSettingsService = {
      getServerWide: jest.fn().mockResolvedValue(null),
      setServerWide: jest.fn().mockResolvedValue({}),
    };

    mockSchedulerRegistry = {
      addCronJob: jest.fn(),
      deleteCronJob: jest.fn(),
      doesExist: jest.fn().mockReturnValue(false),
      getCronJob: jest.fn(),
      getCronJobs: jest.fn().mockReturnValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: SchedulerRegistry, useValue: mockSchedulerRegistry },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);

    // Point the service at an empty scratch directory. It otherwise resolves to
    // `apps/api/backup`, the developer's real backup folder — so "no backups
    // exist" asserted against whatever dumps happened to be on that machine and
    // failed for anyone who had ever run a backup.
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-backup-spec-'));
    (service as any).config = {
      ...(service as any).config,
      destinations: [
        { ...(service as any).config.destinations[0], path: backupDir },
      ],
    };
  });

  afterEach(async () => {
    if (backupDir) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getConfig', () => {
    it('should return default config when no DB setting exists', () => {
      const config = service.getConfig();
      expect(config.frequency).toBe(BackupFrequency.Daily);
      expect(config.types).toContain(BackupType.Full);
      expect(config.destinations[0].type).toBe(DestinationType.Local);
    });
  });

  describe('updateConfig', () => {
    it('should merge partial config with defaults', async () => {
      const newConfig = await service.updateConfig({
        frequency: BackupFrequency.Weekly,
        dailyConfig: { times: ['03:00'] },
      });
      
      expect(newConfig.frequency).toBe(BackupFrequency.Weekly);
      expect(newConfig.dailyConfig?.times).toEqual(['03:00']);
      expect(newConfig.types).toContain(BackupType.Full); // should preserve default
    });

    it('should persist to settings service', async () => {
      await service.updateConfig({ frequency: BackupFrequency.Manual });
      expect(mockSettingsService.setServerWide).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('should return empty history initially', () => {
      const status = service.getStatus();
      expect(status.lastByKind).toEqual({});
      expect(status.recent).toEqual([]);
      expect(status.config).toBeDefined();
    });
  });

  describe('restore', () => {
    it('should reject empty backup file path', async () => {
      const result = await service.restore({
        scope: RestoreScope.Database,
        backupFile: '',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('required');
    });

    it('should reject non-existent backup file', async () => {
      const result = await service.restore({
        scope: RestoreScope.Database,
        backupFile: '/nonexistent/path/dump.dump',
      });
      
      expect(result.success).toBe(false);
    });
  });

  describe('listBackups', () => {
    it('should return empty array when no backups exist', async () => {
      const backups = await service.listBackups('full');
      expect(backups).toEqual([]);
    });
  });

  describe('getHealthStatus', () => {
    it('should return critical when no backups exist', async () => {
      const health = await service.getHealthStatus();
      expect(health.status).toBe('critical');
      expect(health.issues).toContain('No full backup found');
    });
  });

  describe('database connection', () => {
    const keys = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;
    let saved: Record<string, string | undefined>;
    beforeEach(() => { saved = Object.fromEntries(keys.map((k) => [k, process.env[k]])); });
    afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    it('backs up the DATABASE_URL database even when .env carries stale PG* values', () => {
      // The shipped .env template: PGHOST set, PGUSER/PGPASSWORD blank, PGDATABASE
      // naming another (e.g. the frozen legacy) database.
      process.env.DATABASE_URL = 'postgresql://cafe-pos:p%40ss%3Aword@db.local:5433/cafe_pos_v2?schema=public';
      Object.assign(process.env, { PGHOST: 'localhost', PGPORT: '5432', PGUSER: '', PGPASSWORD: '', PGDATABASE: 'POS-CAFE' });
      const pg = (service as any).pgConnection();
      expect(pg.database).toBe('cafe_pos_v2');
      expect(pg.env).toMatchObject({ PGHOST: 'db.local', PGPORT: '5433', PGUSER: 'cafe-pos', PGPASSWORD: 'p@ss:word' });
      expect(pg.env.PGDATABASE).toBeUndefined();
      expect([...(service as any).warnedOnce].join()).toMatch(/PGDATABASE="POS-CAFE"/);
    });

    it('lets PGUSER/PGPASSWORD name a separate backup role', () => {
      process.env.DATABASE_URL = 'postgresql://app:secret@localhost:5432/cafe';
      Object.assign(process.env, { PGUSER: 'postgres', PGPASSWORD: 'admin' });
      expect((service as any).pgConnection().env).toMatchObject({ PGUSER: 'postgres', PGPASSWORD: 'admin' });
    });
  });

  describe('config validation and secrets', () => {
    it('rejects schedules that would crash the scheduler or stop backups', async () => {
      await expect(service.updateConfig({ frequency: BackupFrequency.Cron, customCronExpression: 'not a cron' })).rejects.toThrow(BadRequestException);
      await expect(service.updateConfig({ frequency: BackupFrequency.CustomMinutes, customIntervalMinutes: 90 })).rejects.toThrow(BadRequestException);
      await expect(service.updateConfig({ types: [BackupType.Incremental] })).rejects.toThrow(BadRequestException);
      await expect(service.updateConfig({ destinations: [{ type: DestinationType.Local, path: '', enabled: true }] })).rejects.toThrow(BadRequestException);
      expect(mockSettingsService.setServerWide).not.toHaveBeenCalled();
    });

    it('never serves stored secrets and keeps them when the mask is sent back', async () => {
      await service.updateConfig({ encryption: { type: EncryptionType.AES256, password: 'hunter2' } });
      const pub = service.getPublicConfig();
      expect(pub.encryption?.password).toBe(SECRET_MASK);
      await service.updateConfig({ encryption: pub.encryption });
      expect(service.getConfig().encryption?.password).toBe('hunter2');
    });

    it('survives an invalid persisted schedule instead of failing boot', async () => {
      (service as any).config = { ...(service as any).config, frequency: BackupFrequency.Cron, customCronExpression: '99 99 * * *' };
      expect(() => service.reschedule()).not.toThrow();
      const health = await service.getHealthStatus();
      expect(health.status).toBe('critical');
      expect(health.issues.join('\n')).toMatch(/schedule/i);
    });
  });

  describe('retention', () => {
    const day = 86_400_000;
    async function seed(sub: string, ages: number[]): Promise<string[]> {
      const dir = path.join(backupDir, sub);
      await fs.mkdir(dir, { recursive: true });
      const files: string[] = [];
      for (const [i, age] of ages.entries()) {
        const f = path.join(dir, `POS-CAFE_FULL_${i}.dump`);
        await fs.writeFile(f, 'x');
        await fs.writeFile(`${f}.sha256`, 'x');
        const t = new Date(Date.now() - age * day);
        await fs.utimes(f, t, t);
        files.push(f);
      }
      return files;
    }

    it('keep-by-age never deletes the last good backups', async () => {
      (service as any).config.retention = { mode: RetentionMode.KeepByAge, keepDays: 30 };
      const files = await seed('full', [40, 41, 42, 43, 44]);
      await service.cleanup();
      const left = (await fs.readdir(path.join(backupDir, 'full'))).sort();
      expect(left).toEqual([0, 1, 2].flatMap((i) => [path.basename(files[i]), `${path.basename(files[i])}.sha256`]).sort());
    });

    it('smart retention keeps the newest backup of each recent day (plus the 3 newest)', async () => {
      (service as any).config.retention = { mode: RetentionMode.Smart, smartDaily: 3, smartWeekly: 0, smartMonthly: 0 };
      const files = await seed('full', [0, 0, 1, 2, 3, 4, 5]);
      await service.cleanup();
      const left = (await fs.readdir(path.join(backupDir, 'full'))).filter((n) => n.endsWith('.dump')).sort();
      // 0 = today, 2 and 3 = newest of the two previous days, 1 = kept by the 3-newest floor.
      expect(left).toEqual([0, 1, 2, 3].map((i) => path.basename(files[i])));
    });

    it('never prunes the uploads mirror', async () => {
      (service as any).config.retention = { mode: RetentionMode.KeepByAge, keepDays: 1 };
      const mirror = path.join(backupDir, 'files', 'uploads');
      await fs.mkdir(mirror, { recursive: true });
      const old = new Date(Date.now() - 400 * day);
      await fs.utimes(mirror, old, old);
      await service.cleanup();
      await expect(fs.stat(mirror)).resolves.toBeDefined();
    });
  });
});

describe('backup encryption format', () => {
  it('round-trips and rejects a wrong password', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-backup-crypto-'));
    try {
      const plain = path.join(dir, 'a.dump');
      const data = randomBytes(100_000);
      await fs.writeFile(plain, data);
      await encryptFile(plain, `${plain}.enc`, 'correct horse');
      const enc = await fs.readFile(`${plain}.enc`);
      expect(enc.subarray(0, 8).toString('latin1')).toBe('Salted__');
      await decryptFile(`${plain}.enc`, `${plain}.out`, 'correct horse');
      expect((await fs.readFile(`${plain}.out`)).equals(data)).toBe(true);
      await expect(decryptFile(`${plain}.enc`, `${plain}.bad`, 'wrong')).rejects.toThrow(/wrong password|decrypt/i);

      // Backups written by the old `openssl enc -pbkdf2` call (10000 iterations) still open.
      const salt = randomBytes(8);
      const kdf = pbkdf2Sync('correct horse', salt, 10_000, 48, 'sha256');
      const c = createCipheriv('aes-256-cbc', kdf.subarray(0, 32), kdf.subarray(32, 48));
      await fs.writeFile(`${plain}.legacy`, Buffer.concat([Buffer.from('Salted__'), salt, c.update(data), c.final()]));
      await decryptFile(`${plain}.legacy`, `${plain}.legacy.out`, 'correct horse');
      expect((await fs.readFile(`${plain}.legacy.out`)).equals(data)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('BackupConfigDto validation', () => {
  it('should have valid defaults', () => {
    expect(BACKUP_DEFAULTS.frequency).toBe(BackupFrequency.Daily);
    expect(BACKUP_DEFAULTS.destinations[0].type).toBe(DestinationType.Local);
    expect(BACKUP_DEFAULTS.encryption.type).toBe(EncryptionType.None);
    // BACKUP_FULL_RETENTION_DAYS (from .env) switches the default to age-based retention.
    expect(BACKUP_DEFAULTS.retention.mode).toBe(Number(process.env.BACKUP_FULL_RETENTION_DAYS) > 0 ? RetentionMode.KeepByAge : RetentionMode.KeepLast);
    expect(BACKUP_DEFAULTS.internetBehaviour).toBe(InternetBehaviour.LocalOnly);
  });
});