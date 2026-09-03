# Stage 2: kitchen + inventory truth (F10–F14)

Implemented 4 September 2026, on top of [Stage 1](STAGE1_IMPLEMENTATION.md) and [Stage 1.5](STAGE1_5_IMPLEMENTATION.md). Scope: the kitchen/inventory findings F10–F14 from the [original audit](POS_WORKFLOW_UI_READINESS_2026-09-03.md).

**Release position unchanged: staging acceptance only.** Stage 3 (retail/UI) and Stage 4 (deployment/deps/fiscal) remain release gates.

## What changed

### F10 — customized lines no longer share kitchen state

The auto-save `writeItems` deletes an order's items and recreates them, reattaching each line's kitchen lifecycle by a key that was only `productId` (or `menuItemId|variant`). Two lines of the same product with different milk/notes/sides/course collapsed to one key, so an unsent "oat latte" inherited a sent "dairy latte"'s printed quantity, or an already-fired line re-fired.

- `lineKey` is replaced by `lineSignature` (`pos-orders.service.ts`), a signature over the **full** customization: base id + variant + course + trimmed note + sorted modifier ids + sorted accompaniment option ids. `rowSignature`/`resolvedSignature` compute it for a persisted row and an incoming line.
- Lifecycle preservation is now a **one-to-one multiset consume**: old rows sharing a signature form a queue and each new line `shift()`s at most one. Two genuinely identical lines each keep their own lifecycle row instead of both inheriting the last match; two distinct customizations never cross-contaminate.
- Covered by `order/line-signature.spec.ts`.

### F11 — kitchen dispatch is atomic, and cancellation reaches the board

`fireKitchen` read pending quantities, created tickets, then bumped the sent counters in separate un-transacted writes: concurrent sends double-dispatched, a crash left a partial send, and nothing pulled a cancelled order's food off the board.

- `fireKitchen` (`pos-orders.service.ts`) now runs ticket creation **and** the sent-counter bump in one `$transaction`, fronted by a `FOR UPDATE` lock on the order row. A second concurrent send re-reads the just-updated printed quantities inside the tx, sees delta 0, and dispatches nothing; a crash between the two writes rolls both back so a retry recomputes the correct delta. Dispatch is exactly-once.
- `createTicketsForSale` (`pos-kds.service.ts`) accepts the caller's `tx` (ticket + queue-number sequence join the same atomic unit) and defers its `ticket_created` events to the standalone path only, so a rolled-back fire cannot announce phantom tickets.
- New `KdsCancellationSubscriber` consumes `PosOrderCancelled` and calls `PosKdsService.cancelTicketsForOrder`, which cancels every still-active (new/preparing/ready) ticket for the order. Idempotent — served/cancelled tickets are skipped, so a redelivered event is harmless. Registered in `pos.module.ts`.

### F12 — active tickets are never hidden behind the history cap

`listTickets` took the newest 200 rows across **all** statuses, so on a busy day an unfinished ticket could fall off the end behind newer *completed* ones and vanish from the board while still needing cooking.

