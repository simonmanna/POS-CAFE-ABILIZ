# Go-to-production runbook: café v1.5.0 → current main (release 2026-09-r2)

This is an operational addendum to [README.md](README.md). It does not redesign
the migration. It takes the proven migration method and turns it into a release
and cutover process that people can execute and sign.

| Area | Status | Evidence |
|---|---|---|
| Migration design, data preservation | 🟢 | r1, r2, r5, r6: fingerprint 0 unexpected, 8 financial tables row by row |
| Fresh rehearsal, restore test, rollback A/B | 🟢 | `REHEARSAL-LOG.md` |
| Number continuity | 🟢 proven under use | first new invoice `INV-2026-004136`, receipt `RCT-008200` (Sept 17 data) |
| Automated regression | 🟢 | POS suite 690/690 (r6); `validate-production.ts` up to date: 20 pass, 0 defects on the cutover target |
| Cutover automation (Job 2) | 🟢 rehearsed | all six phases against disposable clones |
| Data synchronization audit | 🟢 | [SYNC-AUDIT.md](SYNC-AUDIT.md) |
| G0 café discovery | 🔴 | needs the café machine |
| **D19 legacy cash balance** | 🔴 **critical** | evidence report ready (`d19-cash-evidence.sql`); needs the owner's evidence and signature |
| D6 stock, D1–D21 sign-off | 🔴 | `SIGNOFF.md` |
| G5 manual UAT | 🔴 | café users, `UAT-CHECKLIST.md` |
| G9 hardware rehearsal | ⏸ deferred | development machine; **still mandatory before G10** |
| M0 release freeze | ⏳ | after G0, decisions, UAT, G9 and final fixes |
| Production cutover | ⛔ not yet | |

**Governing principle.** AI and scripts prepare, validate, rehearse and produce
evidence. A named person authorizes the final backup, the production migration,
go-live and any rollback. Every one of those steps in `cutover.ps1` needs two
different named people and a typed confirmation phrase.

---

## 1. What does not change

These decisions come from the rehearsed plan and still hold:

- Bridge → backfill → equivalence → mark baseline → replay the 80 real migrations.
- All 7 legacy `_prisma_migrations` rows are kept. They are also archived in `legacy_archive`.
- The migration runs on a **restored copy** in a **new** database. The legacy `POS-CAFE` database is only read, then frozen read-only. It stays untouched and is the rollback.
- IDs and historical transactions are kept exactly as they are.
- Fingerprints and row-by-row financial comparisons. Zero unexplained differences.
- Zero schema drift against `schema.prisma`.
- Never run `db push`, `migrate reset`, `seed` or `pg_restore --clean/--create` on café data.
- There are two rollback procedures: one before the new system writes anything, one after.

## 2. People

Record every name in `authorization.json` and `SIGNOFF.md`. A role cannot be
filled by "the team".

| Role | Does | Minimum |
|---|---|---|
| **Owner** | makes the café-data decisions, signs G3/G5/G6/G7/G10/G13, is an approver | 1 named person |
| **Engineer** | runs the kit, produces the evidence, signs M0/G0–G4/G8 | 1 named person |
| **Rollback authority** | the only person who can start a post-write rollback | named; may be the owner |
| **Approver** (`authorizedApprovers`) | the second person on every `cutover.ps1` confirmation | at least 1 person besides the operator |
| **Operator** | types the commands during the window | the engineer |
| **Shift lead** | owns the terminal sheets, stops trading, runs the controlled sale | café staff |

## 3. Gate sequence

Each gate is signed against **evidence on disk**, never from memory. The
machine-readable copy is `authorization.json` (template:
[authorization.template.json](authorization.template.json)). `cutover.ps1`
will not start unless M0–G10 are recorded there as `PASS`, each with a signer,
a date and an evidence path.

