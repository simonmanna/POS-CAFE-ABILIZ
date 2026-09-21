# 2026-09-r2 - cafe migration kit (v1.5.0 -> current main)

Supersedes `deployment/2026-08-r1`, which is kept as history and must not be run
(see [What 2026-08-r1 got wrong](#what-2026-08-r1-got-wrong)).

This kit migrates a **copy** of the cafe database from the `v1.5.0`-era schema
(commit `e91fb5b`) to current `main`, and proves the result. It is deployment
tooling: it lives in the repository and is never installed into the cafe
application.

---

## 0. EXECUTION SAFETY RULE

**Authorized to modify:** files under `C:\Dev\POS-CAFE`, disposable rehearsal
databases, local test configuration.

**Never:** the live cafe database `POS-CAFE`, the live install
`C:\microsoft\POS-CAFE`, the original production backup, production PostgreSQL
configuration.

Approved rehearsal databases (`_safety.ps1` refuses anything else, and rejects
`POS-CAFE` by name before it even checks the list):

| Database | Role |
|---|---|
| `cafe_reference_20260917` | golden copy - READ ONLY, never migrated |
| `cafe_migration_r1` | disposable migration workspace |
| `ref_baseline_20260727` | disposable schema-equivalence target |
| `cafe_v2_restore_test` | disposable restore test |
| `cafe_rollback_test_r1` | disposable writable legacy copy for the rollback drill |

A failed run is never repaired by hand. Record it, drop the workspace, recreate
it from the reference, fix the kit, rerun.

**A clean rehearsal is evidence for Job 1 only. It does not authorize a
production cutover.** The go-to-production process (gates M0-G13, Job 2
wrapper, cutover day, rollback, Day 1/3/7/30 reconciliation) is in
[PRODUCTION-RUNBOOK.md](PRODUCTION-RUNBOOK.md).

Job 2 does not widen this guard. `cutover.ps1` restores the final backup into
the same approved workspace name (`cafe_migration_r1`) on the café server, runs
the unchanged chain under the unchanged guard, and only after every gate has
passed renames that workspace to the production name.

---

## 1. Why a plain upgrade does not work

| # | Obstacle | Consequence |
|---|---|---|
| 1 | The migration history was squashed twice. Production's `_prisma_migrations` holds **7** names, none of which exist in `prisma/migrations`. | `migrate deploy` treats the 5,764-line `squashed_baseline` as pending and dies on `relation "Account" already exists`. |
| 2 | The baseline drops `Account.accountType` and `isGroup` and carries no data step. | Every account ends up uncategorized: the posting engine cannot resolve accounts, so sales cannot be settled, and the nightly snapshot rebuild would rewrite history from an uncategorized COA days later. |
| 3 | Seven later migrations abort on data that a real cafe can hold (duplicate tabs, unlinked drawer movements, duplicate settings...). | `migrate deploy` stops half way. |
| 4 | From `20260913100000`, cash, journal, payment and stock history is append-only, enforced by triggers. | Any repair has to happen *before* that migration runs. |
| 5 | The cafe's old `scripts/update-pos.ps1` pulls `origin/main` and only warns when `db:deploy` fails. | Running it today builds the new API against the old schema and restarts the till. |

## 2. The method: bridge -> mark -> replay, on a copy

```
legacy POS-CAFE (never modified) --stop app--> read-only --pg_dump--> final.dump
                                                                       | pg_restore
                                                                       v
                                                                 cafe_pos_v2
  archive.sql            pre-migration values -> schema legacy_archive
  bridge-00-enums.sql    enum ADD VALUEs, committed first
  bridge-10-additive.sql DDL up to the squashed baseline
  bridge-20-backfill.ts  chart of accounts; gate: 0 unmapped postable accounts
  bridge-30-contract.sql drops accountType / isGroup / AccountType - nothing else
  equivalence-check.ps1  bridged copy == ref_baseline_20260727
  migrate resolve        the two baseline names only; the 7 legacy rows are KEPT
  migrate deploy         the 80 real migrations, with their own backfills
  drift + preflight + fingerprint + transformation proofs
```

`ref_baseline_20260727` is an empty database carrying only the two baseline
migrations. It exists because the bridge target cannot be asserted against
`schema.prisma`, which is 80 migrations further along.

Replaying the real migrations (instead of diffing straight to `schema.prisma`)
is the whole point: the 80 migrations carry data backfills, hard gates and
triggers that a schema diff would silently skip.

## 3. Files

| File | Purpose |
|---|---|
| `_safety.ps1` | write-target guard used by every script here |
| `00-cafe-discovery.sql` | read-only discovery for the live cafe (writes nothing) |
| `01-legacy-preflight.ts` | L01-L25: the data conditions that abort a migration |
| `build-ref-baseline.ps1` | builds the schema-equivalence target |
| `archive.sql` | pre-migration values -> `legacy_archive` |
| `bridge-00-enums.sql` / `bridge-10-additive.sql` / `bridge-30-contract.sql` | generated from a real clone, reviewed line by line, committed as the permanent record |
| `bridge-20-backfill.ts` | chart-of-accounts mapping + `MigrationReport.{json,md}` |
| `equivalence-check.ps1` | Prisma diff + a catalog diff for what Prisma cannot see |
| `fingerprint.ts` | counts, money, inventory, identifiers, per-column hashes, row-by-row compare, transformation proofs |
| `upgrade.ps1` | the driver: one run ID = one evidence dir + one `state.json`; refuses a re-used dir or a non-fresh target; resumable (`-Resume`) only for the same target and kit |
| `rollback.ps1` | switch-back drill; "what has the new system written since the boundary" (+ CSV export); Job 2 post-write switch-back (`-Production`) |
| `terminal-checklist.md` | per-terminal sheet (offline queue, service worker, printers) |
| `SIGNOFF.md` | gate sign-off sheet, M0-G13 + owner decisions (owner, due, evidence, signature) |
| `REHEARSAL-1-REPORT.md` | what rehearsal 1 and 2 actually produced |
| **Go-to-production** | |
| `PRODUCTION-RUNBOOK.md` | the operational addendum: gates, people, cutover day, rollback, monitoring |
| `_kit.ps1` | kit hash, git identity, run-ID evidence directories (read-only helpers) |
| `m0-release-freeze.ps1` | gate M0: clean tree, tag, kit + build hashes -> `release-manifest-<tag>.json` |
| `new-rehearsal.ps1` | gate G2: one fresh, fully evidenced rehearsal (clone, chain, numbering, restore + API boot, rollback drill) |
| `next-numbers.sql` | expected next invoice / receipt / payment / journal numbers from a given database + sequence safety |
| `uat-prepare.ps1` | test password/PIN for every user on a DISPOSABLE migrated copy (guarded) |
| `UAT-CHECKLIST.md` | gate G5: automated suite + interactive flows per role |
| `DRESS-REHEARSAL.md` | gate G9: the cafe's own hardware, service account, failure cases |
| `cutover.ps1` | Job 2 wrapper: preflight / freeze / backup / migrate / switch / accept / abort, two-person confirmations, no `-Force`; `-Rehearse` against clones |
| `cafe-config.template.json` | G0 answers the wrapper reads |
| `authorization.template.json` | machine-readable SIGNOFF (gates, signatures, decisions, approved mapping) |
| `reconcile.sql` / `reconcile.ps1` | Day 0 capture, Day 1/3/7/30 checks (history frozen, invariants, legacy watch items) |
| `REHEARSAL-LOG.md` | every rehearsal run since the kit got run IDs |
| `d19-cash-evidence.sql` | D19 decision support (read-only): drawer ledger make-up, non-cash booked to cash, cash that left the drawer per shift |
| `configure-payment-methods.ps1` | D21: explicit POS payment methods + `mobile_money`/`card_clearing` mappings via the reviewed repo script, guarded |
| `SYNC-AUDIT.md` | how every kind of legacy data reaches the new system, table by table, with evidence |

## 4. Running it

```powershell
$env:PGPASSWORD = '<postgres password>'

# 1. reference copy of the production backup (once)
createdb -U postgres -T template0 -E UTF8 cafe_reference_20260917
pg_restore -U postgres -d cafe_reference_20260917 --single-transaction --exit-on-error C:\POS-BACKUPS\2026-09-17\backup-Sep-17.dump
psql -U postgres -d postgres -c "alter database cafe_reference_20260917 set default_transaction_read_only = on"

# 2. equivalence target (rebuildable at any time)
.\build-ref-baseline.ps1 -Recreate

# 3. disposable workspace, cloned by dump+restore for reproducibility
pg_dump  -U postgres -Fc -f C:\POS-BACKUPS\work\reference.dump cafe_reference_20260917
createdb -U postgres -T template0 -E UTF8 cafe_migration_r1
pg_restore -U postgres -d cafe_migration_r1 --single-transaction --exit-on-error C:\POS-BACKUPS\work\reference.dump

# 4. the chain (a NEW run ID every time)
.\upgrade.ps1 -RunId rehearsal-2026-09-18-r6 -TargetDb cafe_migration_r1          # prompts at the mapping gate
.\upgrade.ps1 -RunId rehearsal-2026-09-18-r6 -TargetDb cafe_migration_r1 -Resume  # continue an interrupted run
```

Steps 3 and 4, plus numbering, the restore test and the rollback drill, are one
command:

```powershell
.\new-rehearsal.ps1 -RunId rehearsal-2026-09-18-r6 -ExpectMapping <approved-mapping.json> -WireParents -RollbackDrill
```

Every run writes to `C:\POS-BACKUPS\work\<RunId>\`: its own `state.json`,
`MigrationReport.*` and reports. A run ID that already has a `state.json` is
refused, so a completed state from an earlier run can never cause steps to be
skipped. There is no `state.json` in this directory any more.

After the chain, by hand: UAT against the migrated database
([UAT-CHECKLIST.md](UAT-CHECKLIST.md)) and the post-write rollback report.

```powershell
# restore test
pg_dump -U postgres -Fc -f C:\POS-BACKUPS\work\migrated-v2.dump cafe_migration_r1
createdb -U postgres -T template0 -E UTF8 cafe_v2_restore_test
pg_restore -U postgres -d cafe_v2_restore_test --single-transaction --exit-on-error C:\POS-BACKUPS\work\migrated-v2.dump

# rollback drills
.\rollback.ps1 -ReportV2Writes -TargetDb cafe_migration_r1 -Since '<cutover ISO timestamp>'
.\rollback.ps1 -Drill -LegacyDb cafe_rollback_test_r1 -OldInstall C:\projects\POS-CAFE-ABILIZ -OldPort 3004
```

## 5. The gates, and what each one proved in rehearsal

| Gate | Check | Rehearsal result |
|---|---|---|
| G1 / G1.5 | backup hash, restore, reference integrity | counts, 7 migration rows and posted totals match the dump exactly |
| G2 | equivalence vs `ref_baseline_20260727` | Prisma diff clean; 2,539 columns, 649 indexes, 1,872 constraints, 89 enums, 35 policies, 2 triggers, 174 RLS flags all match |
| G3 | one command, no manual steps | full chain green, ~35s on a 12.7 MB dump |
| G4 | fingerprint + transformation proofs | 0 unexpected differences; 0 changed rows in the eight financial tables |
| G6 | accounting | posted debit = credit = 202,416,000.000000, unchanged |
| G7 | inventory | per product x location quantities, values and on-hand unchanged; both NOT VALID checks validated against 10,055 rows |
| G8 | restore test | dump restores and the API boots against the restored copy |
| G9 | two clean rehearsals, sign-offs, timed rollback | rollback measured at 4.8s; the cafe dress rehearsal is still outstanding |

## 6. Migration history: what we do, and why

Production carries 7 rows that exist in no repository, two of which
(`20260708120000_add_modifier_admin_qr_cleaning`,
`20260708130000_add_accompanimentgroup_category_and_order_sortorder`) were
created on the cafe server itself. Their net effect is nil beyond
`schema.prisma`: the production schema matches the old `schema.prisma` exactly,
column for column and enum for enum.

The rule here is **preserve, never invent, never delete to silence a tool**:

1. `archive.sql` copies all 7 rows into `legacy_archive.prisma_migrations`.
2. `migrate resolve --applied` registers only the two baseline names.
3. `migrate deploy` then applies the remaining 80.

Rehearsal evidence: `migrate status` reports "The migrations from the database
are not found locally in prisma/migrations" and lists the 7 rows - and
`migrate deploy` still applies all 80 migrations successfully (7s). **No legacy
row is deleted.** The kit keeps the archive copy so that, if a future Prisma
version does refuse, removal is reversible and evidenced.

## 7. Timezone: investigated, not guessed

Three observations disagreed: the production dump renders `timestamptz` at
**-07**, the organization timezone is **Africa/Kampala**, and the dev databases
run **Africa/Nairobi (+03)**.

What the rehearsal established:

* `timestamptz` values are **identical instants**. The same migration row reads
  `2026-07-08 01:09:28-07` on the cafe server and `2026-07-08 11:09:28+03` here.
  Nothing is wrong with the stored data; only the display zone differs.
* The application writes **UTC** into the `timestamp without time zone` columns
  Prisma uses (the newest legacy order reads `17:02:40`, which is 20:02 Kampala).
* Raw SQL `now()` writes **server-local** time into those same columns. The
  Manager role created by `20260914000200` landed on `22:50:56` here, 2.9 hours
  ahead of UTC. On the cafe server the same statement would land 7 hours
  *behind* UTC.

Conclusion: set the new database's timezone to **UTC**, so raw-SQL writes agree
with the application's convention:

```sql
ALTER DATABASE cafe_pos_v2 SET timezone = 'UTC';
```

This is a per-database setting, so the legacy database is untouched. It affects
rows written by SQL (seeded config rows), never the financial history, and the
skew is pre-existing rather than introduced by the migration. Confirm in UAT
before adopting it, and record the result in `SIGNOFF.md`.

## 8. What 2026-08-r1 got wrong

| # | In 2026-08-r1 | Here |
|---|---|---|
| K1 | The backfill only considered template rows **with** a `categoryKey`, so the five group headers fell to the coarse type map and were given a category - then it demanded that no account be left uncategorized. A fresh install leaves group nodes `categoryId NULL`, `isPostable false` (`coa-seeder.ts:50-63`), and `coa-template.ts` states the invariant: `categoryKey === null` exactly when `isPostable === false`. | Template values are copied exactly, including `controlAccountType` (1300 `ar`, 1400 `inventory`, 2100 `ap`). The gate is "no **postable** account is uncategorized", and a second gate rejects a non-postable account that carries a category. |
| K2 | `history` registered 5 names; production has 7 legacy rows. | All 7 archived, 2 baseline names resolved, deploy proven to work with the rest in place. |
| K3 | Preflight queried `SyncOpDeadLetter` and `StockPostingJob`, which a v1.5.0 database does not have. | `01-legacy-preflight.ts` is written for the legacy vintage, and skips checks that do not apply to the schema in front of it. |
| K4 | `rollback.ps1` ran `pg_restore --clean` over the upgraded database - impossible once new tables and foreign keys exist. | Rollback is a switch-back; no restore over a live database, ever. |
| K5 | Health check hard-coded to port 3000. | `-ApiBase` / `-OldPort` parameters. |
| K6 | - | Restores use new database names and never `--create`/`--clean`, because this machine already has unrelated databases called `POS-CAFE` and `cafe-pos`. |

## 9. Never on the cafe database

`db:migrate` - `db:reset` - `prisma db push` - `db:seed` (deletes menu rows) -
`scripts/validate-production.ts` (writes real sales) - the unreviewed one-off
scripts in `apps/api/scripts/` - `SET app.evidence_purge='on'` outside a reviewed
script - `pg_restore --clean`/`--create` into a live database - deleting rows to
make a migration pass - the old `update-pos.ps1` - pointing the new build at
`POS-CAFE` - two applications on one database - committing a dump to git.
