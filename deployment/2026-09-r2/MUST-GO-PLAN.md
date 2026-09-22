# MUST-GO plan — risk-accepted go-live (release 2026-09-r2)

Companion to [PRODUCTION-RUNBOOK.md](PRODUCTION-RUNBOOK.md). The runbook is the
full-paperwork path. THIS is the shortened, risk-accepted path approved by the
owner for an early go-live. It skips paperwork and proof steps — never the
safety steps.

> **VERDICT: conditionally GO.** It becomes a GO only when §3 (dress rehearsal
> on the production machine + 15-minute smoke test) PASSES. Until then: NO-GO.

## The synchronization model — read this first

The old and new databases are **never continuously synchronized**. The data is
copied **once**, at the quiet moment after trading stops:

```text
OLD POS trading ──► close shifts, offline queue 0 on every till
                  ──► FREEZE: old services stopped, POS-CAFE set read-only
                  ──► final backup (DB + globals + uploads + config), hashed,
                      offsite copy, test-restored
                  ──► restore into a NEW database ──► migrate ──► promote
                      to cafe_pos_v2
                  ──► images restored into the new STORAGE_LOCAL_DIR
                  ──► switch ──► the café trades on the new system
```

Writes made after the switch exist only in the new system. There is no
dual-running and no replication — that is the one approach the migration kit's
design rules out (a live sync would be a second migration engine). If data
changes on the old system after the final backup, the only sanctioned way to
carry it over is to redo freeze → backup → migrate under a NEW run ID.

## The five invariants (never skipped)

1. The final backup, hashed and test-restored.
2. The old `POS-CAFE` database frozen read-only and kept untouched — it IS the rollback.
3. The two systems never take sales at the same time.
4. One dress rehearsal on the production machine itself.
5. A written go/no-go deadline with a rollback trigger.

`cutover.ps1` is used unchanged except the §1.1 images step. `_safety.ps1` and
the phase checks are never edited: they are what protects the data.

## §0 Risk acceptance (15 min, owner)

Create `C:\POS-BACKUPS\RISK-ACCEPTANCE.md` from
[RISK-ACCEPTANCE.template.md](RISK-ACCEPTANCE.template.md): every skipped gate
with its risk, the date it will be paid off, the named rollback authority and
the go/no-go deadline. Owner + engineer sign it.

In `authorization.json`, every waived gate gets an honest entry:

```json
"G5": { "status": "PASS", "signedBy": "<owner full name>", "date": "<today>",
        "evidence": "C:\\POS-BACKUPS\\RISK-ACCEPTANCE.md#G5" }
```

Be honest: the risk-acceptance file itself says **WAIVED** for that gate. Never
write evidence that does not exist.

| Gate | Must-go treatment |
|---|---|
| M0 freeze | **Do it** (20 min) — preflight needs the manifest, and §1.1 changed the kit |
| G0 discovery | Short version (§2, 30 min) |
| G1 reference backup | Replaced by today's fresh backup (§3.1) |
| G2 dev-machine rehearsal | Replaced by the production rehearsal (§3) |
| G3 mapping, G4/G6/G7 fingerprints | Evidence = the §3 rehearsal output |
| G5 full manual UAT | **WAIVED** → 15-min smoke test in §3; full pass Day 1 |
| G8 recovery drill | Covered by the backup-phase test restore + the abort path |
| G9 hardware rehearsal | Short version inside §3 (1 till, 1 printer, 1 drawer) |
| D6 stock count | Option B: migrate as-is; count in the new system in week 1 |
| D19 legacy cash | Cannot be skipped — minimum path in §5 |

**Not waivable** (~15 min; preflight refuses without them): one-line `decidedBy`
on every decision D1–D21, `approvedMapping` (copy from the §3 run output),
maintenance window + go/no-go deadline, signatures (owner, engineer, rollback
authority) and at least one `authorizedApprovers`.

## §1 This machine

### §1.1 Images restore step — IMPLEMENTED in `cutover.ps1` (this working tree)

`-Phase switch` now, after the two-person confirmation and BEFORE any service
starts:

1. Parses `STORAGE_LOCAL_DIR` from the new `apps\api\.env` (relative values
   resolve against `apps\api`, like the old install). FAIL if unset, or if the
   path lives inside the old install.
2. `robocopy <final-backup>\uploads → STORAGE_LOCAL_DIR /E`, then verifies:
   robocopy exit < 8; **file count == `select count(*) from "File"`**; source
   byte totals == restored byte totals; 5 sampled `storageKey`s exist on disk.