| Gate | Passes when | Tool / evidence | Signs |
|---|---|---|---|
| **M0 Release freeze** | exact old (`e91fb5b`) and new commits recorded; migration kit committed; clean tree; release tag; builds hashed; earlier evidence archived; no feature work left on the branch | `m0-release-freeze.ps1 -RequireTag` → `release-manifest-<tag>.json` | Engineer |
| **G0 Café discovery** | production infrastructure, DB role and RLS posture, timezone, uploads, services, printers, terminals, network and background jobs documented. **Done before any production preparation or configuration change** | `00-cafe-discovery.sql` (read-only) + §5 walk-through → `cafe-config.json` | Engineer + Owner |
| **G1 Reference backup** | Sept 17 backup protected, hashed, copied offsite, restored | `REHEARSAL-1-REPORT.md` §1–2 (PASS) + offsite copy | Engineer |
| **G2 Fresh rehearsal** | a fresh clone runs the whole chain under a **new run ID**, with no manual database repair | `new-rehearsal.ps1` → `<run>\run-summary.json` | Engineer |
| **G3 Data mapping** | the 29-account mapping and every transformation approved by name | `MigrationReport.md`, `transformations.json`, decisions D1/D2 | Owner |
| **G4 Historical integrity** | protected tables: 0 missing, 0 unexplained changes | `fingerprint.json` (0 unexpected, 8 tables row by row) | Engineer |
| **G5 Application UAT** | every POS, payment, cash, inventory, accounting and reporting flow passes on the migrated copy | [UAT-CHECKLIST.md](UAT-CHECKLIST.md), `uat-results.json` | Owner + Engineer |
| **G6 Accounting** | historical posted debit/credit and account × period results identical | `fingerprint.json` `money.*` | Owner |
| **G7 Inventory** | migration fingerprints match; every known legacy discrepancy has a signed resolution (§9) | `fingerprint.json` `inventory`, D5/D6 | Owner |
| **G8 Recovery** | the migrated DB backs up and restores; rollback A (pre-write) and B (post-write) demonstrated | `restore-test.txt`, `rollback-test.txt`, post-write drill | Engineer |
| **G9 Hardware dress rehearsal** | real terminals, printers, drawer, network, service account and failure cases pass **at the café** | [DRESS-REHEARSAL.md](DRESS-REHEARSAL.md) | Owner + Engineer |
| **G10 Production authorization** | owner and engineer sign; window approved; rollback authority named; wrapper version/hash recorded; final-backup destinations available | `authorization.json`, `cutover.ps1 -Phase preflight` | Owner + Engineer |
| **G11 Final backup** | trading stopped; offline queues 0; open state 0; API stopped; 0 connections; DB + globals + uploads + config + service settings backed up; hashes verified; offsite copy verified; the final dump restores | `cutover.ps1 -Phase freeze`, `-Phase backup` | Operator + Approver |
| **G12 Production migration** | chain completes; no blocker; no drift; 0 unexpected fingerprint differences; numbering equal; app role has access | `cutover.ps1 -Phase migrate` | Operator + Approver |
| **G13 Go-live acceptance** | services, terminals, printers, numbering and the controlled transaction work end to end; Day 0 reconciliation captured | `cutover.ps1 -Phase switch`, `-Phase accept` | Owner |

### Order of work

The gate numbers name what must be proven. They are **not** the order of work.
M0 freezes the release, so it comes after everything that could still force a
code or kit change: G0 findings, the owner decisions, UAT and the hardware
rehearsal.

```text
Build + rehearse Job 2 wrapper against clones      ← done
        ↓
G0 café discovery (read-only)
        ↓
Resolve D19 (with evidence), D6, then the rest of D1–D21
        ↓
Fresh rehearsal on the latest café backup (new-rehearsal.ps1)
        ↓
G5 manual UAT by café users
        ↓
G9 hardware rehearsal at the café (cutover.ps1 -Rehearse on the café server)
        ↓
Final fixes → one more fresh rehearsal if anything changed
        ↓
M0 release freeze + tag  →  G10 signatures
        ↓
Cutover: G11 final quiet-state backup → G12 migrate → G13 accept
```

Building the wrapper and approving it are separate events: it may be built and
tested any time, but it is only authorized for production by G10.

### Decision priority

| Class | Decisions | Rule |
|---|---|---|
| 🔴 must be resolved before cutover | D19 cash balance, D6 stock count, D12 admin password, D13 backups, D11 timezone, D14 feature flags, D15 RLS posture, D18 window/authority, D21 payment methods | preflight refuses without them |
| 🟡 confirmed during UAT | D20 cashier register access, D9 Manager role, D2 account hierarchy, printers, terminals | a UAT row names each one |
| 🟢 deferred / disabled | manufacturing, rental, repairs, HR, messaging, assets, tasks (`ENABLE_*=false`) | never switched on at cutover; one at a time afterwards |

