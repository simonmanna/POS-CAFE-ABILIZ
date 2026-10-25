# Backup and recovery

How the POS backs itself up, how to check it is working, and how to get the café
running again from a backup. The short version for the owner is at the end.

## What is backed up

| Backup | What | File | When |
|---|---|---|---|
| Database | every sale, payment, stock movement, account, setting, user | `full/POS-CAFE_FULL_<date>_<time>.dump[.enc]` | on the schedule (default daily 02:00) |
| Images | the uploads folder (`STORAGE_LOCAL_DIR`): product photos, documents | `files/uploads/` (mirror; deleted files are kept) | same schedule |
| Server config | `apps/api/.env` (secrets included) | `config/POS-CAFE_CONFIG_<date>_<time>.txt[.enc]` | same schedule |

Everything lives under `BACKUP_DIR` (the first *Local Folder* destination on
**Settings → Backup → Storage**). Every other enabled destination (USB drive,
network folder, cloud) receives a copy of each database and config backup, and
a mirror of the images.

The database backup is always the database in `DATABASE_URL`, the one the API
writes to. `PGHOST`, `PGPORT` and `PGDATABASE` in `.env` are ignored (a stale
`PGDATABASE` used to make the nightly backup dump the wrong database). `PGUSER`
plus `PGPASSWORD` may name a different role for the backup tools.

### How each backup is checked

1. `pg_dump` writes to a `.partial` file. A crash never leaves a half-written
   file that looks like a backup.
2. The archive is read back (`pg_restore --list`). An empty or unreadable dump
   counts as a failure.
3. It is encrypted when a password is set (see below), then renamed into place.
4. A SHA-256 checksum is written next to it (`<file>.sha256`, `sha256sum -c` format).
5. Each copy to another destination is re-hashed after copying and only kept if
   it matches. A failed copy shows on the Backup page and in health.
6. **Restore test** (on by default): after each scheduled backup the dump is
   restored into a temporary database `<db>_restoretest_<stamp>`. Its tables,
   applied migrations and organizations are compared with the live database,
   then the temporary database is dropped. A failed restore test makes backup
   health **critical**.

### Schedule, retries, catch-up

- Scheduled database backups retry (default 2 retries, 5 minutes apart).
- If the server was off at backup time, a **catch-up backup** runs about two
  minutes after the API starts, once the last good backup is older than the
  schedule interval.
- `BACKUP_CRON_ENABLED=false` turns the scheduler off on that server (for
  extra API replicas, simulations, test boxes).
- Retention runs daily at 05:00 in every folder destination. The 3 newest
  backups are always kept, so a run of failed nights never ages out the last
  good ones. The images mirror is never pruned.

**Recovery point.** A daily backup can lose up to a day of sales. A dump of a
café database takes seconds, so **every 4 hours** (or hourly) is a better
setting for a live café. True point-in-time recovery needs WAL archiving on
PostgreSQL (`archive_mode = on`, an `archive_command` copying to the backup
drive, plus a weekly `pg_basebackup`). That is server configuration and is not
set up by the app. The "WAL segment switch" option only works once it is.

## Production setup checklist