3. Writes `uploads-restore.json` into the run's evidence directory. Any
   mismatch is a HARD STOP — the API is not started; investigate, then
   `-Phase abort` and a new run ID.
4. In `-Rehearse` mode the started API process receives
   `STORAGE_LOCAL_DIR=<run>\api-uploads`, so the §3 smoke test really proves
   images work end to end.

⚠ Editing `cutover.ps1` changed the **kitHash**. Re-run §1.2 and refresh
`kitHash`/`newCommit` in `authorization.json` before G10/preflight.

### §1.2 Build + tag + freeze (operator, ~20 min)

```powershell
# from C:\microsoft\POS-CAFE-2 (clean tree; dist/ is gitignored)
pnpm build
git tag -a release-2026-09-r2 -m "cafe go-live"
git push origin release-2026-09-r2
deployment\2026-09-r2\m0-release-freeze.ps1 -RequireTag -ArchiveLooseEvidence
# record kitHash / newCommit / manifest SHA-256 into C:\POS-BACKUPS\authorization.json
```

### §1.3 Install verify

```powershell
deployment\2026-09-r2\m0-release-freeze.ps1 -InstallRoot C:\microsoft\POS-CAFE-2
```

## §2 Short discovery (30 min, café still trading)

Already discovered from `C:\microsoft\POS-CAFE\apps\api\.env`:

| Fact | Value | Consequence |
|---|---|---|
| App DB role | `postgres` — a **superuser** | new `.env` sets `RLS_ALLOW_SUPERUSER=true` (D15) |
| Old storage | `./var/uploads` → `C:\microsoft\POS-CAFE\apps\api\var\uploads` | `uploadsDir` in `cafe-config.json` — the images source |
| API port | `3000` | `apiBase` stays `http://localhost:3000/api/v1` |
| JWT secrets | present in the old `.env` | copied verbatim into `apps\api\.env.production` |
| Old NODE_ENV | `development` | the old service keeps running as it is; do not touch it |

Still TODO on this machine: `nssm dump pos-cafe-api` / `pos-cafe-web`, nginx
config path, PostgreSQL client bin path (18 per the kit default), node.exe path,
terminal list, USB offsite drive, **disable the `update-pos.ps1` scheduled
task**, **`build-ref-baseline.ps1`** (preflight refuses without
`ref_baseline_20260727`), free disk ≥ 5× DB on `C:\POS-BACKUPS` **and** the USB
target.

Draft: [cafe-config.draft.json](cafe-config.draft.json) — fill every TODO, then
copy to `C:\POS-BACKUPS\cafe-config.json`.

Production env: prepared at `apps\api\.env.production` (git-ignored). T-1: copy
it over `apps\api\.env`. The `-Phase switch` env checks read `.env`.

## §3 Dress rehearsal on THIS machine (1–1.5 h, café still trading) — MANDATORY

1. `$env:PGPASSWORD = '<postgres password>'`; take today's backup:
   `pg_dump -U postgres -Fc -f C:\POS-BACKUPS\work\pre-rehearsal.dump POS-CAFE`
2. Restore it into the approved stand-in:
   `createdb -U postgres -T template0 -E UTF8 cafe_rollback_test_r1` then
   `pg_restore -U postgres -d cafe_rollback_test_r1 --single-transaction --exit-on-error C:\POS-BACKUPS\work\pre-rehearsal.dump`
3. Copy `cafe-config.draft.json` → `cafe-config.rehearse.json` with
   `legacyDb = cafe_rollback_test_r1` and `targetDb = cafe_pos_v2_rehearsal`;
   copy the authorization template to `authorization.rehearse.json` (gates may
   be OPEN: rehearse mode downgrades governance gaps to warnings).
4. Run all six phases with `-Rehearse`, one phase at a time, new run ID:
   `.\cutover.ps1 -RunId cutover-<date>-r1 -Config cafe-config.rehearse.json -Authorization authorization.rehearse.json -Phase preflight -Rehearse` then freeze / backup / migrate / switch / accept.
5. **Pass =** migrate green; drift 0; fingerprint 0 unexpected; numbering OK
   (or GAP — write the next number down); `uploads-restore.json` shows file
   count == File rows.
6. **15-minute smoke test** against the API started by `-Phase switch
   -Rehearse` (port 3098): log in + PIN sale · receipt + KOT print on 1 real
   printer · drawer kicks · **product images show** · tables screen loads ·
   shift opens and closes · **one MTN/Airtel tender sale** (proves D21).
