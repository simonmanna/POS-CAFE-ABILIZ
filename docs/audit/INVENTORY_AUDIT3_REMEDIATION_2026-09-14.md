# Inventory audit #3 remediation — 2026-09-14

Source: external "Inventory Management — Production Readiness Audit" (76/100, NOT READY) at `3c0a53d`.

## Code findings — fixed

| ID | Fix | Proof |
|---|---|---|
| INV-P1-02 skip_expired drift | Layered issue falls back to expired lots (conserving quant = Σ lots) only when no valid lot is left; strict callers (`allowNegativeStock=false`+`block`, `requireAvailable`) still refuse. Each fallback raises an `InventoryException` `expired_lot_consumed` for review (blocks period close until resolved). | `inv-audit3-remediation.spec.ts` P1-02 (4 tests) |
| INV-P1-03 serial base quantity | Receive and issue convert to BASE units before serial checks; serial-tracked quantities must be whole base units; `required` policy never writes an un-serialised overflow row; duplicate serials refused. | P1-03 (3 tests: case-of-12 receipt/sale/refund, fractional, overflow) |
| INV-P1-04 transport-safe transfers | `mode: transit` transfers: approve (moves nothing) → dispatch (source → system `transit` location) → one or more receipts splitting received / damaged (waste) / short (adjustment loss) → recall of what is still on the road → reversal of every stage. Immediate transfers unchanged. Header row lock, `StockTransferReceipt` evidence rows, DB check that accounted ≤ dispatched. UI: Stock Transfers page. | P1-04 (3 tests: 20 → 18 + 1 damaged + 1 short → reverse, recall, immediate) |
| INV-P2-01 NOT VALID constraints | `validate:ledger-constraints --apply` run on the dev DB — both constraints VALIDATED. Run it on production after its backup. | script output |
| INV-P2-02 landed cost | `LandedCost` (freight/duty/insurance/handling) on a posted GRN; allocation by value/quantity/equal; on-hand share raises the lot / serial / AVCO cost, consumed share → COGS; Dr Stock + Dr COGS / Cr chosen account in one JE; GRN reversal refused once posted. API `/procurement/landed-costs`; UI panel on goods-receipt detail. | P2-02 (AVCO + FIFO lot) |
| INV-P2-03 count modes | Count types `cycle` (category scope) and `spot` (product scope); `blind` counts mask system qty/variance while draft; `GET /inventory/counts/:id/review` (submit permission) reveals them. UI on Stock Count page. | P2-03 (2 tests) |
| INV-P2-04 reports | `GET /inventory/reports/stock-health`: aging buckets (FIFO layer attribution), turnover, days of cover, slow / dead classification; "Stock Health" tab. | P2-04 |
| INV-P2-05 RBAC visibility | Sidebar: adjustments/transfers use `inventory_doc:read`; transfer and landed-cost buttons gated by the same permissions the API enforces. | typecheck |
| INV-P2-06 offline replay | New certification `pos-offline-inventory-replay.spec.ts` (stage-1 DB): out-of-order batch, duplicate delivery, crash between invoice commit and stock posting, double job processing, offline partial refund, failed-dependency dead-letter — quant = ledger, Stock GL = ledger value, COGS GL = issues − restocks. **Found and fixed a real defect:** `sale.refund`/`sale.void` replays never passed `stockDisposition` (nor `overridePin`), so the server rejected every offline refund. Missing disposition now defaults to `restock`, matching what the Android client already did locally. | 5/5 |
| INV-P3-02 Jest exit | Full API suite exits cleanly without `--forceExit` (96 suites, 819 passed, 53 skipped, 0 failed, 84 s). | full run |
| INV-P1-01 negative stock | Default stays permissive (owner rule: never block a sale). Preflight now reports valuation exposure per negative quant and warns until `inventory.allowNegativeStock` is an explicit, recorded setting. Per category/product enforcement already exists (`allowNegativeStock=false` + stock policy `block`, `inventory.atpMode=strict`). | preflight |

Migration: `20260914001300_inventory_transit_counts_landed_cost` (additive; RLS on new tables).

## Still open — decisions, not code

1. **Opening inventory UGX 2,275,800 absent from GL (INV-P0-01).** On the dev DB the dry run shows 41 rows / 2,275,200 came from `backfill:opening-ledger` (seeded demo stock) + 600 other. For the *production* database: run the preflight there. If the stock is genuine, map `opening_balance_equity` and run
   `pnpm --filter @erp/api backfill:inventory-gl-gaps --post-opening-balances --apply` after a physical count. If it is demo stock, write it off with a counted adjustment instead. Accountant sign-off required.
2. **Cash shifts** (1 open > 24 h, 2 unreconciled) — close / reconcile in Cash Sessions.
3. **13 negative quants** — count them physically (Stock Count → spot check) and record the negative-stock policy decision.
4. **1 pending adjustment > 7 days** — approve or cancel.
5. **Offline manager approval:** the Android client verifies the manager PIN on-device and sends only `overrideById`; the server still requires a PIN or transaction-bound grant, so offline refunds/voids dead-letter for that reason. Decide: send the PIN in the queued op, or accept a device-verified approval server-side.
6. Backup/restore drill, `pnpm release:gate`, production preflight = READY.
