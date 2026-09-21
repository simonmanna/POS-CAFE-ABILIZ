# G5: application UAT on the migrated copy

UAT runs against a **migrated rehearsal copy** (`cafe_migration_r1` from a named
run), never against the café database. It has two parts:

- **A. Automated:** the current POS certification suite on a clone of the migrated data (A1), plus `scripts/validate-production.ts` end to end over HTTP (A2).
- **B. Interactive:** the flows a script cannot see, run on screen by a person for each role.

G5 passes when A is green (A1 all pass; A2 INTEGRITY 0, CONTRACT 0, REJECTED 0), every B row has a Pass result with evidence, and the owner signs.

Run ID: ____________________  Database: `cafe_migration_r1`  Date: __________

## 0. Preparation

```powershell
$env:PGPASSWORD = '<postgres password>'
# every user on the COPY: password 1234, PIN 1234; lockouts and MFA cleared
.\uat-prepare.ps1 -TargetDb cafe_migration_r1 -RunId <run>

# start the new API against the copy (separate window)
cd C:\Dev\POS-CAFE\apps\api
$env:DATABASE_URL = 'postgresql://postgres:<pw>@localhost:5432/cafe_migration_r1?schema=public'
$env:PORT = '3099'; $env:NODE_ENV = 'production'; $env:RLS_ALLOW_SUPERUSER = 'true'
node --max-http-header-size=65536 dist/main.js
```

Log in as an **active** user for each role (the list is in
`<run>\uat-credentials.txt`):

| Role | User on the Sept 17 copy |
|---|---|
| Administrator | `admin@demo.test`, `gideon@demo.test` |
| Supervisor | `abiel@demo.test` (also Cashier) |
| Cashier | `jane@demo.test` |
| Waiter / Barista | `brend@demo.test`, `charles@abiliz.com` (Waiter) |
| Manager (new, empty role) | assign it to a test user only if decision D9 says so |

## A. Automated pipeline suite

**A1, primary: the current POS certification suite** on a clone of the migrated
dump. The database name must match `pos_stage1_<digits>`; the harness enforces it.

```powershell
createdb -U postgres -T template0 -E UTF8 pos_stage1_<yyyymmddNN>
pg_restore -U postgres -d pos_stage1_<yyyymmddNN> --single-transaction --exit-on-error C:\POS-BACKUPS\work\<run>\migrated-v2.dump
$env:POS_TEST_DATABASE_URL = 'postgresql://postgres:<pw>@localhost:5432/pos_stage1_<yyyymmddNN>'
node scripts/test-pos-stage1.cjs *> C:\POS-BACKUPS\work\<run>\uat-pos-suite.txt
```

- [ ] every suite passes (r5: 76 suites, 690 tests)

**A2, end to end over HTTP against the running API** (`scripts/validate-production.ts`,
up to date with the current API). Every failure is classified as INTEGRITY
(data defect), CONTRACT (stale script), REJECTED (valid request refused) or
PRECONDITION (not runnable here, e.g. credit disabled by D10). Best run on a
**quiet-state** copy (the promoted target of a `cutover.ps1 -Rehearse` run);
on a mid-trade copy, the shift close is a PRECONDITION because of legacy open
orders.

```powershell
cd C:\Dev\POS-CAFE
$env:API_BASE = 'http://localhost:3099/api/v1'; $env:ORG_CODE = 'DEMO'
$env:ADMIN_EMAIL = 'gideon@demo.test'; $env:ADMIN_PASSWORD = '1234'; $env:VALIDATE_MANAGER_PIN = '1234'
$env:VALIDATE_REGISTER_CODE = 'UAT-REG'
$env:VALIDATE_EXPECT_NEXT_INVOICE = '<expected_next invoice>'; $env:VALIDATE_EXPECT_NEXT_RECEIPT = '<expected_next receipt>'
$env:VALIDATE_JSON = 'C:\POS-BACKUPS\work\<run>\uat-automated.json'
$env:DATABASE_URL = 'postgresql://postgres:<pw>@localhost:5432/cafe_migration_r1'
pnpm tsx scripts/validate-production.ts | Tee-Object C:\POS-BACKUPS\work\<run>\uat-automated.txt
```

- [ ] exit code 0: INTEGRITY 0, CONTRACT 0, REJECTED 0 (round 2: 20 passed, 5 PRECONDITION)
- [ ] check 1b: the first invoice/receipt carry `expected_next` (round 2: `INV-2026-004136` / `RCT-008200`)
- [ ] every PRECONDITION is explained by a signed decision (e.g. D10 credit disabled)
- [ ] `reconcile.ps1 -Label adhoc` on the copy (boundary = the time UAT started): history unchanged, invariants 0

## B. Interactive flows

**Real café users perform these, in their own role**, not the engineer: a
cashier for cashier rows, a supervisor for overrides and refunds, the owner for
reports and accounting. "Tested" is not a result: every row records Pass or
Fail and the evidence (document number, printout, screenshot). A Fail gets a
defect ID and a decision before G5 can be signed.

