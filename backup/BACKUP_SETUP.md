# Clinic Backup System — Setup & Restore Guide

## How the layers fit together

The nightly `pg_dump` gives you a portable full backup: one compressed file that restores anywhere, even into a newer PostgreSQL version. The incremental layer is PostgreSQL's WAL archiving. Postgres already writes every committed change to its write-ahead log; with `archive_mode = on`, each finished WAL segment is copied into your backup folder within minutes. The weekly `pg_basebackup` is the anchor: a restore extracts the latest base backup and replays WAL up to any moment you choose (point-in-time recovery). So a bad write at 11:04 can be recovered to 11:03 — worst-case data loss is roughly `archive_timeout` (5 minutes below), not a full day. The optional third layer syncs the uploads folder (x-rays, scans) with robocopy, which only copies files that changed.

## 1. Install and configure the app side

```
npm i @nestjs/schedule
```

Copy `backup.module.ts`, `backup.service.ts`, `backup.controller.ts` into `src/backup/` and `run-backup.ts` into `src/scripts/`, then register in `AppModule`:

```ts
imports: [ScheduleModule.forRoot(), BackupModule, ...]
```

Add to `.env` (adjust the PostgreSQL version in `PG_BIN` — check with `pg_dump --version`):

```
# Connection — standard libpq vars, picked up by pg_dump / pg_basebackup
PGHOST=localhost
PGPORT=5432
PGDATABASE=dental_clinic
PGUSER=postgres
PGPASSWORD=change-me

# Backup settings
PG_BIN=C:\Program Files\PostgreSQL\16\bin
BACKUP_DIR=D:\ClinicBackups
BACKUP_FULL_RETENTION_DAYS=14
BACKUP_BASE_KEEP=4
# BACKUP_UPLOADS_SRC=C:\clinic\uploads
# BACKUP_CRON_ENABLED=true
```

Put `BACKUP_DIR` on a **different physical disk** than the Postgres data directory if the machine has one. A backup on the same dying disk is not a backup.

Schedules are in the `@Cron(...)` decorators in `backup.service.ts`: full dump daily 02:00, uploads sync 02:30, prune 04:30, base backup Sunday 03:00.

## 2. Enable WAL archiving (the incremental layer)

Find `postgresql.conf` (`SHOW config_file;` in psql) and set:

```
wal_level = replica
archive_mode = on
archive_command = 'copy "%p" "D:\\ClinicBackups\\wal\\%f"'
archive_timeout = 300    # force a segment out at least every 5 minutes
```

The `archive_command` runs as the PostgreSQL Windows service account, so that account needs write access to the wal folder. Check which account in services.msc → your PostgreSQL service → Log On tab (often `NT AUTHORITY\NETWORK SERVICE`), then:

```
icacls "D:\ClinicBackups\wal" /grant "NT AUTHORITY\NETWORK SERVICE:(OI)(CI)M"
```

Restart PostgreSQL (service name varies by version):

```
net stop postgresql-x64-16
net start postgresql-x64-16
```

