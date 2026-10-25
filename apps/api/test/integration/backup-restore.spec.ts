/**
 * Backup → restore round trip against the real database: pg_dump, encryption,
 * checksum sidecars, the verified copy to a second destination, a full restore
 * into a throwaway database, and the guards that keep the live database safe.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describeDb } from './_setup';
import { BackupService } from '../../src/modules/backup/backup.service';
import { BACKUP_DEFAULTS } from '../../src/modules/backup/backup.constants';
import { DestinationType, RestoreScope } from '../../src/modules/backup/backup.dto';

jest.setTimeout(15 * 60_000);

describeDb('integration: backup and restore', () => {
  let service: BackupService;
  let primary: string;
  let offsite: string;
  const savedPassword = process.env.BACKUP_ENCRYPTION_PASSWORD;
  const password = randomBytes(12).toString('hex');

  beforeAll(async () => {
    primary = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-backup-primary-'));
    offsite = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-backup-offsite-'));
    process.env.BACKUP_ENCRYPTION_PASSWORD = password;
    service = new BackupService(
      { getServerWide: jest.fn().mockResolvedValue(null), setServerWide: jest.fn() } as any,
      { addCronJob: jest.fn(), deleteCronJob: jest.fn() } as any,
    );
    (service as any).config = {
      ...structuredClone(BACKUP_DEFAULTS),
      destinations: [
        { type: DestinationType.Local, path: primary, label: 'Primary', enabled: true },
        { type: DestinationType.ExternalDrive, path: offsite, label: 'USB', enabled: true },
      ],
    };
  });

  afterAll(async () => {
    if (savedPassword === undefined) delete process.env.BACKUP_ENCRYPTION_PASSWORD;
    else process.env.BACKUP_ENCRYPTION_PASSWORD = savedPassword;
    await fs.rm(primary, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(offsite, { recursive: true, force: true }).catch(() => undefined);
  });

  let backupFile: string;

  it('writes an encrypted, checksummed dump of the DATABASE_URL database and a verified offsite copy', async () => {
    const r = await service.runFullBackup({ notify: false });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('success');
    expect(r.encrypted).toBe(true);
    expect(r.database).toBe(decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1)));
    backupFile = r.target!;
    expect(backupFile.endsWith('.dump.enc')).toBe(true);

    const names = await fs.readdir(path.join(primary, 'full'));
    expect(names.sort()).toEqual([path.basename(backupFile), `${path.basename(backupFile)}.sha256`].sort());
    const head = (await fs.readFile(backupFile)).subarray(0, 8).toString('latin1');
    expect(head).toBe('Salted__');

    expect(r.copies).toEqual([expect.objectContaining({ destination: 'USB', ok: true })]);
    const copy = await fs.readFile(path.join(offsite, 'full', path.basename(backupFile)));
    expect(copy.equals(await fs.readFile(backupFile))).toBe(true);
  });

  it('decrypts with stock openssl (disaster recovery without the POS install)', async () => {
    const openssl = 'openssl';
    try {
      execFileSync(openssl, ['version']);
    } catch {
      return; // not installed here; the format is covered by the restore tests below
    }
    const out = path.join(primary, 'openssl-check.dump');
    execFileSync(openssl, ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-md', 'sha256', '-pass', `pass:${password}`, '-in', backupFile, '-out', out]);
    const magic = (await fs.readFile(out)).subarray(0, 5).toString('latin1');
    expect(magic).toBe('PGDMP');
    await fs.rm(out, { force: true });
  });

  it('verifies a backup by name', async () => {
    const r = await service.restore({ scope: RestoreScope.Database, backupFile: path.basename(backupFile), verifyOnly: true });
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.checks?.checksum).toBe('verified');
    expect(r.checks?.tocEntries).toBeGreaterThan(100);
  });

  it('restore test: restores into a throwaway database, compares, drops it', async () => {
    const r = await service.runRestoreTest(backupFile);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('success');
    expect(r.database).toMatch(/_restoretest_\d{14}$/);
    expect(await (service as any).databaseExists(r.database)).toBe(false);
  });

  it('refuses to restore over the live database', async () => {
    const live = decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1));
    const r = await service.restore({ scope: RestoreScope.Database, backupFile, targetDatabase: live });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/live database/);
  });

  it('refuses files outside the backup folders', async () => {
    const outside = path.join(os.tmpdir(), `outside-${randomBytes(4).toString('hex')}.dump`);
    await fs.writeFile(outside, 'x');
    try {
      const r = await service.restore({ scope: RestoreScope.Database, backupFile: outside, verifyOnly: true });
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/inside a configured backup folder/);
      const traversal = await service.restore({ scope: RestoreScope.Database, backupFile: '../../outside.dump', verifyOnly: true });
      expect(traversal.success).toBe(false);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('detects a corrupted backup through its checksum', async () => {
    const copy = path.join(primary, 'full', 'POS-CAFE_FULL_tampered.dump.enc');
    const bytes = await fs.readFile(backupFile);
    bytes[bytes.length - 100] ^= 0xff;
    await fs.writeFile(copy, bytes);
    await fs.copyFile(`${backupFile}.sha256`, `${copy}.sha256`);
    const r = await service.restore({ scope: RestoreScope.Database, backupFile: copy, verifyOnly: true });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Checksum mismatch/);
  });
});