## 4. M0: release freeze

1. Finish every code change. Nothing is merged into the release after this point.
2. Commit the kit (`deployment/2026-09-r2/`), the `.gitignore` change and the 2026-08-r1 superseded notice.
3. `pnpm build` from the frozen commit.
4. `git tag -a release-2026-09-r2 -m "cafe migration release"`.
5. Run the freeze check:
   ```powershell
   .\m0-release-freeze.ps1 -RequireTag -ArchiveLooseEvidence
   ```
   It fails on a dirty tree, a missing tag, a missing build, or loose evidence files.
6. Record the manifest path and its SHA-256 in `SIGNOFF.md` and `authorization.json` (`kitHash`, `newCommit`).
7. Any later change to a kit file changes `kitHash`. `cutover.ps1 -Phase preflight` then refuses to run, and M0, G2 and G10 have to be done again.

The old deployed application (`C:\microsoft\POS-CAFE`, legacy commit `e91fb5b`)
is **preserved as it is**. It is the rollback, so it is never updated,
overwritten or reused for the new build. The new build goes into its own
directory (`C:\microsoft\POS-CAFE-v2`). Its hashes must match the manifest:

```powershell
.\m0-release-freeze.ps1 -InstallRoot C:\microsoft\POS-CAFE-v2   # on the café machine
```

## 5. G0: café discovery (before any production change)

These steps are read-only. Nothing on the café machine is configured or installed yet.

```powershell
psql -U <app role> -d POS-CAFE -f 00-cafe-discovery.sql > C:\POS-BACKUPS\discovery\discovery-<date>.txt
```

Run it once as the **application's own role** (from `DATABASE_URL` in the old
`.env`) and once as `postgres`. Then answer every row below in `cafe-config.json`:

| Item | Where | Why it matters |
|---|---|---|
| App DB role; `rolsuper`, `rolbypassrls` | discovery §2 | The new API **refuses to boot in production as a superuser** unless `RLS_ALLOW_SUPERUSER=true` (`prisma.service.ts`). Record the posture (§11). |
| Table owner | discovery §3 | The migration runs as `postgres`. `cutover.ps1` checks afterwards that `appDbRole` can read and write every table. If the app role is not the owner or a superuser, rehearse that setup in G9. |
| Timezone | discovery §1 | Evidence for decision D11 (`UTC` on the new database) |
| 7 migration rows and the 2 café-only migration folders | discovery §4, `C:\microsoft\POS-CAFE\apps\api\prisma\migrations` | Archive completeness |
| Open state | discovery §7 | Shows what must be closed on cutover day |
| Next numbers | `next-numbers.sql` | The method, **not** the final values (§8) |
| Services | `nssm dump pos-cafe-api`, `nssm dump pos-cafe-web`, `sc qc` | `ObjectName` (the printer owner), `AppDirectory`, `Application`, `AppParameters` → `newServices` |
| nginx | `nginx.conf` | Whether the web root or upstream changes (`nginxReload`) |
| Uploads | `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR` in the old `.env` | `uploadsDir`; `File` has 91 rows |
| Config files | old `.env` files, nginx, NSSM | `configFiles` (goes into the final backup) |
| Terminals | walk the café | `terminals`: every till, KDS and manager PC with a POS tab |
| Printers, drawer | per terminal | receipt / KOT printer names, drawer kick method |
| Network | café LAN / Wi-Fi, static IP of the server | terminals must reach the new build on the same origin |
| Background jobs | Task Scheduler, NSSM, old backup scripts | anything that writes to `POS-CAFE` must be stopped in G11 |
| Disk space | server drives + offsite medium | at least 5 × DB size + 512 MB on each |
| Old update script | `scripts/update-pos.ps1` | **Disable it.** It pulls `origin/main` and restarts the till. |

## 6. G2: fresh rehearsal (repeatable, one command)

Each rehearsal gets a **new run ID, a new evidence directory, a freshly recreated
workspace and a fresh `state.json`**. A run ID can never be reused:
`upgrade.ps1` refuses a directory that already contains a `state.json`, and
`-Resume` only works when the target and the kit hash are unchanged.