- [ ] `BACKUP_DIR` set in `apps/api/.env`, ideally on a different physical disk than the PostgreSQL data.
- [ ] `BACKUP_ENCRYPTION_PASSWORD` set. **Write it down and keep it off the server and off the backup drive** (owner's safe, password manager). Without it no encrypted backup can be restored. The config backup never contains it.
- [ ] A **second destination** on Settings → Backup → Storage: a USB drive that is swapped and taken home weekly, a NAS, or cloud storage. A backup on the same disk as the database dies with it.
- [ ] `PGDATABASE` / `PGHOST` / `PGPORT` removed from `.env` (ignored now; a mismatching `PGDATABASE` shows as a health warning).
- [ ] The database role can `CREATE DATABASE` (needed by the restore test; `postgres` can).
- [ ] `BACKUP_HEALTHCHECKS_PING_URL` set to a dead-man's-switch check (e.g. healthchecks.io, period = schedule interval). It is pinged after every database backup and pinged `/fail` on a failed backup or restore test. **Silence alerts too**, which catches a server that is off or an API that is down.
- [ ] Optional: `SMTP_HOST` (+ `SMTP_*`) and an email address on the Notifications tab.
- [ ] Settings → Backup shows **Backup health: Healthy**.
- [ ] One manual drill done with `scripts/restore-backup.cjs` (below), then quarterly.

## Monitoring

- **Settings → Backup**: health with the list of issues, last results, every database backup with *Verify* and *Test restore* buttons.
- `GET /api/v1/admin/backups/health` (permission `backup:read`): `healthy | degraded | critical` plus issues.
- `GET /api/v1/health/ready` reports backup health as advisory (it never fails readiness).
- History: `<BACKUP_DIR>/logs/backup-history.jsonl`.

## Recovery

All database recovery goes through **a new database first**. Nothing restores
over the live database. Switching the café over is a separate step done with the
API stopped, and the old database is renamed and kept, never dropped.

The tool is `scripts/restore-backup.cjs`. It needs only Node and the PostgreSQL
client tools, not a working API. It reads `DATABASE_URL`, `PG_BIN`,
`BACKUP_DIR` and `BACKUP_ENCRYPTION_PASSWORD` from the environment or
`apps/api/.env`.

```bash
node scripts/restore-backup.cjs list
node scripts/restore-backup.cjs verify  POS-CAFE_FULL_2026-10-09_020000.dump.enc
node scripts/restore-backup.cjs restore POS-CAFE_FULL_2026-10-09_020000.dump.enc
node scripts/restore-backup.cjs promote --target <restored database printed by restore>
```

### A. Bad data or a damaged database (server still works)

1. Pick the backup from before the problem: `node scripts/restore-backup.cjs list`.
2. `restore <file>`: checksum, decrypt, restore into `<db>_restored_<stamp>`, then
   print a side-by-side summary of the restored and live database (tables,
   migrations, organizations, invoices, latest invoice time).
3. Decide. Sales made after the backup exist only in the live database. Export
   or note them before switching.
4. `nssm stop pos-cafe-api` (and anything else connected to the database).
5. `promote --target <restored db>`. It refuses while connections are open. The
   live database becomes `<db>_pre_restore_<stamp>` and the restored one takes
   its name, so `.env` does not change.
6. `nssm start pos-cafe-api`, check `/api/v1/health/ready`, make a test sale,
   and check the terminals reconnect.

`promote` renames databases, so the role needs ownership of both databases or
superuser. Run it as `postgres` when in doubt:
`PGUSER=postgres PGPASSWORD=... node scripts/restore-backup.cjs promote --target ...`.

### B. Server lost (disk failure, theft, new PC)

1. Install PostgreSQL (same major version or newer), Node 22, nginx and the POS
   release as in the deployment runbook.
2. Get the newest backup set from the USB drive, NAS or cloud: `full/*.dump.enc`
   with its `.sha256`, `config/*.txt.enc` and `files/uploads/`.
3. Recover `.env` from the config backup:
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in POS-CAFE_CONFIG_<...>.txt.enc -out config.txt
   ```
   Copy the `apps/api/.env` section into the new `apps/api/.env`. Then fill in
   `BACKUP_ENCRYPTION_PASSWORD`, which is redacted in the file on purpose, and
   adjust paths and the database password. Keeping the JWT secrets means
   devices do not all have to sign in again.
4. Create the database role from `DATABASE_URL`, for example
   `CREATE ROLE "cafe-pos" LOGIN PASSWORD '...' CREATEDB;`. With the app on
   `postgres` (`RLS_ALLOW_SUPERUSER=true`), skip this step.
5. Put the backup files under `BACKUP_DIR\full\` and run `restore`, then `promote`
   (with no live database it only renames).
6. Images: `robocopy <backup>\files\uploads <STORAGE_LOCAL_DIR> /E`.
7. Install and start the services, then check as in A.6. Then set up backups
   again (the checklist above) before the café opens.

### Opening a backup without the POS

Encrypted files use the standard OpenSSL format:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in backup.dump.enc -out backup.dump
pg_restore --list backup.dump        # readable?
createdb some_new_db && pg_restore --no-owner --exit-on-error -d some_new_db backup.dump
```

Git for Windows ships `openssl` (`C:\Program Files\Git\usr\bin\openssl.exe`).

### Running backups by hand

From `apps/api` (after `pnpm --filter @erp/api build`):

```bash
node dist/scripts/run-backup.js full            # or files | config | test-restore | cleanup
```

Exit code 1 means it failed (usable from Task Scheduler as an extra safety net).

## For the owner

- Look at **Settings → Backup** once a week. It should say **Healthy**.
- Swap the USB backup drive weekly and keep the other one at home.
- Keep the backup password written down somewhere safe away from the café computer.
- If health is red or a "backup failed" alert arrives, call the engineer the same day.
