# Gate sign-off: café migration (v1.5.0 → current main, release 2026-09-r2)

Nothing about the live café changes until every mandatory gate below is signed.
A gate is signed against **evidence on disk**, never from memory. The
machine-readable copy of this sheet is `C:\POS-BACKUPS\authorization.json`
(template: [authorization.template.json](authorization.template.json)).
`cutover.ps1` reads it and refuses to start unless M0–G10 are all PASS.

The sequence and the pass criteria are in [PRODUCTION-RUNBOOK.md](PRODUCTION-RUNBOOK.md) §3.

Release manifest: `________________________`  SHA-256: `________________`
Kit hash: `________________`  New commit / tag: `________________`  Legacy commit: `e91fb5b`

## Gates

| Gate | Passes when | Evidence | Owner | Due | Status | Signed / date |
|---|---|---|---|---|---|---|
| **M0** Release freeze | clean tree, kit committed, release tag, builds hashed, old evidence archived, no feature work left | `release-manifest-<tag>.json` | Engineer | | **open**. The kit is not committed yet (tree dirty, no tag) | |
| **G0** Café discovery | every item in runbook §5 is answered for the café machine, **before** any production change | `discovery-<date>.txt`, `cafe-config.json` | Engineer | | **open**. Needs café access | |
| **G1** Reference backup | Sept 17 backup protected, hashed, **copied offsite**, restored; reference proven untouched | `REHEARSAL-1-REPORT.md` §1–2; offsite copy path | Engineer | | PASS 2026-09-17 on restore and hash; **offsite copy open** | |
| **G2** Fresh rehearsal | new run ID + fresh clone + whole chain, no manual repair | `C:\POS-BACKUPS\work\rehearsal-2026-09-18-r6\run-summary.json` | Engineer | | PASS 2026-09-18 (r5; r6 on the final kit), see `REHEARSAL-LOG.md` | |
| **G3** Data mapping | 29-account mapping and all transformations approved by name (D1, D2) | `<run>\MigrationReport.md`, `<run>\transformations.json` | Owner | | **open**. Needs the owner's signature | |
| **G4** Historical integrity | 0 missing, 0 unexplained changes in protected tables | `<run>\fingerprint.json` | Engineer | | PASS (r1, r2, r5) | |
| **G5** Application UAT | [UAT-CHECKLIST.md](UAT-CHECKLIST.md) A green, every B row ticked | `<run>\uat-automated.txt`, signed checklist | Owner + Engineer | | automated part PASS: POS suite 690/690 (r6); validator 20 pass / 0 defects on the cutover target; numbering proven. **Interactive part (café users) open** | |
| **G6** Accounting | posted debit/credit and account × period identical | `<run>\fingerprint.json` `money.*` | Owner | | PASS on data (202,416,000.000000); **owner signature open** | |
| **G7** Inventory | fingerprint matches; D5/D6 resolution signed | `<run>\fingerprint.json` `inventory`; D5, D6 | Owner | | PASS on data; **D5/D6 open** | |
| **G8** Recovery | restore test; rollback A timed; rollback B (post-write) demonstrated | `<run>\restore-test.txt`, `<run>\rollback-test.txt`, UAT post-write report | Engineer | | PASS on data (r5): restore 8 s + API boot, rollback A 8.8 s, rollback B report + CSV export (71 rows); **production post-write procedure is interactive, rehearse it in G9** | |
| **G9** Hardware dress rehearsal | [DRESS-REHEARSAL.md](DRESS-REHEARSAL.md) signed | signed sheet + rehearse run evidence on the café server | Owner + Engineer | | **deferred** (development machine). Still mandatory before G10 | |
| **G10** Production authorization | owner + engineer signed; window approved; rollback authority named; wrapper hash recorded; backup destinations available | `authorization.json`, `cutover.ps1 -Phase preflight` PASS | Owner + Engineer | | **open** | |
| **G11** Final backup | quiet state, full backup set, hashes, offsite, restore | `<cutover run>\backup-manifest.json`, `freeze.json` | Operator + Approver | cutover day | | |
| **G12** Production migration | chain + fingerprint + drift + numbering + app-role access | `<cutover run>\state.json`, `fingerprint.json` | Operator + Approver | cutover day | | |
| **G13** Go-live acceptance | terminals, printers, numbering, controlled sale, Day 0 | `<cutover run>\cutover-state.json` `accept`, `reconcile-day0.json` | Owner | cutover day | | |

## Owner decisions

Each decision needs a named owner, a due date, the evidence it was decided on,
and a signature. A tick is not enough. Record the same values in
`authorization.json → decisions`.