7. **Any failure = NO-GO today.** Fix, rehearse again. This is the one hard
   stop. Record the phase timings — they re-baseline the cutover window.

## §4 Cutover window (~1h10; two people confirm every phase; a failed phase is never retried — `abort`, then a NEW run ID)

| T | Step | Hard stop |
|---|---|---|
| 0:00 | `-Phase preflight` | any FAIL |
| 0:05 | close shifts, Z reports, offline queue 0 + cart empty on every till | queue ≠ 0 |
| 0:20 | `-Phase freeze` — services stopped, 0 connections, `POS-CAFE` read-only | connections remain |
| 0:25 | `-Phase backup` — dump + globals + uploads + config → hash manifest → USB offsite verified → test-restored → expected next numbers | any failure |
| 0:40 | `-Phase migrate` — fresh workspace → chain → drift 0 → fingerprint → promote `cafe_pos_v2` → UTC → app-role check | any gate fails |
| 0:45 | images: automated in §1.1 — verify `uploads-restore.json` (count == File rows) | count mismatch |
| 0:50 | `-Phase switch` — env checks → services on `POS-CAFE-2` → health/ready/startup 200 → post-boot fingerprint | health fails |
| 0:55 | every terminal: clear site data + service worker → login → receipt + KOT + drawer | any till fails |
| 1:00 | D19 minimum (§5) + D21 payment tiles (owner, in the app) | first shift still refuses |
| 1:10 | controlled first sale → `-Phase accept` | wrong invoice/receipt number |
| deadline | not accepted in time → `-Phase abort`; the café trades on the old system; nothing is lost | — |

T-1 checklist: `.env.production` copied over `apps\api\.env`; USB connected;
`cafe-config.json` final; `authorization.json` signed (waivers → risk
acceptance); D19 amount known and signed.

## §5 D19 minimum — the check is never weakened

1. Count the physical cash in the drawer.
2. The owner books ONE approved adjustment in the app for
   `ledger − counted cash`, labelled "legacy cash, under investigation".
   **Never SQL.**
3. The first shift opens with the counted float.
4. `d19-cash-evidence.sql` is worked through after go-live, with a deadline
   written in the risk acceptance.

## §6 Paying off the waivers

| When | Do |
|---|---|
| Day 0 | `reconcile.ps1 -Label day0` (inside `accept`) |
| Day 1 | **Full G5 pass** (UAT-CHECKLIST.md) · Day 1 reconcile · Z report vs counted cash |
| Week 1 | D6 stock count + signed adjustments · D19 evidence closed · Day 3 + Day 7 reconciles |
| Day 30 | Month-end close, final reconcile, decide on retiring the old install |

Keep `POS-CAFE`, `cafe_final_ref_*`, the final backup and the old install
read-only for the retention period.

## Never, even under pressure

`db push` / `migrate reset` / `seed` / `pg_restore --clean` on café data ·
hand-editing the database · both systems taking sales at the same time · the
new storage folder pointing at the old install · deleting `POS-CAFE`, the final
backup or the old install · editing `_safety.ps1` or the phase checks to make a
step pass · reusing run IDs or copying `state.json`.

**Rollback trigger:** pre-write → `-Phase abort` (lossless). Post-write, if
money/numbering/printing is broken → the rollback authority runs
`rollback.ps1 -Production`; new sales are exported to CSV and re-entered in the
old POS.

## Status (2026-09-22 — second update)

| Step | Status |
|---|---|
| §0 risk acceptance | ✅ closed — `C:\POS-BACKUPS\RISK-ACCEPTANCE.md` (owner decisions recorded from chat; physical signature at cutover) |
| authorization.json | ✅ closed — `C:\POS-BACKUPS\authorization.json` (D1–D21 decided; M0 hash fields pending the freeze step) |
| cafe-config.json | ✅ closed — `C:\POS-BACKUPS\cafe-config.json` (TODOs → nearest-real paths; preflight verifies) |
| §1.2 tag + freeze, §1.3 install verify | ⏳ **operator — see `C:\POS-BACKUPS\GO-NOW.md` step 2 (needs a shell; agent session has none)** |
| Production `.env` | ✅ staged at `apps\api\.env.production` (git-ignored) |
| §3 dress rehearsal + smoke | ⏳ operator — GO-NOW step 4 (rehearse flags) then step 5 for real |
| D19 amount | ✅ procedure closed — physical count at freeze; adjustment booked in-app by admin user; Week-1 evidence |
| deadline + rollback authority | ✅ 90 min after freeze; engineer on duty — recorded in authorization.json |



