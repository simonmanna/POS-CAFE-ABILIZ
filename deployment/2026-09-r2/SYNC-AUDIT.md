# Data synchronization audit: legacy POS → new system

This audit answers one question: **how does every piece of the café's data get
from the old system into the new one, and what proves it arrived unchanged?**

Evidence: rehearsal `rehearsal-2026-09-18-r6` (fresh clone of the 17 September
backup, final kit), `C:\POS-BACKUPS\work\rehearsal-2026-09-18-r6\`
(`sync-counts.json`, `fingerprint.json`, `transformations.json`), and cutover
rehearsal `cutover-2026-09-18-r5`.

## 1. The synchronization model: one quiet-state snapshot, no dual running

The two systems are **never synchronized continuously**, and they never trade at
the same time. Synchronization is a single, verified hand-over of a frozen
state:

```text
OLD POS trading ──► end of day: shifts closed, orders/KDS 0, offline queues 0
                         │
                   G11 freeze: old services stopped, 0 connections,
                       POS-CAFE set read-only  ← the last legacy write happened before this
                         │
                   final.dump (+ globals, uploads, config, service settings)
                   SHA-256 manifest, offsite copy, test restore → cafe_final_ref_<date>
                         │
                   G12 restore into a fresh workspace → bridge → backfill → equivalence
                       → 80 migrations → drift 0 → fingerprint A/B vs the final ref
                       → numbering equal → D21 configuration → promote to cafe_pos_v2
                         │
                   G13 new system starts; first sale continues the numbering
                         │