- With no status filter (the live board's call) `listTickets` now returns **every** active ticket uncapped, ordered priority-first then oldest-first, plus a bounded 50-row slice of recent served/cancelled history so recall still works.
- An explicit status filter queries that status only, newest-first, capped at 500 for history browsing.
- The web board (`KdsPage`) needs no change — it already filters the response into columns client-side.
- Covered by new cases in `pos-kds.service.spec.ts`.

### F13 — combos hidden while paused (decision: hide, not finish)

The checkout guard (`pos-orders.service.ts`) already 400s any combo line, but combos were still buildable and visible, so a user could ring up a line that fails at payment.

- Digital menu no longer advertises combos (`digital-menu.service.ts`).
- Both terminals stop injecting combo tiles behind a `COMBOS_PAUSED` flag (`Terminal.tsx`, `RetailTerminal.tsx`), and the Combos admin nav entry is removed (`app-shell.tsx`). The CRUD route/components stay in place for when combos are finished.
- Finishing combos properly (expanded component quantities, bundle-price allocation across components for tax and partial-refund) is deferred; the dead-but-correct `expandCombosForCheckout` helper is left as the starting point.

### F14 — portions, substitutions and accompaniments can carry stock semantics

Variants held only name/price; modifiers and accompaniment options issued exactly one whole unit of their linked product. "Large" could not consume more recipe, and "extra milk" could not mean 30 ml.

- Schema (migration `20260904000000_pos_portion_semantics`):
  - `MenuItemVariant.qtyMultiplier` — recipe consumption multiplier, **independent of price**. A "Large" priced +30% can still use 1.5× (or 1×) the ingredients.
  - `Modifier.consumptionQty` + `consumptionUomId`, `AccompanimentOption.consumptionQty` + `consumptionUomId` — how much of the linked product one selection consumes, in a given unit (default 1, so unconfigured options are unchanged).
- Consumption path honours them: `issueMenuItemRecipe` multiplies the recipe BOM by the line's variant multiplier; `moveLineExtras` issues `lineQty × consumptionQty` of each option's product in its `consumptionUomId`.
- Configurable through the existing CRUD: variant create/update (`pos-variant.service.ts`), modifier create/update (`pos-modifiers.service.ts`), accompaniment option create/update (`pos-accompaniment.service.ts`), with the fields whitelisted on their controller DTOs. Non-positive quantities/multipliers are rejected.
- **Still deferred** (documented, not built): explicit remove/replace ingredient semantics for substitutions, and nested prepared components. A "milk substitution" is still an added option plus the base recipe unless modelled as separate items or pre-portioned stock.

### Residual carried from F16 (recorded, not yet done)

`waste` disposition still writes no scrap stock move, and the normal posting job still resolves a recipe at process time — a recipe edit between sale and delayed posting still shifts that sale's cost. Both tracked for a later pass.

## Verification

- `pnpm typecheck` — green (shared, api, web).
- `pnpm lint:arch` — no dependency violations (636 modules).
- API unit suite — **437 passed**. Failing suites are environmental/flaky, not from this change:
  - `src/kernel/prisma/rls.spec.ts` and `src/kernel/audit/audit.service.spec.ts` — the local dev DB is behind `schema.prisma` (`The column openingBalance does not exist`); they fail identically before Stage 2.
  - `src/kernel/sequence/sequence.service.spec.ts` — passes in isolation; only fails under full-run DB concurrency.
- New/updated specs pass: `order/line-signature.spec.ts` (F10), `pos-kds.service.spec.ts` (F11 tx create, F11 cancel, F12 board split), and the existing `fireKitchen` routing spec updated for the new transaction.
- `prisma generate` reports the usual Windows `EPERM` on the query-engine dll while a node process holds it; the generated **types** are written (`qtyMultiplier`/`consumptionQty` present), so typecheck is valid. Stop the dev server and re-run `pnpm db:generate` before booting the API.
- Not run (need a migrated disposable DB): `pnpm test:pos:stage1`, and the F10–F14 integration scenarios below.

## Before deploying this

1. Apply `20260904000000_pos_portion_semantics` after the Stage 1 / Stage 1.5 migrations, on a verified backup. It is additive (new nullable/defaulted columns) and backfills nothing — existing variants/options keep 1× behaviour.
2. Recommended integration coverage before a pilot: same item with different milk/sides (F10, one dispatch each), append a second round (F10), two concurrent kitchen sends (F11, one dispatch), cancel-after-fire (F11, board cleared), a busy board with >200 newer tickets (F12, old active still visible), and a variant/option with a non-1 multiplier/consumptionQty (F14, correct stock quantity issued).
3. Combos stay hidden. Do not re-enable the Combos nav / tiles until the combo expansion work (F13) is finished and tested.