Verify it works — in psql run `SELECT pg_switch_wal();` and confirm a new file appears in `D:\ClinicBackups\wal\`. Then keep an eye on `SELECT * FROM pg_stat_archiver;` — `failed_count` should stay at 0. If archiving silently fails, WAL piles up on the main disk until it fills, so this check matters.

## 3. Dedicated backup role (recommended)

Using the `postgres` superuser works, but a scoped role is cleaner:

```sql
CREATE ROLE backup_user LOGIN REPLICATION PASSWORD 'strong-password';
GRANT pg_read_all_data TO backup_user;  -- PostgreSQL 14+
```

Add to `pg_hba.conf` (then `SELECT pg_reload_conf();`):

```
host  replication    backup_user  127.0.0.1/32  scram-sha-256
host  dental_clinic  backup_user  127.0.0.1/32  scram-sha-256
```

The `replication` line is what allows `pg_basebackup` to connect. Point `PGUSER`/`PGPASSWORD` in `.env` at this role.

## 4. Keep the scheduler alive on Windows

In-app cron only fires while the API process is running. Run the NestJS app as a Windows service so it survives reboots — nssm is the simplest way:

```
nssm install ClinicApi "C:\Program Files\nodejs\node.exe" "C:\clinic\api\dist\main.js"
nssm set ClinicApi AppDirectory C:\clinic\api
nssm set ClinicApi AppStdout C:\clinic\logs\api.log
nssm set ClinicApi AppStderr C:\clinic\logs\api.err.log
nssm start ClinicApi
```

As a safety net, you can also add a Windows Task Scheduler task that runs `node C:\clinic\api\dist\scripts\run-backup.js full` daily. Pick one primary scheduler: if Task Scheduler owns the backups, set `BACKUP_CRON_ENABLED=false` in `.env` so they don't double-run.

## 5. Restore procedures — practice these

### A. Restore last night's full dump (the common case)

1. `createdb -U postgres -T template0 dental_clinic_restored`
2. `pg_restore -U postgres -d dental_clinic_restored --no-owner "D:\ClinicBackups\full\full_2026-07-16_020000.dump"`
3. Sanity-check row counts on key tables, then either point the app's `DATABASE_URL` at the restored database or rename databases.

### B. Point-in-time recovery (bad data written at 11:04 → recover to 11:03)

1. Stop the app, then `net stop postgresql-x64-16`.
2. Rename the data directory (default `C:\Program Files\PostgreSQL\16\data`) to `data_broken` — keep it until you're sure.
3. Create a fresh `data` folder and extract the newest base backup into it: `base.tar.gz` → `data\`, and `pg_wal.tar.gz` → `data\pg_wal\`. Windows 10+ ships `tar`, so `tar -xzf base.tar.gz -C data` works.
4. In the new `data\postgresql.conf` add:

   ```
   restore_command = 'copy "D:\\ClinicBackups\\wal\\%f" "%p"'
   recovery_target_time = '2026-07-16 11:03:00'
   recovery_target_action = 'promote'
   ```

5. Create an empty file named `recovery.signal` inside `data\`.
6. Make sure the PostgreSQL service account has full control of `data\`: `icacls "...\data" /grant "NT AUTHORITY\NETWORK SERVICE:(OI)(CI)F" /T`
7. `net start postgresql-x64-16` and watch the log folder — you'll see WAL being replayed, then "database system is ready to accept connections".
8. Verify the data, then immediately take a fresh full dump and base backup.

### Monthly restore drill

Once a month, restore the latest dump into a scratch database, compare counts on your key tables (patients, appointments, treatments), then drop it. A backup you've never restored is a hope, not a backup. This takes ten minutes and is the single highest-value habit in this whole document.

## 6. Off-machine copies and encryption

Follow 3-2-1: three copies, two media, one offsite. The nightly dump should leave the machine — an external drive swapped weekly, plus a cloud copy. Since these are patient records, encrypt anything that leaves the box:

```
7z a -p"long-passphrase" -mhe=on E:\Offsite\clinic_2026-07-16.7z "D:\ClinicBackups\full\full_2026-07-16_020000.dump"
```

For cloud, rclone works well on Windows (Backblaze B2, S3, Google Drive), and an rclone `crypt` remote encrypts client-side before upload:

```
rclone copy D:\ClinicBackups secure-remote:clinic-backups --include "full/**"
```

Store the encryption passphrase somewhere safe that is *not* this machine — an encrypted backup you can't decrypt after the machine dies is just noise.

## 7. If you're on PostgreSQL 17+

PG 17 added native incremental backups: set `summarize_wal = on`, then `pg_basebackup --incremental=<path-to-previous-backup_manifest>` produces a backup containing only changed blocks, and `pg_combinebackup` merges the chain at restore time. It's a valid alternative to WAL archiving if you prefer discrete nightly incrementals over a continuous archive — though WAL archiving still gives you finer recovery granularity (any minute vs. backup times only), which is why it's the default here.

## 8. Quick health checklist

Last night's dump exists and its size looks sane; `pg_stat_archiver` shows zero failures; `GET /admin/backups/status` is green; the offsite copy is current; the monthly restore drill happened. Surfacing that status endpoint as a small badge in the React admin ("Last backup: today 02:00 ✓") means a silent failure gets noticed by whoever opens the app.