```powershell
$env:PGPASSWORD = '<postgres password>'
.\new-rehearsal.ps1 -RunId rehearsal-2026-09-18-r4 -ExpectMapping <approved-mapping.json> -WireParents -RollbackDrill
```

Evidence layout:

```text
C:\POS-BACKUPS\work\rehearsal-2026-09-18-r4\
  run-summary.json          every step, timing, hashes, verdict
  state.json                chain journal (runId, kitHash, gitCommit)
  reference.dump            clone source, hashed
  preflight-pre.json / preflight-postb.json
  MigrationReport.json/.md  mapping evidence for THIS run
  migrate-status.txt / migrate-deploy.log
  ledger-constraints.json / release-preflight.json
  fingerprint.json / transformations.json
  next-numbers-reference.txt / next-numbers-migrated.txt
  migrated-v2.dump / restore-test.txt / restore-api-boot.log
  rollback-test.txt
  uat-credentials.txt / uat-results.json   (after UAT)
```

When a step fails, record it, fix the kit, and start again with a **new** run ID.
Never repair a database by hand.

## 7. G5: UAT on the migrated copy

```powershell
.\uat-prepare.ps1 -TargetDb cafe_migration_r1 -RunId <run>   # every user: password 1234, PIN 1234 (DISPOSABLE COPY ONLY)
```

Then follow [UAT-CHECKLIST.md](UAT-CHECKLIST.md). It has two parts: the
automated pipeline suite (`scripts/validate-production.ts`, which writes real
sales and so runs on the copy only) and the interactive flows for every role.
The live café keeps its real credentials. The only production credential change
is D12: the owner changes `admin@demo.test` in the application.

## 8. Number continuity

`INV-2026-004136` and `RCT-008200` were correct for the **17 September**
backup, and they are reproduced by `next-numbers.sql` in rehearsal r4. They are
**not** the cutover expectation. The café keeps trading, so the rule is:

```text
expected next invoice = maximum valid invoice number in the FINAL backup + 1
expected next receipt = maximum valid receipt number in the FINAL backup + 1
```

`cutover.ps1 -Phase backup` computes both from the restored final backup and
writes them to `expected-next-numbers.json`. `-Phase migrate` proves they are
the same after migration. `-Phase accept` checks the printed numbers of the
controlled sale against them.

| Status | Meaning | Action |
|---|---|---|
| `OK` | sequence = max used | the next number is `expected_next` |
| `GAP` | sequence is ahead (an earlier rolled-back write reserved a number) | the next number is `sequence_next`. Write it down before go-live; it is not a defect |
| `BLOCKER` / `MISSING` | the sequence is behind or absent, so the new system would issue duplicates | **stop** |

## 9. Inventory: preservation is not correction

Two separate things:

- **Migration preservation.** Reproduce the legacy stock state exactly. G7 proves this with the fingerprint.
- **Operational correction.** A physical count, then signed adjustments.

Pick one of these options for decision D6:

| Option | When | Steps |
|---|---|---|
| **A (preferred)** | the count can be done before the final backup | count in the OLD POS, post the adjustments there, then take the final backup. The café opens on the new system with a clean opening state. |
| **B** | the count cannot be done in time | 1) migrate the existing state unchanged; 2) record the known discrepancies (41 drifts, 62 negative items, inventory GL 0.00 vs sub-ledger 2,275,800); 3) count in the new system; 4) post signed inventory and GL adjustments through the normal workflows |

Historical inventory rows are **never** edited to make totals look right.

## 10. The controlled first transaction

The first production sale is a real, auditable transaction. It is **never
deleted** from the database. Do one of these:

- keep it as a genuine paid sale; or
- refund or void it through the normal application workflow, with a written reason.

Its order, invoice, payment, receipt, journal and inventory rows all stay.

## 11. Security and RLS

G0 records whether the API connects as the database owner or a superuser, in
which case RLS is bypassed. This matters, but changing the API's database role
**at the same time as** the historical migration adds a second failure
dimension. Pick one:

