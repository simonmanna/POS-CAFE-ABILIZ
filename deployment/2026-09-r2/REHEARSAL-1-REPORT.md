# Job 1 rehearsal report

Source: `C:\POS-BACKUPS\2026-09-17\backup-Sep-17.dump`
SHA-256 `1a4d13e70e83ddc62c8a8a1488945cead09a56acb93df960e05926be70e30465`
(taken from the live cafe on 2026-09-17 20:07:17, PostgreSQL 18.4, while trading)

Everything below ran on disposable local databases. **The live cafe database and
install were never touched.** Raw evidence: `C:\POS-BACKUPS\work\`.

## 1. Backup protection (R1)

| Step | Result |
|---|---|
| Moved out of the repository | `C:\Dev\POS-CAFE\deployed-backup-database\` -> `C:\POS-BACKUPS\2026-09-17\` |
| Hash recorded and re-verified after the copy | identical |
| Marked read-only | both the dump and its `.sha256` sidecar |
| Git | untracked, and `deployed-backup-database/`, `*.dump`, `*.dump.sha256` added to `.gitignore` |
| Readability | `pg_restore --list` parses the archive (1,223 TOC entries) |

## 2. Reference integrity (G1, G1.5)

Restored into `cafe_reference_20260917` in **5.4s**; 120 MB; then set
`default_transaction_read_only = on` and never written to again.

| Check | Expected (from the dump) | Reference |
|---|---|---|
| Orders / Invoices / Payments | 4,385 / 4,055 / 4,267 | same |
| Receipts / CashSessions / CashMovements | 8,110 / 55 / 4,260 | same |
| JournalEntries / JournalLines | 8,342 / 16,687 | same |
| InventoryLedger / Products / Users / Files | 10,055 / 127 / 13 / 91 | same |
| `_prisma_migrations` | 7 rows, all finished | same |
| Posted debit = credit | 202,416,000.000000 | same, balanced |
| Max invoice number / distinct | `INV-2026-004135` / 4,055 | same |
| Tables / enums / FKs / policies / triggers | 134 / 66 / 117 / 35 / 2 | same |

## 3. Migration chain (G2, G3)

Run by `upgrade.ps1` against `cafe_migration_r1`, cloned from the reference by
dump+restore.

| Step | Time | Result |
|---|---|---|
| preflightPre | 1.1s | 0 blockers |
| archive | 0.2s | 16 tables into `legacy_archive` |
| bridge00 (enums) | 0.1s | 8 enum values |
| bridge10 (additive) | 0.5s | 250 statements, 134 -> 175 tables |
| backfillDry + gate | 1.2s | 29 accounts: 24 template, 5 groups, 0 type-map, **0 unmapped**, 0 needing review, 0 renamed |
| backfillApply | 1.0s | 29 updated; invariants hold |
| preflightPostB | 0.8s | 0 blockers |
| bridge30 (contract) | 0.1s | `accountType`, `isGroup`, `AccountType` dropped |
| equivalence | 4.7s | **PASS** |
| history | 7.1s | 7 -> 9 rows (2 baseline names resolved, 7 legacy rows preserved) |
| deploy | 6.8s | all 80 migrations applied |
| drift | 4.8s | no drift vs `schema.prisma` |
| ledgerConstraints | 0.3s | both NOT VALID checks validated |
| releasePreflight | 0.7s | 0 database blockers; 3 tenant blockers (see §6) |
| fingerprint | 9.2s | **0 unexpected** |
| transformations | 1.1s | 8/8 proofs pass |
| **total** | **~40s** | on a 12.7 MB dump |

Equivalence detail (bridged copy vs `ref_baseline_20260727`): Prisma
`migrate diff` reports no difference, and the catalog diff matches on 2,539
columns, 649 indexes, 1,872 constraints, 89 enums, 1 function, 2 triggers,
35 policies, 174 RLS flags and 1 sequence.

## 4. Evidence that nothing moved (G4, G6, G7)

Row-by-row comparison, reference vs migrated, over every column the two schemas
share minus the documented allowlist:

| Table | Rows | Missing | Changed | Added |
|---|---|---|---|---|
| Invoice | 4,055 | 0 | 0 | 0 |
| Payment | 4,267 | 0 | 0 | 0 |
| PaymentAllocation | 4,267 | 0 | 0 | 0 |
| Receipt | 8,110 | 0 | 0 | 0 |
| JournalEntry | 8,342 | 0 | 0 | 0 |
| JournalLine | 16,687 | 0 | 0 | 0 |
| InventoryLedger | 10,055 | 0 | 0 | 0 |
| CashMovement | 4,260 | 0 | 0 | 0 |

Aggregate fingerprint: **0 unexpected**, 4 allowlisted growths, everything else
informational (new empty tables).

| Allowlisted growth | Why |
|---|---|
| Account 29 -> 30 | account `5320 Purchase Price Variance` (`20260910010000`) |
| AccountMapping 20 -> 21 | the matching `purchase_price_variance` mapping |
| Role 5 -> 6 | the new, empty `Manager` role (`20260914000200`) |
| `_prisma_migrations` 7 -> 89 | 7 legacy rows preserved + 82 repository migrations |

Transformation proofs, each joined back to `legacy_archive`:

| Proof | Result |
|---|---|
| `order_status_remap` | `closed->closed 4,055`, `cancelled->cancelled 325`, `open->confirmed 5` |
| `product_stock_policy` | `silent->warn 127` |
| `accounts_preserved` | 0 missing, 0 renamed, 0 `isDefault` changes |
| `coa_invariant` | 0 violations (postable <=> categorized) |
| `role_permissions_only_widened` | 5 legacy roles intact |
| `organization_settings_preserved` | every settings key kept |
| `pos_table_zones` | 17 unchanged, 0 lost |
| `business_date_not_backfilled` | 0 legacy invoices given a business date |

## 5. Application, restore and rollback (G5 partial, G8, G9 partial)

| Test | Result |
|---|---|
| New API against the migrated database (`NODE_ENV=production`) | boots in ~12s, 18 modules, `/health`, `/health/ready`, `/health/startup` all 200 |
| Boot-time writes | additive only: `Permission` 192 -> 654, DMS registry rows (6 lifecycles, 41 transitions, 17 types, 9 relation types, 21 templates). Fingerprint after boot still **0 unexpected** |
| Restore test (G8) | migrated DB dumps (13.7 MB, 1.9s), restores into `cafe_v2_restore_test` (8.8s), API boots against the restored copy, `criticalOk: true` |
| Rollback Test B | 0 business transactions written by the new system since the boundary -> a switch-back would be lossless |
| Rollback Test A | **4.8s** from switch to a healthy old POS (old app cold start 3.0s), legacy copy intact: 4,055 invoices, 7 migration rows, `accountType` still present |

## 6. Findings for the owner (pre-existing, not caused by the migration)

Each was verified to be **identical in the untouched reference**, so the
migration neither created nor worsened it.

| Finding | Evidence | Decision needed |
|---|---|---|
| 48 closed shifts older than 7 days were never reconciled (3 more in the last week) | reference and migrated both: 54 closed, 0 reconciled | reconcile, or accept and record |
| On-hand disagrees with the stock ledger for 41 of 104 product/location pairs | identical in both | stock count, or opening-ledger backfill |
| Inventory sub-ledger 2,275,800 vs inventory GL 0.00 | account `1400` has never been posted to; COGS `5100` is also 0 | the cafe has never posted inventory to the GL. The new system will, from cutover. An owner-signed opening adjustment is the clean answer |
| 62 products sit at negative stock | identical in both | count before trading on the new system |
| 100 legacy invoices have no receivable account | flagged by the release preflight | collections/refunds on those invoices are refused until reviewed |
| 2 inventory-tracked menu items have no recipe | `Chestini`, `Pound Cake` | add recipes or untrack them, else every sale raises an exception and posts no COGS |
| 127 products flip `silent` -> `warn` | by design (`20260908000000`) | tell the cashiers |
| 22 KDS tickets still `new` | pre-existing | resolve in the OLD system before the final backup; the kit deliberately does not touch them |
| Seed admin `admin@demo.test` is active, last login 2026-09-16, default password published in `DEPLOYMENT.md` | production dump | change the password |
| `BACKUP_DIR` is unset, so the new backup module cannot create its directories | boot log: `mkdir '\\?'` | set it before go-live (advisory only; `criticalOk` stays true) |

## 7. Still outstanding for Job 1

1. **Interactive POS UAT** - login for all five roles, PIN override, sale,
   modifiers, KOT, bill, split, cash/MTN/Airtel, receipt, refund, void, pay-in,
   pay-out, shift close, Z report, reports, printing and the cash drawer, plus
   the concurrency cases. Needs cafe credentials; the API-level boot, health and
   data checks are done.
2. **Numbering continuity under real use** - the next invoice must be
   `INV-2026-004136` and the next receipt `RCT-008200`. Requires the UAT above.
3. **Report-by-report comparison** - Z reports for all 54 closed shifts, trial
   balance, P&L, balance sheet, old vs new.
4. **Owner decisions** in section 6, and the timezone conclusion (README section 7).
5. **Cafe dress rehearsal** on the cafe's own hardware: printers, drawer, NSSM
   service account, nginx, and timings on that machine.

Until those are done, G5 and G9 are incomplete and production remains **NO-GO**.