| # | Decision | Recommendation | Evidence | Owner | Due | Decided | Signed / date |
|---|---|---|---|---|---|---|---|
| D1 | Chart-of-accounts mapping (29 accounts: 24 template, 5 group nodes, 0 unmapped, 0 renamed) | accept as reported | `MigrationReport.md` | | | | |
| D2 | Wire `Account.parentAccountId` from the template (`wireParents`) | yes: the books then match a fresh install. Rehearsed in r5 | r5 `transformations.json` | | | | |
| D3 | 22 KDS tickets still `new` | resolve them in the OLD system before the final backup | discovery §7 | | | | |
| D4 | 48 closed shifts never reconciled (+ recent ones) | reconcile in the OLD system, or accept formally with a list | release preflight `stale_unreconciled_sessions` | | | | |
| D5 | Inventory sub-ledger 2,275,800 vs inventory GL 0.00 | owner-signed opening adjustment after go-live, through the normal workflow | `REHEARSAL-1-REPORT.md` §6 | | | | |
| D6 | 41 stock-ledger drifts, 62 negative-stock items | runbook §9 **option A** (count in the old POS before the final backup) if feasible, otherwise option B | `reconcile` `watch.*` | | | | |
| D7 | 2 tracked menu items without a recipe (`Chestini`, `Pound Cake`) | add recipes or untrack them before go-live | release preflight | | | | |
| D8 | 127 products flip `silent` → `warn` | accept; brief the cashiers | transformation `product_stock_policy` | | | | |
| D9 | New, empty `Manager` role | decide who, if anyone, gets it | fingerprint Role 5 → 6 | | | | |
| D10 | Credit sales stay disabled (no credit history) | accept | — | | | | |
| D11 | Database timezone = UTC on the new database (`databaseTimezone`) | adopt; confirmed in UAT B40 | README §7 | | | | |
| D12 | `admin@demo.test` default password | the owner changes it in the application before go-live | `REHEARSAL-1-REPORT.md` §6 | | | | |
| D13 | `BACKUP_DIR` and `BACKUP_*` settings | set in the new `.env`; UAT B46 | boot log | | | | |
| D14 | Feature flags `ENABLE_*` | all false at cutover; enable one at a time afterwards | `cutover.ps1 -Phase switch` check | | | | |
| D15 | RLS / API database role (`rlsPosture`) | keep the rehearsed role for cutover; RLS hardening is a separate, separately rehearsed release | G0 discovery §2–3 | | | | |
| D16 | 100 legacy invoices without a receivable account | accept: refunds and collections on them are refused until reviewed; UAT B21 | release preflight | | | | |
| D17 | Controlled first sale | keep as a real sale, or refund/void in the app with a reason; never delete | runbook §10 | | | | |
| D18 | Maintenance window, go/no-go deadline, rollback authority | named date, time and person | `authorization.json` | | | | |
| **D19** | **Legacy drawer ledger** (`1100 Cash` = 101,723,000 on Sept 17) blocks the first shift | before the first shift, the owner records where the cash went (bank deposit / transfer) in the app, down to the physical float, with bank slips and drawings as evidence. **Go-live blocker until decided** | discovery §10; `REHEARSAL-LOG.md` F1 | | | | |
| D20 | Legacy Cashier role lacks `cash_register:read` | confirm cashier register binding in UAT B6; grant it through the role screen if needed | `REHEARSAL-LOG.md` F2 | | | | |
| **D21** | POS payment methods: no `mobile_money` mapping after migration, so an offline-queued MoMo sale would be rejected on replay | `configure` with providers MTN, Airtel (`configure-payment-methods.ps1`, applied in Job 2 before promotion); deactivate the Card tile in the app if there is no card terminal | `REHEARSAL-LOG.md` F7 | | | | |

## D19 worksheet: legacy cash balance treatment

This is a business decision. The developer supplies the evidence report; the
owner decides and signs. Amounts come from the **FINAL** backup, not from
17 September.

```text
Legacy drawer ledger (1100 Cash, FINAL backup)   UGX ______________   (d19-cash-evidence.sql §A)

Evidence reviewed (tick):
  [ ] bank slips / bank statements        period ________ to ________
  [ ] owner drawings / transfer records
  [ ] cash expense / supplier receipts
  [ ] physical cash count at cutover

Reconstruction (d19-evidence.csv §D, every row matched):
  X  banked                               UGX ______________
  Y  owner drawings / transfers           UGX ______________
  Z  other documented cash outflows       UGX ______________
  N  non-cash booked to the drawer        UGX ______________   (mobile money: 311,000 on Sept 17)
  R  opening drawer float (counted)       UGX ______________
  U  unexplained                          UGX ______________
                                          ---------------------
  X + Y + Z + N + R + U  =  ledger        UGX ______________

Approved treatment, recorded in the new application before the first shift:
  bank deposits          UGX __________   to account ________
  transfers              UGX __________   to account ________
  adjustment (N and U)   UGX __________   reason ___________________________

Supporting documents (file / folder): ________________________________________

Approved by (owner): ____________________   Date: __________
Witness / accountant: ___________________   Date: __________
```

## Statement

By signing M0–G10 we record that the migration has been rehearsed against a copy
of real café data, that the evidence named in each row exists and was read, that
every owner decision above is made, and that the people named in
`authorization.json` will be present for the maintenance window.

**Signing G10 authorizes running `cutover.ps1` within the approved window. Each
irreversible step still needs two named people at the time it is executed.**

Engineer: ________________________  Date: ____________

Owner:    ________________________  Date: ____________

Rollback authority: ______________  Date: ____________