- keep the role configuration that was rehearsed (`RLS_ALLOW_SUPERUSER=true` if it is a superuser) for the cutover, and schedule RLS hardening as a separate, separately rehearsed release; or
- rehearse the least-privilege role (`scripts/setup-rls-role.ts`) through the whole migration, UAT, printing and rollback, all in G9.

Do not switch roles for the first time during the production cutover. Record the
choice as decision `rlsPosture`.

## 12. Cutover day

Before the window (T-1):

- [ ] G10 signed; `authorization.json` complete; the approvers are on site
- [ ] new build installed in `C:\microsoft\POS-CAFE-v2`, hashes match M0
- [ ] new `.env` prepared: `DATABASE_URL` → `cafe_pos_v2`, `NODE_ENV=production`, `BACKUP_DIR`, `RLS_ALLOW_SUPERUSER` per `rlsPosture`, every `ENABLE_*=false`, JWT secrets **copied from the old `.env`** (otherwise every logged-in device is signed out)
- [ ] `ref_baseline_20260727` built on the café server (`build-ref-baseline.ps1`)
- [ ] offsite medium connected; `cafe-config.json` final
- [ ] if D6 option A: stock count and adjustments done in the OLD POS
- [ ] 22 KDS tickets and any open orders resolved in the OLD POS (D3)
- [ ] old `update-pos.ps1` scheduled task disabled
- [ ] **D19 evidence ready**: discovery §10 drawer ledger per register, the physical float to open with, and the owner's record of where the rest went (bank slips, drawings). Amount = ledger in the FINAL backup − physical float

The window (the times assume the ~40 s chain seen in rehearsal; the café
machine's own timings come from G9):

| T | Step | Command | Stop condition |
|---|---|---|---|
| 0:00 | preflight | `.\cutover.ps1 -RunId cutover-<date>-r1 -Config ... -Authorization ... -Phase preflight` | any FAIL: nothing has changed, trade on as normal |
| 0:05 | shift lead closes every shift, prints Z reports, checks every terminal's BEFORE sheet ([terminal-checklist.md](terminal-checklist.md)) | – | offline queue ≠ 0 on any till |
| 0:20 | **freeze** (two people) | `-Phase freeze` | open state ≠ 0, services not stopped, connections remain |
| 0:25 | **backup** | `-Phase backup` | dump or restore fails, hash mismatch, offsite copy fails, numbering BLOCKER |
| 0:40 | **migrate** (two people) | `-Phase migrate` | any chain gate, fingerprint, numbering, app-role access |
| 0:50 | **switch** (two people) | `-Phase switch` | env check, health/ready/startup, post-boot fingerprint |
| 0:55 | every terminal: AFTER sheet (clear site data, new build, login, register, receipt, KOT, drawer) | – | any terminal fails |
| 1:00 | **D19**: owner records the legacy drawer cash in the app (Money & Accounts → bank the last closed legacy shift, or treasury transfer) until the drawer ledger = physical float; then the first shift opens with that float | app, owner login | the first shift still refuses: stop, do not work around it |
| 1:05 | **D21**: deactivate any payment tile the café does not use (Card, Bank) in the app, so cashiers declare only Cash, MTN and Airtel at close | app, owner login | — |
| 1:10 | controlled first sale, then **accept** (two people) | `-Phase accept` | wrong number, broken posting chain, Day 0 findings |
| — | **go/no-go deadline** (`maintenanceWindow.goNoGoDeadline`) | if not accepted by then: `-Phase abort` | — |

Every phase runs **once** per run ID and needs the phase before it to have
PASSED. There is no `-Force`. After a failure, `-Phase abort`, investigate, and
use a new run ID.

### D19: why the first shift needs it

The legacy system never booked cash leaving the drawer, so `1100 Cash` holds
every cash receipt since 2026-07-04 (101,723,000 on 17 September, posted +
reversed entries). The new system only opens a shift when the counted float is
not below the drawer ledger. **The new cash control is not weakened and the
migration is not changed to hide this.** It is a historical accounting fact the
owner resolves with evidence.

The question D19 answers: *where did the money recorded in the old Cash account
actually go?*

```text
legacy drawer ledger (FINAL backup)        L
  = cash banked                            X   bank slips / statements
  + cash taken by the owner / transferred  Y   drawings book, transfer records
  + other documented cash outflows         Z   supplier paid in cash, expenses (receipts)
  + non-cash booked to the drawer          N   mobile money booked to 1100 (311,000 on Sept 17)
  + physical cash on hand at cutover       R   counted float
  + unexplained                            U   must be 0, or written off by an approved adjustment
```

Procedure:

1. `psql -X -A -F ',' -d <final ref or POS-CAFE> -f d19-cash-evidence.sql > d19-evidence.csv` (read-only).
   Section D lists every shift with the cash that left the drawer after it
   (`counted at close − next opening float`), with `evidence_ref` and
   `destination` columns for the owner to fill. On Sept 17 data: 54 counted
   shifts, 99,232,000 left the drawer, none of it booked.
2. The owner matches every row to evidence and fills the D19 worksheet in `SIGNOFF.md`.
3. Only evidenced amounts are recorded, **in the new application**, before the
   first shift: bank deposits (`Money & Accounts` → bank a closed legacy shift),
   transfers to the owner/other accounts (treasury transfer), and an approved
   adjustment for N and U. Never SQL.
4. The first shift then opens with the counted float R.

Rehearsed mechanically in cutover r4 with a demo deposit (`REHEARSAL-LOG.md`
F1). That proves the workflow, not what happened to the café's money.

## 13. Rollback

| Situation | Procedure | Loss |
|---|---|---|
| **Before new writes** (anything up to `switch`, or `switch` with 0 V2 business rows) | `cutover.ps1 -Phase abort`: restore the old service settings, make the legacy DB writable, start the old services, check health | none. `POS-CAFE` was frozen, never modified |
| **After new writes** | `rollback.ps1 -Production -RunId ... -Config ... -Authorization ...`: only the named rollback authority plus a witness. 1) stop **both** systems; 2) export every V2 write to CSV (`-ReportV2Writes -ExportDir`); 3) the authority approves the re-entry plan; 4) old services back, legacy writable, health; 5) re-enter every exported row in the old POS, citing its V2 number; 6) reconcile cash and sales by method | none if the re-entry is complete; it has to be evidenced |

