# Rehearsal log

Each run has its own run ID and evidence directory. Runs from before run IDs
existed (r1 and r2 on 2026-09-17) are described in `REHEARSAL-1-REPORT.md`, and
their loose evidence has been archived to
`C:\POS-BACKUPS\work\archive-pre-m0-20260918-082821\`.

Source for every run: `backup-Sep-17.dump`, SHA-256 `1a4d13e7…0465` (verified
against its sidecar before each run). The live café was never touched.

## Summary

| Run | Date | Kind | Result | Why |
|---|---|---|---|---|
| rehearsal-2026-09-18-r3 | 09-18 | G2 | **failed (kit)** | `git status` wrote a warning to stderr, and Windows PowerShell 5.1 made it terminating. Fixed in `_kit.ps1`. The directory is kept and the run ID burned (as designed) |
| rehearsal-2026-09-18-r4 | 09-18 | G2 | **failed (kit)** | the run was launched with `*>&1` redirection, so a Prisma deprecation warning on stderr became terminating. Fixed: the scripts now log with `Start-Transcript` and must not be redirected |
| **rehearsal-2026-09-18-r5** | 09-18 | G2/G4/G6/G7/G8 + UAT | **PASS** | below |
| cutover-2026-09-18-r1 | 09-18 | Job 2 `-Rehearse` | preflight refused | technical: not enough free disk under the old threshold (5×DB + 2 GB); threshold is now 5×DB + 512 MB |
| cutover-2026-09-18-r2 | 09-18 | Job 2 `-Rehearse` | **freeze refused → abort PASS** | legacy open state: 1 open shift, 5 open orders, 22 KDS tickets. The gate worked as intended |
| cutover-2026-09-18-r3 | 09-18 | Job 2 `-Rehearse` | backup failed → abort | kit bug: config-file names with `/` were not flattened. Fixed |
| **cutover-2026-09-18-r4** | 09-18 | Job 2 `-Rehearse` | **PASS, all six phases** | below |
| **rehearsal-2026-09-18-r6** | 09-18 | G2 + UAT, **final kit** (D21, audit fixes) | **PASS** | [round 2](#round-2-final-kit-2026-09-18) |
| **cutover-2026-09-18-r5** | 09-18 | Job 2 `-Rehearse`, **final kit** | **PASS, all six phases**; validator 20/20 on the promoted target | [round 2](#round-2-final-kit-2026-09-18) |

## rehearsal-2026-09-18-r5 (G2)

`new-rehearsal.ps1 -RunId rehearsal-2026-09-18-r5 -ExpectMapping approved-mapping.json -WireParents -RollbackDrill`
Evidence: `C:\POS-BACKUPS\work\rehearsal-2026-09-18-r5\`

| Step | Seconds | Result |
|---|---|---|
| reference | 0.2 | read-only flag on; backup hash verified against its `.sha256` |
| freshClone | 11.2 | dump of the reference, DROP + CREATE workspace, restore |
| chain | 42.1 | all 17 steps. The mapping gate checked the **approved** counts (29/24/5/0/0/0) with no prompt. `--wire-parents`: 24 accounts |
| numbering | 1.0 | reference = migrated: `INV-2026-004136`, `RCT-008200`, `PAY-2026-004347`, `CASH/2026/04345`, `SALES/2026/04139`. All `OK` |
| restoreTest | 75.7 | migrated dump restores in 8 s; counts equal; API `/health`, `/ready`, `/startup` = 200 |
| rollbackDrill | 21.6 | old POS healthy **8.8 s** after the switch; legacy copy intact (4,055 invoices, 7 migration rows, `accountType` present) |

Fingerprint 0 unexpected, 4 allowlisted; 8/8 transformation proofs. The release
preflight now shows **4** tenant blockers (`stale_open_sessions`,
`stale_unreconciled_sessions`, `inventory_stock_ledger_drift`,
`inventory_gl_variance`). They are pre-existing café conditions; the "stale" ones
grow with time since the backup.

### UAT on the r5 copy (G5 automated part)

| Check | Result |
|---|---|
| `uat-prepare.ps1` | 9 live users, password/PIN `1234` on the copy only |
| **Current POS suite** (`scripts/test-pos-stage1.cjs`, on a clone of the r5 migrated dump) | **76 suites, 690 tests, all PASS** (`uat-pos-suite.txt`) |
| `scripts/validate-production.ts` (older end-to-end script) | 8 pass / 14 fail. The failures are **harness drift**, not data faults: the checkout/tender request shape, report parameters, ledger column names, card mapping, credit (disabled, D10). The script was fixed for idempotency keys, float funding and a dedicated register (`VALIDATE_REGISTER_CODE`). Its invariant checks passed: no duplicate numbers, every journal balances, the double-settle race has exactly one winner |
| **Numbering under real use** | first new invoice **`INV-2026-004136`**, first receipt **`RCT-008200`** |
| History after UAT (`reconcile.ps1`, Day 0 = restored copy, adhoc = UAT copy) | **no historical number moved**; negative stock 62 → 63 (a UAT sale past zero under `warn`, expected) |
| Post-write rollback report (G8 case B) | `NOT LOSSLESS: 71 rows`. Every V2 row was exported to CSV (`v2-writes\`) |

## cutover-2026-09-18-r4 (Job 2 wrapper, `-Rehearse`)

Legacy stand-in `cafe_rollback_test_r1` (Sept 17 copy). A simulated
end-of-day was applied first (`simulate-eod.sql`, stand-in only: 5 orders
cancelled, 22 KDS tickets served, the open shift closed). This is what staff do
in the OLD POS before G11.
Evidence: `C:\POS-BACKUPS\rehearse-cutover\cutover\cutover-2026-09-18-r4\`

| Phase | Seconds | Result |
|---|---|---|
| preflight | 3 | technical checks pass; governance gaps listed as `WOULD BLOCK IN PRODUCTION` (M0 not passed, no tag, gates unsigned, D6 open) |
| freeze | 1 | two-person confirmation; open state 0; 0 connections; legacy read-only |
| backup | 13 | dump + globals + uploads + config + service settings; manifest hashed; offsite copy verified; restored to `cafe_final_ref_20260918`; counts equal; next numbers; pre-migration fingerprint |
| migrate | 56 | fresh workspace from the final dump → unchanged chain → fingerprint 0 unexpected → numbering equal → **renamed to `cafe_pos_v2_rehearsal`** → timezone UTC → app-role access |
| switch | 15 | API healthy; post-boot fingerprint 0 unexpected (Permission 192 → 654 allowlisted) |
| accept | ~5 | controlled sale `INV-2026-004136` / `RCT-008200` verified (invoice + journal + receipt + payment); Day 0 **PASS**; Day 1 recheck **PASS** |

Freeze to switch took **~85 s** on this machine. The café server's own timing comes from G9.

## Findings that change the plan

| # | Finding | Severity | Resolution |
|---|---|---|---|
| **F1** | Drawer account `1100 Cash` (MAIN-REG) has a legacy ledger of **101,723,000** (posted + reversed). The old system never booked cash leaving the drawer. The new system **refuses to open the first shift** ("Opening count is below the drawer ledger") | **go-live blocker** | Decision **D19**. Before the first shift, the owner records, through the application, where that cash went: a bank deposit from the last closed legacy shift (`POST /cash-sessions/:id/banking`, needs `cash_session:reconcile`) or a treasury transfer, down to the physical float. The amount must be backed by bank slips and owner drawings records. Rehearsed in cutover r4 as a demo deposit to `1200 Bank`. Discovery §10 now shows the amount |
| F2 | The legacy **Cashier** role gets `403 cash_register:read` on `GET /cash-registers`. A cashier can still open a shift | check in UAT | **D20**: confirm in UAT B6 that terminal/register binding works for cashiers; if not, grant the permission through the app's role screen (owner decision, recorded) |
| F3 | The Sept 17 backup was taken mid-trade: 1 open shift, 5 open orders, 22 KDS tickets | expected | the freeze gate refuses until all are 0. They are closed in the OLD POS before the final backup (D3) |
| F4 | `validate-production.ts` lags the current API | test tooling | G5 automated evidence = the jest POS suite (690 pass) + the interactive checklist. Bring the old script up to date separately, or retire it |
| F5 | This workstation's C: has **1.86 GB** free | environment | free space before more rehearsals. Leftover disposable databases: `cafe_final_ref_20260918`, `cafe_pos_v2_rehearsal`, `pos_stage1_2026091805` |
| F6 | Windows PowerShell 5.1 turns redirected native stderr into terminating errors | kit | fixed. Never redirect kit scripts; read their `console*.log` transcripts |

## Round 2: final kit (2026-09-18)

Changes since round 1: D21 payment-method step, the D19 evidence report,
`validate-production.ts` brought up to the current API, and the audit fixes
below. The disk was cleared first (19 GB free; the three disposable databases
of round 1 were dropped).

### rehearsal-2026-09-18-r6

`new-rehearsal.ps1 -RunId rehearsal-2026-09-18-r6 -ExpectMapping … -WireParents -ConfigurePaymentMethods -RollbackDrill`

| Step | Seconds | Result |
|---|---|---|
| freshClone | 9.7 | fresh workspace |
| chain | 53.5 | 17/17 steps; approved mapping; fingerprint 0 unexpected; 8/8 proofs |
| numbering | 2.1 | reference = migrated (`INV-2026-004136`, `RCT-008200`, …) |
| paymentMethods (D21) | 6.0 | 6 methods; `mobile_money` → MOMO-MTN, `card_clearing` → 1131 |
| restoreTest | 29.3 | restore equal; API health 200 ×3 |
| rollbackDrill | 21.3 | old POS healthy in **7.6 s** |

UAT on r6: **POS certification suite 76/76 suites, 690/690 tests** on a clone of
the migrated dump. Synchronization counts: `sync-counts.json`, see
[SYNC-AUDIT.md](SYNC-AUDIT.md).

### cutover-2026-09-18-r5 (final kit)

preflight 6 s → freeze 1 s → backup 15 s → migrate 58 s (with D21) → switch 16 s
→ accept. Post-boot fingerprint 0 unexpected (Account 29→31, AccountMapping
20→23 allowlisted). Controlled sale `INV-2026-004136` / `RCT-008200`; Day 0
reconciliation **PASS after 53 live sales** (history unchanged, invariants 0).

### validate-production.ts, updated to the current API

Every failure is now classified: INTEGRITY (data defect), CONTRACT (stale
request), REJECTED (valid request refused), PRECONDITION (not runnable here).
No assertion was removed. The pre-settled-invoice guard, which no longer has a
subject, was replaced by the strict tender contract and the D16 legacy guard.
Checks were added: numbering continuity (1b), MoMo tenders, legacy collection
refusal (4e), X-report = service = SQL cash, and the declaration of tracked
tender balances at close.

| Run | Target | Passed | INTEGRITY | CONTRACT | REJECTED | PRECONDITION |
|---|---|---|---|---|---|---|
| round 1 (old script) | r5 copy | 8 | – | – | 14 failures, unclassified | – |
| first run, updated script | r6 copy | 15 | 2 (script bugs: UTC compare, async stock) | 0 | 2 (restock before stock posting) | 6 |
| **final** | promoted cutover target (quiet state) | **20** | **0** | **0** | **0** | 5 (credit disabled by D10 ×4; no legacy invoice with a balance) |

On the promoted target, check 1b **proved numbering under use: first invoice
`INV-2026-004136`, first receipt `RCT-008200`**.

### Audit fixes to the kit (round 2)

| # | Defect | Risk | Fix |
|---|---|---|---|
| A1 | The query helpers in `cutover.ps1`, `new-rehearsal.ps1`, `rollback.ps1` and `reconcile.ps1` ran `psql -f` without `ON_ERROR_STOP` | a SQL error exits 0, so a broken open-state query would return nothing and **the freeze gate would pass** | `-v ON_ERROR_STOP=1` everywhere |
| A2 | The V2-write export listed `InvoiceLine`; the real table is `InvoiceItem` | a post-write rollback would have exported invoices **without their lines** | table name fixed |
| A3 | `seed-pos-payment-methods.ts` has no target guard, reads `apps/api/.env` when `DATABASE_URL` is unset, and silently reuses any account with code 1121/1122/1131 | writes to the dev DB; a MoMo tile bound to the wrong account | wrapped by `configure-payment-methods.ps1`: approved-DB guard, explicit URL, code-collision refusal, dry run first |

### New findings (round 2)

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F7 | No `mobile_money` account mapping after migration; legacy MoMo payments (8, 311,000) were booked to `1100 Cash` | an offline-queued MoMo sale would be rejected on replay | D21, `configure-payment-methods.ps1`, applied in Job 2 before promotion; the 311,000 is part of D19 |
| F8 | Tables page "Split bill" (`TableDetailDialog` → `POST /pos/tables/:id/split-bill`) returns **409**: the split tabs violate the one-open-tab-per-table unique index. The POS screen's split (`/pos/tabs/:tableId/split/*`) works | product defect | fix or hide the Tables-page action **before M0**; UAT B10 must use the POS screen |
| F9 | Cash controls cashiers will meet: (a) the next shift cannot open below the cash left in the drawer, so bank/record the takings after every close; (b) close is refused while stock posting is queued (the worker drains every 30 s); (c) with D21 every tracked tender (MTN, Airtel, and Card/Bank unless deactivated) is declared at close; (d) a restock refund is refused until the sale's stock posting is done | training / configuration | cashier briefing; deactivate unused Card/Bank tiles (D21); UAT B6, B19, B25 |
| F10 | Credit is refused for customers without a credit limit | expected (D10) | credit paths are PRECONDITION in the validator; they run only if D10 changes |
| F11 | The API login throttler blocked repeated test logins (HTTP 429) | security control working | restart the API between long UAT sessions, or space out logins |

### D19 evidence (from the Sept 17 data)

`d19-cash-evidence.sql`: drawer ledger 101,723,000 = payments 101,249,000 +
pay-in 450,000 + direct invoice postings 24,000 (+9,000 reversed pair); **0
credits ever**. 54 counted shifts show **99,232,000** leaving the drawer, and
none of it was booked. 311,000 of the ledger is mobile money. The owner matches
each shift row to bank slips or drawings, then signs the SIGNOFF worksheet.