NEW POS trading ──► reconcile Day 0/1/3/7/30: history frozen, invariants 0
```

Why a snapshot rather than a live sync:

- The legacy database is the rollback. Keeping it read-only and untouched makes a pre-write rollback lossless.
- The migration rewrites structure (chart of accounts, statuses, 80 migrations). A live sync would have to replay legacy writes through that transform, which is a second migration engine with its own failure modes.
- The window is short: freeze → switch took about 85–90 s in rehearsal, plus terminal work.

Writes made **after** the switch exist only in the new system. They come back
to the old system only in a post-write rollback, as a CSV export for manual
re-entry (`rollback.ps1 -Production`). Rehearsed: 71 rows detected and exported
(r5).

## 2. Table-by-table result (r6)

| Measure | Result |
|---|---|
| Legacy tables | **134** |
| Carried into the new database | **134 / 134** (0 dropped) |
| Row count identical | **130 tables**, 208,856 of 208,917 legacy rows |
| Row count grew (documented) | 4 tables (below) |
| Row count shrank | **0** |
| New tables (new modules) | 165, of which 161 empty; 4 seeded (below) |
| Pre-migration values kept | 17 tables in schema `legacy_archive` |

Tables that grew, and why:

| Table | Legacy → new | Reason | Owner |
|---|---|---|---|
| `Account` | 29 → 31 | `5320 Purchase Price Variance` (migration `20260910010000`); `1131 Card Clearing` (D21) | migration, D21 |
| `AccountMapping` | 20 → 23 | `purchase_price_variance`; `mobile_money` → MOMO-MTN; `card_clearing` → 1131 (D21) | migration, D21 |
| `Role` | 5 → 6 | new empty `Manager` role (`20260914000200`) | D9 |
| `_prisma_migrations` | 7 → 89 | 7 legacy rows **kept** + 82 repository migrations | README §6 |

New tables that start with rows: `AccountCategory` (29, the category catalogue),
`DocumentTypeDef` (5), `PosTableZone` (6, derived from the 17 legacy tables'
zones and proved by `pos_table_zones`), `PosPaymentMethod` (6, D21). At API
boot, `Permission` 192 → 654 (additive: new permission codes; legacy role
grants are kept, proof `role_permissions_only_widened`).

## 3. Financial history: row by row

Every row of the eight financial tables is hashed on every column the two
schemas share and compared legacy vs migrated:

| Table | Rows | Columns hashed | Missing | Changed | Added | New columns (empty on history) |
|---|---|---|---|---|---|---|
| Invoice | 4,055 | 48 | 0 | 0 | 0 | 10 (fiscal, businessDate, receivableAccountId, …) |
| Payment | 4,267 | 21 | 0 | 0 | 0 | 8 (cashSessionId, refund/void audit, withholding) |
| PaymentAllocation | 4,267 | 7 | 0 | 0 | 0 | 1 |
| Receipt | 8,110 | 11 | 0 | 0 | 0 | 2 |
| JournalEntry | 8,342 | 19 | 0 | 0 | 0 | 3 |
| JournalLine | 16,687 | 16 | 0 | 0 | 0 | 1 |
| InventoryLedger | 10,055 | 18 | 0 | 0 | 0 | 3 |
| CashMovement | 4,260 | 9 | 0 | 0 | 0 | 4 |

The aggregate fingerprint over all tables is **0 unexpected**, 4 allowlisted,
198 informational (new tables and columns). Posted debit = credit =
**202,416,000.000000**, identical per account × month.

New columns on historical rows stay empty. Nothing is back-filled into history,
for example `business_date_not_backfilled`: 0 legacy invoices given a business
date.

## 4. What the migration deliberately changes (each one proved)

| Transformation | Rows | Proof (joined back to `legacy_archive`) |
|---|---|---|
| Chart of accounts: `accountType`/`isGroup` → categories, postable flag, control type; parents wired (D2) | 29 accounts (24 parents wired) | `accounts_preserved` (0 missing, 0 renamed, 0 default changes), `coa_invariant` (0 violations) |
| Order status remap | 4,055 closed, 325–330 cancelled, open → confirmed | `order_status_remap` |
| Product stock policy `silent` → `warn` | 127 | `product_stock_policy` |
| Roles: permissions only widened | 5 legacy roles | `role_permissions_only_widened` |
| Organization settings | every key kept | `organization_settings_preserved` |
| Table zones → configurable zones | 17 tables, 0 lost | `pos_table_zones` |
| Legacy `accountType`, `isGroup` columns dropped | — | originals in `legacy_archive.account` |

## 5. Domain matrix: how each kind of data arrives

| Domain | How it is synchronized | Verified by | Residual action |
|---|---|---|---|
| Sales history (orders, invoices, receipts, payments) | carried as-is | row-by-row hash; counts; invoice number set | none |
| Accounting (journals, COA) | carried; COA re-classified | posted totals per account × month; COA proofs | D5 inventory GL opening adjustment |
| Cash (shifts, movements) | carried as-is | row hash on CashMovement; shift counts | **D19** legacy drawer ledger; D4 unreconciled shifts |
| Inventory (ledger, on-hand) | carried as-is | per product × location qty/value/on-hand; NOT VALID checks validated on 10,055 rows | D6 count; D7 recipes |
| Document numbering | native sequences carried | `next-numbers.sql` reference = migrated; **first new invoice `INV-2026-004136`, receipt `RCT-008200`** (validator 1b on the cutover target) | recomputed from the FINAL backup |
| Products, menu, modifiers, tables | carried; stock policy remapped | counts identical; proofs | brief cashiers (D8) |
| Users, roles, PINs | carried; passwords and PINs unchanged (bcrypt hashes as-is) | User count identical | D12 admin password; D20 cashier register access; D9 Manager |
| Customers / partners | carried as-is | counts identical | credit stays disabled (D10) |
| Settings | carried; new keys added by migrations | `organization_settings_preserved` | D13 backup settings, D14 flags |
| Uploaded files | `File` rows in the dump; files on disk copied by `cutover.ps1 -Phase backup` (robocopy + SHA-256) | backup manifest hashes, offsite verified | new install must point `STORAGE_LOCAL_DIR` at the copied folder (G0) |
| Payment methods (MTN, Airtel) | legacy wallet accounts carried; tiles configured by D21 | `payment-methods-state.txt`; validator split tender cash + MoMo | deactivate unused Card/Bank tiles (D21) |
| Migration history | 7 legacy rows kept + 82 new | `_prisma_migrations`; `legacy_archive.prisma_migrations` | none |
| Offline terminal queues (browser) | **not migrated by design**: must be 0 before freeze; storage cleared after switch | terminal sheets; `freeze` confirmation | terminal checklist |
| Old application, services, nginx | not migrated; kept intact as the rollback | `services.txt` snapshot | — |

## 6. Findings this audit surfaced (not caused by the migration)

| # | Finding | Status |
|---|---|---|
| F1 / D19 | Drawer ledger 101,723,000 (every cash receipt, never booked out). 54 counted shifts show 99,232,000 left the drawer; 311,000 of the ledger was mobile money booked to Cash | owner evidence + signature (`d19-cash-evidence.sql`, SIGNOFF worksheet) |
| F7 / D21 | No `mobile_money` fallback mapping after migration, so an offline-queued MoMo sale would fail on replay | fixed by the D21 step, rehearsed |
| F8 | Tables page "Split bill" (`TableDetailDialog` → `POST /pos/tables/:id/split-bill`) returns 409: the split tabs collide with the one-open-tab-per-table index. The POS screen's split (`/pos/tabs/:tableId/split/*`) works (validator 17) | product fix before M0, or hide the Tables-page button |
| F9 | Cash-control behaviours cashiers must know: the next shift must open with at least the cash left in the drawer (bank it after close); close is refused until stock posting finishes (≤ 30 s); with D21 every tracked tender balance is declared at close | UAT B6/B25; cashier briefing |

## 7. After go-live

`reconcile.ps1` compares the frozen history against the Day 0 capture at the
end of Day 1, 3, 7 and 30. Any change to a pre-cutover number is a FINDING. In
rehearsal, the Day 1 check after live sales passed with no history movement.