Both procedures:

- The old and new systems **never trade at the same time**.
- Clear browser storage and service workers on **every terminal**, both at cutover and at rollback (see [terminal-checklist.md](terminal-checklist.md)). The shared IndexedDB `pos-offline-queue` would otherwise replay sales into the wrong system.
- The new database, the final reference and the final backup are **kept for forensics** and never dropped.

## 14. Monitoring after go-live

`reconcile.ps1` is read-only. Day 0 captures the frozen history. Every later
check fails if a single historical number moved.

```powershell
.\reconcile.ps1 -Database cafe_pos_v2 -Boundary '<switchedAtUtc>' -Label day1 -EvidenceDir C:\POS-BACKUPS\cutover\<run>
```

| When | Who | Checks |
|---|---|---|
| **Day 0** (in `accept`) | Engineer | history captured; invariants 0 |
| **End of Day 1** | Engineer + Owner | history unchanged; debit = credit; no unbalanced entry; no duplicate or gapped numbers; every paid invoice has a receipt and a journal; no stuck stock-posting job; no open sync dead letter; shifts closed and reconciled; Z report vs counted cash; negative stock and drift not growing |
| **Day 3** | Engineer | the same + first backup produced by the new backup module restores |
| **Day 7** | Owner | the same + weekly P&L and trial balance reviewed; D5/D6 adjustments posted and signed |
| **Day 30** | Owner + Engineer | the same + month-end close; decide to retire the old install (keep `POS-CAFE` and the final backup read-only for the retention period) |

Exit code 1 (FINDING) means escalate the same day. Exit code 2 (WATCH) means a
legacy condition grew: investigate before the next check.

## 15. Never

Everything in README §9, plus:

- run `cutover.ps1` without a signed `authorization.json`;
- edit `authorization.json` after preflight;
- reuse a run ID or copy a `state.json` between runs;
- weaken `_safety.ps1` or the approved-database lists to make a production step pass. Job 2 uses its own wrapper;
- change the API database role or turn on `ENABLE_*` flags during the cutover window;
- delete the controlled sale, or any other row, to tidy up;
- drop `POS-CAFE`, `cafe_final_ref_*`, `cafe_pos_v2` or a final backup during the retention period.
