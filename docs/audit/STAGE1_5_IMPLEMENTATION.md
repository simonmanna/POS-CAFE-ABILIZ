# Stage 1.5: closing the three partial findings

Implemented 3 September 2026, on top of [Stage 1](STAGE1_IMPLEMENTATION.md). Scope: the parts of **F04**, **F15** and **F17** that an independent re-verification of the working tree found still open after Stage 1. Nothing else in the audit was touched; F10–F14, F19–F22 and the section-4 UI items remain outstanding.

**This does not change the release position.** Stage 1's assessment stands: staging acceptance only.

## Correction to the Stage 1 record

Two entries in `STAGE1_IMPLEMENTATION.md` are inaccurate against the code as shipped:

- **F16 is done**, not outstanding. It was delivered inside the F05/F06 refund rewrite: `billing/refund-operation.ts:19` requires an explicit `restock | waste | no_return`, `:40` refuses to turn a prepared menu item back into ingredients, and `:89-99` derives the reversal from the **original ledger movements** — rejecting ambiguous locations and serial/batch products — rather than from the current recipe. `receiveLineExtras` had no callers left and has been deleted. Residual, tracked with Stage 2: `waste` writes no scrap stock move, and the normal posting job still resolves a recipe at process time (`pos-invoice.service.ts:1008`), so a recipe edit between sale and delayed posting still shifts that sale's cost.
- **F13 is blocked, not fixed.** `pos-orders.service.ts:717` throws on any `comboId` at the single choke point every sale path passes through, and `expandCombosForCheckout` is now dead code. Combo authoring and the digital-menu combo listing are still live, so a user can build and see a combo that fails at checkout. Stage 2 decides: finish it on top of F10, or hide the authoring.

## What changed

### F04 — an approval now authorises one specific action

`assertCanOverride` accepted any `pos:override` holder and ignored its `overrideKind` argument; `verifyOperationApproval` hardcoded `'discount'`. One blanket right therefore approved discounts, voids, refunds and write-offs alike, and a discount grant redeemed earlier in a request would satisfy a refund check.

- `pos-overrides.service.ts` — `OverrideKind` is now a named union (`discount | price_change | void | manual_refund | write_off | shift_handover`) with an `APPROVER_PERMISSION` map. An approver must hold `pos:override` **and** the right for that specific action.
- `verifyOperationApproval(managerId, pin, overrideKind)` rejects a redeemed grant whose kind differs from the action being performed.
- `PosApprovalGrant.overrideKind` records what the grant authorises (migration `20260903120000_pos_approval_kind`, defaulting existing rows to `discount` — every grant issued so far was a discount approval). The idempotency layer carries it into the operation store as `approvedKind`.
- Callers now name their kind: `pricing-policy.ts` and `pos.service.settleOrder` pass `'discount'`; `refund-operation.ts` passes `'manual_refund'`. The browser derives the kind from the endpoint in `offline-queue.ts` before requesting a grant.
- `pos:write_off` and `pos:price_override` are added to the shared permission catalogue. `pos:write_off` was referenced by the Stage 1 write-off route but existed in no role, so that route was unreachable; `ALL_PERMISSIONS` now grants both to Administrator.

### F15 — an un-deducted extra is a work item, not a log line

Stage 1 threaded the transaction into `moveLineExtras` but left both catch blocks log-only, and the `'line_extras'` failure kind declared at `pos-invoice.service.ts:46` was never constructed.

- `moveLineExtras` returns the components that failed instead of swallowing them.
- `issueStockForItems` records each as an `InventoryException` with `kind: 'line_extras'` and counts it toward the job's `N line(s) need review`.
- Extra movements now carry a deterministic `sourceType: 'pos_invoice_extra'` / `sourceId: '<orderItemId>:<componentId>'`, so a retry cannot book the same extra twice and a ledger row traces back to the modifier or accompaniment option that caused it.
- `receiveLineExtras` (no callers since the F16 refund rewrite) is removed.

### F17 — a collection lands in the drawer of the person who counts it

`requireCashSession` validated only that the session existed and was open, and `receivePayment` passed `allowSessionOwnerMismatch: true` for **every** POS receipt. A cashier could post cash into a colleague's drawer.

- `requireCashSession` now also rejects an inactive/deleted register and a session belonging to another cashier. The message points at shift handover, which closes the outgoing drawer against a blind count.
- `receivePayment` no longer hardcodes the bypass. The refund path keeps it — that is the flow the option was written for, where a `pos:refund` manager pays out of the cashier's drawer.
- A site that genuinely runs one till for several servers sets the POS module config flag `sharedDrawer: true` (`PATCH /pos/settings`, requires `setting:update`). It is off by default, it is an explicit org-level decision to accept a drawer no one person can be held to at close, and it never restores picking a session the caller did not name.

Still open from F17, tracked separately: sessions are not yet bound to a terminal or a branch, only to a register and a cashier.

## Verification

- `pnpm typecheck` — green (shared, api, web).
- `pnpm lint:arch` — no dependency violations (635 modules).
- API unit suite — **50 suites / 430 tests passed**. The two failures are `src/kernel/prisma/rls.spec.ts` and `src/kernel/audit/audit.service.spec.ts`, both pre-existing and environmental: the local dev database is behind `schema.prisma` (`The column openingBalance does not exist in the current database`). They fail identically before these changes.
- Tests updated to the new behaviour rather than around it: `pos.service.spec.ts` now asserts that another cashier's drawer is refused unless `sharedDrawer` is set, and accepts the caller's own; `pos-invoice.service.spec.ts` asserts `allowSessionOwnerMismatch: false` on a collection; `pricing-policy.spec.ts` asserts the discount kind is passed.
- `prisma generate` reports the usual Windows `EPERM` on `query_engine-windows.dll.node` while a node process holds it. The generated **types** are written (`overrideKind` is present in the client), which is why typecheck passes. Stop the dev server and re-run `pnpm db:generate` before starting the API.
- Not run: the integration and browser-recovery gates (`pnpm test:pos:stage1`, `pnpm test:pos:recovery`) need a migrated disposable database; the migration below has not been applied anywhere.

## Before deploying this

1. Apply `20260903120000_pos_approval_kind` after `20260903000000_pos_money_foundations`, on a verified backup.
2. Review who approves what. Tightening `assertCanOverride` means an approver holding only `pos:override` can no longer authorise a refund (`pos:refund`), a void (`pos:void`) or a write-off (`pos:write_off`). Grant the specific rights to the people who should have them **before** cutover, or refunds will be refused at the till.
3. Decide `sharedDrawer` per site before opening a register. Leaving it off is the correct default; turning it on is a deliberate acceptance of a drawer no single cashier reconciles.