| Role | Must personally run |
|---|---|
| Cashier | B1, B2, B6–B16, B22, B24 (pay-in), B25, B26 |
| Supervisor / manager | B3, B5, B17–B19, B24 (pay-out), B27, B32, B41–B45 |
| Owner / admin | B20, B21, B28, B34–B40, B46, audit trail review |

### Access

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B1 | Login with password: every role above | | | |
| B2 | PIN login on the POS screen: cashier, supervisor | | | |
| B3 | Wrong PIN ×N locks, then supervisor unlock | | | |
| B4 | Cashier cannot open admin/accounting menus | | | |
| B5 | Supervisor PIN override (discount / void) works | | | |

### Selling

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B6 | Open shift with float on a register; bind terminal to register **as a Cashier** (D20); first shift needs D19 done. Second shift: opening below the cash left in the drawer is refused until that cash is banked/recorded (F9a) | | | |
| B7 | Dine-in order on a table: items + modifiers + accompaniments | | | |
| B8 | KOT to kitchen/bar station; KDS shows it; bump it | | | |
| B9 | Print bill; add item after bill; reprint shows the delta | | | |
| B10 | Split bill (by item and by amount) **from the POS screen**. The Tables-page "Split bill" returns 409 until F8 is fixed | | | |
| B11 | Pay cash with change | | | |
| B12 | Pay MTN MoMo | | | |
| B13 | Pay Airtel Money | | | |
| B14 | Mixed tender (cash + mobile) | | | |
| B15 | Receipt printed; reprint marked as reprint | | | |
| B16 | Takeaway order | | | |
| B17 | Line discount and bill discount (with override) | | | |
| B18 | Void an item before payment (reason required) | | | |
| B19 | Refund a paid invoice (full and partial), reason required; a restock refund right after the sale is refused until stock posting finishes (≤ 30 s, F9d) | | | |
| B20 | A LEGACY invoice (created before migration) can be looked up and reprinted | | | |
| B21 | Refund on a legacy invoice without a receivable account is refused with a clear message (release-preflight finding) | | | |
| B22 | `silent→warn` stock policy: selling past zero warns, does not block | | | |
| B23 | Tracked item without a recipe (`Chestini`, `Pound Cake`): behaviour matches decision D7 | | | |

### Cash

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B24 | Pay-in and pay-out with reason | | | |
| B25 | Close shift: count cash by denomination, declare MTN/Airtel (and any other active tender) balances, variance shown, reason for variance; close waits for stock posting (F9b/c) | | | |
| B26 | Z report printed; totals = sales by method | | | |
| B27 | Reconcile the closed shift (supervisor) | | | |
| B28 | A LEGACY closed shift opens and its Z report matches the old system's Z | | | |

### Inventory

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B29 | A sale deducts stock of recipe ingredients (ledger row, on-hand moves) | | | |
| B30 | Refund returns stock | | | |
| B31 | Stock receipt / purchase in | | | |
| B32 | Stock count and adjustment with reason (the D6 option B procedure) | | | |
| B33 | Waste record | | | |

### Accounting and reports

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B34 | Every sale above has a balanced journal (sales, cash/mobile, COGS where recipes exist) | | | |
| B35 | Trial balance: legacy period totals = old system | | | |
| B36 | P&L and balance sheet for a closed legacy month = old system | | | |
| B37 | Sales report by day / method / product for a legacy week = old system | | | |
| B38 | Z reports for 3 sampled legacy shifts = old system printouts | | | |
| B39 | Money & Accounts activity feed shows legacy and new transactions correctly | | | |
| B40 | Business date on new sales is correct (trading-date rules) | | | |

### Concurrency and failure

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B41 | Two terminals sell at the same time: no duplicate invoice/receipt numbers | | | |
| B42 | Two cashiers pay the same bill at once: one wins, the other is refused | | | |
| B43 | Network cut on a terminal: sale queues offline, replays once, no duplicate | | | |
| B43b | Same with an **MTN MoMo** sale: replays onto the MoMo account (needs D21) | | | |
| B44 | API restart mid-shift: terminals recover, shift intact | | | |
| B45 | Browser refresh mid-order: cart / held order recovered | | | |

### Backup module

| # | Flow | Result (Pass/Fail) | Evidence (doc no., printout, screenshot) | Tester (role, name) |
|---|---|---|---|---|
| B46 | With `BACKUP_DIR` set, a manual backup from the app succeeds and the file restores | | | |

## Rollback B evidence (post-write)

After UAT the copy contains real V2 writes. That is the post-write rollback
drill for G8:

```powershell
.\rollback.ps1 -ReportV2Writes -TargetDb cafe_migration_r1 -Since '<UAT start UTC>' -ExportDir C:\POS-BACKUPS\work\<run>\v2-writes
```

- [ ] the report says **NOT LOSSLESS** and lists the UAT rows
- [ ] the CSVs contain every UAT invoice, payment and cash movement
- [ ] the re-entry list has been walked through once, on paper, with the owner

## Sign-off

UAT result: PASS / FAIL    Open defects (ID, severity, decision): ____________________

Owner: ______________________  Date: ________

Engineer: ___________________  Date: ________
