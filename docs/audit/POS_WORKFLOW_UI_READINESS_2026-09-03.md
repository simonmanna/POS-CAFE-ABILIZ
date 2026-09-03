# POS-CAFE: deployment, workflow, selling UI, kitchen and inventory audit

Date: 3 September 2026. Reviewed the current working tree, including existing uncommitted changes.

**Decision: do not deploy this version for unattended trading or customer rollout.** It has substantial functional coverage and a useful architecture, but confirmed defects affect totals, approvals, refunds, store credit, kitchen quantities and recovery. Both web and API type-check gates fail. A successful ordinary sale and a green unit suite do not establish operational stability.

This is a code and automated-check audit, with a limited browser inspection of the entry screen. Authenticated browser inspection was blocked by automatic approval review because demo credentials were found in repository documentation rather than supplied or authorized by the user. No authenticated selling, kitchen or back-office screen was visually verified. UI observations below are identified as implementation-based, and visual/hardware acceptance remains outstanding. No live sales, refunds, database resets, migrations or deployments were performed.

## 1. Evidence and boundaries

| Check | Result |
|---|---|
| Repository and workflow review | Traced restaurant/retail terminal, cart, order saving, checkout, billing, payment, refund, modifiers, accompaniments, recipes, KDS, cash sessions, offline replay, CI and Docker configuration |
| Workspace typecheck | Failed in web: unsupported `onFireCourse` prop and implicitly typed `course` parameter |
| Separate API typecheck | Failed in two integration fixtures: missing required `Document.documentTypeId` |
| Existing non-integration API suite | **50 suites, 427 tests passed**; Jest reported an open-handle warning and remained alive after completion, so the lingering test command was stopped |
| Focused audit reproductions | **Seven observed defects reproduced** using actual service methods with in-memory doubles; no database or network transactions |
| Production dependency audit | **47 reported advisories: 15 high, 28 moderate, 4 low, 0 critical**; exploitability and production reachability are not established by this count |
| Browser inspection | Local sign-in screen reached; authenticated inspection blocked pending authorization |
| Not established | Real cash/GL reconciliation, database integration results, migration/restore success, production build/container startup, concurrent terminals against PostgreSQL, printer/scanner behavior, sustained load, power-loss recovery |

The [reproduction harness](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/docs/audit/2026-09-03-reproductions.cjs) and [captured results](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/docs/audit/2026-09-03-reproduction-results.json) are repeatable evidence. Run `node docs/audit/2026-09-03-reproductions.cjs` from the repository root. Its assertions describe defects in the current implementation; passing them is **not** a release approval. Dependency details are in the [scan output](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/docs/audit/2026-09-03-dependencies.json).

Earlier audits describe different code states. Their readiness percentages should not be used as acceptance evidence for this working tree. The findings here do not mean every past fix failed: several safeguards are present and working at the unit-test level.

## 2. What is already implemented

This is much more than a basic shopping-cart application. The Order → Invoice → Payment/Receipt separation is useful. There are decimal money calculations, configurable account mappings, transactional payment allocation, invoice row locks during payment, audit records, tenant scoping, inventory posting jobs and exception records. These are good foundations to retain.

| Area | Implemented foundation | Current assessment |
|---|---|---|
| Café counter | Category/product tiles, search, variants, extras, notes, discounts, payment dialog, receipts | Broad coverage; totals, permissions, retry and stock issues prevent sign-off |
| Restaurant floor | Tables/zones, reservations, open orders, rounds, move/merge, splitting, bill/KOT actions | Substantial implementation; kitchen identity, synchronization and settlement failures remain |
| Kitchen | Stations, tickets, new/preparing/ready/served flow, recall, urgency, timers, multiple board layouts, bulk actions | Useful operational design; dispatch and visibility guarantees need repair |
| Retail | Dedicated terminal, product search, barcode lookup, held orders, customer selection, shared till controls | Suitable direction for a simple shop; catalog scale, scanning, returns and variation workflows need validation |
| Cash | Float, movements, counted close, variance reasons/approval, handover, deposits, X/Z reporting | Many controls exist; account routing, refund tender handling and shift closure are not dependable enough |
| Customer accounts | Named customers, credit hold/limit, credit settlement and collections UI | House-account credit is distinct from prepaid store credit; the latter has a serious settlement gap |
| Menu/inventory | Menu recipes, UOM conversion, modifiers/accompaniments with product links, stock exception monitor | Model cannot yet represent all portion and substitution requirements accurately |
| Operations | CI, migration/drift checks in CI, backup tooling, health endpoints, structured logs, offline queue | Present but not demonstrated as a deployable, recoverable release |

**Café:** a realistic target after the core corrections and a supervised pilot.  
**Full-service restaurant:** additionally needs reliable course/round/cancellation behavior and kitchen-to-server handoff.  
**Retail shop:** basic packaged goods are a realistic target; do not promise a complete general retail solution for weighted, serialized, expiry-sensitive or size/color stock until those selling workflows are proven.

There is no single universal “full POS” feature list. Readiness should be agreed for a named business profile and hardware setup. Established restaurant systems distinguish floor/table service, kitchen communication and bill splitting; see the [Odoo restaurant documentation](https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/restaurant.html). Retail acceptance must include the actual scanner, receipt printer and drawer combination, not just browser buttons; see [Shopify’s hardware overview](https://help.shopify.com/en/manual/sell-in-person/hardware/).

## 3. Deployment blockers and correctness findings

Priority meanings: **P0** = release cannot proceed; **P1** = fix before enabling the affected real-money workflow; **P2** = improvement or narrower functional limitation. “Code-confirmed” describes a specific implementation defect, not a claim that it was executed against your database.

### F01 — P0: the current release does not pass compilation gates

The terminal supplies `onFireCourse`, which is absent from `OrderPanel.Props`; its callback parameter is also implicitly `any`. The web build includes TypeScript checking, so this is a release blocker rather than a cosmetic warning. Separately, API typechecking fails in `invoice-to-payment.spec.ts:102` and `pos-print-lifecycle.spec.ts:16`, where fixtures omit the required document type relation.

**Change:** finish the course-control contract or remove the incomplete wiring; update fixtures to the current document schema; require both typecheck and actual production artifact builds on the release commit.

Evidence: [Terminal.tsx:1783](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:1783), [OrderPanel.tsx:60](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/OrderPanel.tsx:60), [invoice-to-payment.spec.ts:102](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/test/integration/invoice-to-payment.spec.ts:102), [pos-print-lifecycle.spec.ts:16](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/test/integration/pos-print-lifecycle.spec.ts:16).

### F02 — P1: payment method and ledger account depend on the selling route

Counter checkout maps a single bank tender to `cash`; invoice generation therefore debits the default cash account, and subsequent payment skips GL posting. A bank transfer can increase accounting cash instead of the bank balance. This mapping was reproduced.

Order-backed settlement uses an AR invoice and then the generic payment service. That service chooses bank only for the literal method `bank`; `card` and `mobile_money` select default cash. The newer order-backed UI path can therefore book a card collection differently from counter checkout. Register-specific cash accounts are also not selected by these sales paths, although cash movements/variance handling use them.

**Change:** use one explicit tender-to-account resolver shared by counter, order, split, credit collection and refund. Separate physical drawer cash, bank, card clearing, mobile-money wallet and prepaid credit liability. Choose drawer account from the actual register. Test identical tenders through every route and compare resulting account balances.

Evidence: [pos.service.ts:1328](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos.service.ts:1328), [pos-invoice.service.ts:967](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:967), [payment.service.ts:161](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/invoicing/payment/payment.service.ts:161).

### F03 — P1: spending store credit does not consume the customer balance

The settlement loop recognizes `store_credit` and selects its account mapping, but does not validate/decrement the customer's StoreCredit balance or create the redemption ledger record. `redeemCredit` exists separately and is not called by checkout/settlement. The payment dialog limits spending using the displayed balance, which does not secure the API or atomically reserve funds.

**Impact:** the same prepaid balance can remain available after being spent; API calls and simultaneous tills are not protected by the UI cap.

**Change:** lock the credit balance and perform debit, redemption ledger, payment allocation and receipt creation in the same transaction. Restore credit through the original redemption on reversal. Explicitly distinguish “use prepaid credit” from “charge on account.”

Evidence: [pos-invoice.service.ts:411](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:411), [pos-loyalty.service.ts:195](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-loyalty.service.ts:195), [PaymentDialog.tsx:124](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/PaymentDialog.tsx:124).

### F04 — P1: price/discount and manager-approval controls are inconsistent

The base checkout price is client-supplied for a non-variant item. There is no server-side comparison with the catalog price or explicit price-change authorization. A lowered unit price can bypass a discount threshold because it is not represented as a discount.

The order-backed settle path only verifies an override **if one is supplied**. It does not call the checkout discount-threshold check. The directly exposed order invoice route likewise allows the billing service to accept discounts under `pos:checkout`. Refund approval checks that a submitted manager ID has `pos:override`, without proving that manager approved this refund; the refund DTO has no PIN/approval token. Write-off is gated by `pos:reports`, a reporting permission.

**Change:** centralize a server-side pricing/approval policy covering all routes. Add separate rights for discount, price change, refund, write-off and void-after-send. Verify transaction-bound, short-lived manager approval at the point of action. Record original price, final price, reason, cashier and approver. UI hiding remains useful but is not the security control.

Evidence: [pos-orders.service.ts:723](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:723), [document-builder.service.ts:127](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/invoicing/document/document-builder.service.ts:127), [pos.service.ts:891](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos.service.ts:891), [pos-orders.controller.ts:150](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.controller.ts:150), [pos-orders.controller.ts:173](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.controller.ts:173), [pos-overrides.service.ts:124](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-overrides.service.ts:124).

### F05 — P1: refunds do not reliably reverse the original payment chain

Full refund reverses the original invoice journal, then treats all `amountPaid` as cash if an eligible drawer is available. It creates a cash refund with GL posting skipped. A card or mixed-tender sale can therefore produce an incorrect cash withdrawal.

For an order-backed sale, the invoice journal originally debited AR and a separate receipt journal collected payment. Reversing only the invoice journal does not reverse that receipt journal. The refund logic also infers the counter-account from the **current** payment mode, which can differ from the mode used to create the invoice journal.

**Change:** refund original payment allocations and actual collection journals. Let the operator choose an allowed refund destination explicitly; retain original tender proportions by default. Never mark money returned solely because invoice revenue was reversed. Cover cash, bank, card, mobile money, mixed, partly paid and later-collected credit.

Evidence: [pos-invoice.service.ts:633](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:633), [pos-invoice.service.ts:659](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:659), [pos-invoice.service.ts:803](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:803), [pos-invoice.service.ts:867](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:867).

### F06 — P1: refund quantity validation has exploitable edge cases

The partial refund path locks the invoice, which is good, but checks duplicate line selections independently against the same original quantity. The harness submitted the same one-unit line twice: it refunded 20 for a 10-value unit while writing `refundedQty=1` twice. An invoice with sufficient other value passes the invoice-level cap.

The full-refund branch checks only whether the whole invoice is already refunded. After a partial refund, it can reverse/restock the full original quantities rather than the remainder.

**Change:** aggregate or reject duplicate line IDs before validating; update refund quantities once per line; make “refund remaining” derive from prior refunds and original payment allocations. Keep full and partial refund semantics in one protected operation.

Evidence: [pos-invoice.service.ts:725](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:725), [pos-invoice.service.ts:823](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:823), [pos-invoice.service.ts:629](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:629).

### F07 — P1: retry protection and compensation can damage a successful sale

The idempotency record is completed after the business handler returns. If that completion write fails, the catch block deletes the key even though the business operation may already have committed. The harness reproduced two committed handler executions under the same key.

Settlement also automatically refunds on **any** payment error. A second settlement arriving after the first has paid the invoice can receive “already fully paid” and trigger refund of that valid payment. The harness reproduced this compensation decision. Invoice generation has its own lock/unique relationship, so the concern is not simply “no locking”: the order/table lock in `settleOrder/settleTab` ends before the settlement operation, and the fallback compensation does not distinguish who committed the invoice/payment.

**Change:** bind a durable operation ID to business records; recover status after ambiguous failure; make completion recording recoverable; never undo an existing successful payment merely because a second attempt is rejected. Use a single settlement transaction where feasible and a durable state machine for external side effects.

Evidence: [idempotency.service.ts:146](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/kernel/idempotency/idempotency.service.ts:146), [pos.service.ts:840](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos.service.ts:840), [pos.service.ts:934](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos.service.ts:934), [pos-invoice.service.ts:201](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:201).

### F08 — P1: displayed total is not the authoritative payable total

The cart total sums unit price × quantity minus discounts; it does not add exclusive tax. The backend tax engine does. For a hypothetical item priced 10,000 excluding 18% tax, the UI can ask for 10,000 while the invoice requires 11,800. Exact-payment tenders then fail or require correction after billing has begun.

Server repricing of extras/variants can also change an amount after the cashier has viewed it. Cart and receipt fallback totals are locally calculated rather than a final agreed server quote.

**Change:** return a priced order/quote with subtotal, each discount, tax, charges, rounding, total and pricing version. The payment dialog must use that total. Before payment, explicitly refresh/reconfirm price changes; offline calculation needs the same versioned pricing rules.

Evidence: [cart.store.ts:241](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/features/pos/cart.store.ts:241), [Terminal.tsx:466](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:466), [document-builder.service.ts:146](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/invoicing/document/document-builder.service.ts:146).

### F09 — P1: a failed order save can be followed by settlement of stale items

Both terminals catch and ignore failures in `flushCurrentOrder`, then proceed to settle the server order. This can bill an earlier cart state after a conflict/network failure. Equal-price replacements are particularly dangerous because the tender can still match while the wrong stock/kitchen items are billed. A “New order” switch can also clear local work after a failed flush.

The autosave signature omits fields including fixed discount amount/type, course, modifier IDs and accompaniment IDs. Some changes therefore do not reliably trigger saving. Some full-replace calls omit the version token.

**Change:** payment and order switching must await a confirmed save/version, or retain the unsaved cart visibly. Use stable item IDs and a complete mutation model, not a partial signature. Show “Saving,” “Saved,” “Conflict,” and “Offline” as durable states.

Evidence: [Terminal.tsx:104](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:104), [Terminal.tsx:820](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:820), [Terminal.tsx:1233](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:1233), [RetailTerminal.tsx:343](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/RetailTerminal.tsx:343).

### F10 — P1: customized order lines share kitchen lifecycle state

The server's lifecycle key uses product ID, or menu item plus variant name. It ignores notes, modifiers, accompaniments, courses and stable line identity. A large oat latte and a large dairy latte produce the same key; this was reproduced. During save/append, the old rows are deleted and rebuilt, and the last matching lifecycle record can be assigned to both lines.

**Impact:** an unsent customized line can inherit a sent quantity, or an already sent line can be sent again. Appending another round of the same product is vulnerable too.

**Change:** preserve OrderItem IDs and apply line-level changes. Track the sent delta per immutable line/revision, including customization. Changes to already-fired food require an explicit amendment/cancellation event.

Evidence: [pos-orders.service.ts:779](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:779), [pos-orders.service.ts:826](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:826), [pos-orders.service.ts:859](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:859).

### F11 — P1: kitchen dispatch is not an atomic, recoverable operation

Kitchen send reads pending quantities, creates tickets, then updates sent counters through separate writes. Concurrent sends can both dispatch the same quantity; the harness reproduced this. A crash between ticket creation and counter update can cause a duplicate on retry; a partial station failure can leave some tickets dispatched and others missing. Counter checkout catches dispatch failure and continues without a durable cashier-facing recovery record.

Cancelling an order publishes an event, but the reviewed code has no corresponding KDS cancellation consumer. Reducing/removing a fired item through full replacement does not reliably produce a kitchen cancellation.

**Change:** write a durable kitchen dispatch/amendment event and per-line revision in the order transaction. Consume it idempotently per station. Surface pending, delivered and failed states, with retry/reprint that does not create another preparation order. Cancelled food must require kitchen acknowledgement.

Evidence: [pos-orders.service.ts:462](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:462), [pos-orders.service.ts:506](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:506), [pos-kds.service.ts:120](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-kds.service.ts:120), [pos.service.ts:225](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos.service.ts:225), [pos-orders.service.ts:363](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:363).

### F12 — P1: active kitchen tickets can disappear behind a history limit

The default KDS list returns the newest 200 tickets across all statuses, then the UI builds its live board from that response. An old unfinished ticket can fall outside the response after sufficient newer tickets, including completed ones. This is especially relevant during a busy day.

**Change:** fetch all active tickets independently of paginated history; sort active work by due/age/priority; keep served/cancelled history separate. Add station/branch scoping and an alert for long-open tickets.

Evidence: [pos-kds.service.ts:214](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-kds.service.ts:214).

### F13 — P1: combo component quantities are discarded

The combo helper calculates component quantity × number of bundles correctly, but order resolution copies the parent quantity instead of the expanded quantity. The harness used three meals containing two sandwiches each: expected six sandwiches and three drinks; result was three and three.

**Change:** preserve expanded component quantity, retain parent combo identity, and allocate bundle value deliberately. Merely changing quantity can multiply the price of the first component if it still carries the entire bundle price per unit. Keep bundle price, kitchen quantities, component stock and refund allocation consistent.

Evidence: [pos-modifiers.service.ts:937](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-modifiers.service.ts:937), [pos-orders.service.ts:759](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/order/pos-orders.service.ts:759).

### F14 — P1: portions, substitutions and accompaniments lack sufficient stock semantics

Menu variants contain name/price/order/status but no recipe or quantity multiplier. Both small and large drinks consume the same base menu recipe. Extra options link to one stock product and issue `lineQty` units; there is no per-option consumption quantity/UOM/recipe in this path. “Extra milk” cannot directly mean 30 ml, and “fries side” cannot directly mean a multi-ingredient preparation.

A milk substitution is currently an added option plus the base recipe; there is no explicit remove/replace ingredient semantics. Unless setup uses separate sellable menu items/preportioned stock, ingredient consumption can be wrong.

**Change:** support variant recipe overrides or multipliers, option quantity/UOM, nested prepared components, and replacement rules. Keep service instructions (“no ice”) distinct from stock-consuming add-ons. Retain an explicit configuration workaround for simple deployments: separate menu items per portion, with their own recipes.

Evidence: [schema.prisma:2509](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/prisma/schema.prisma:2509), [schema.prisma:2593](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/prisma/schema.prisma:2593), [pos-invoice.service.ts:914](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:914), [pos-invoice.service.ts:1306](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:1306).

### F15 — P1: extra stock issues escape the posting-job transaction

The job wraps base item/recipe issues and completion in a transaction, but `moveLineExtras` calls `stock.issue(args)` without passing that transaction. Add-on stock may commit even if the parent job later rolls back; retry can consume it again. Add-on failures are logged, rather than included in the structured inventory failure count.

**Change:** pass the same transaction for every stock movement and use deterministic movement IDs per invoice line/component. Record extra failures in the same exception monitor. Test a forced crash after the first extra and before job completion.

Evidence: [pos-invoice.service.ts:1134](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:1134), [pos-invoice.service.ts:914](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:914).

### F16 — P1: financial refund automatically puts ingredients back into usable stock

Full and partial refunds restore products/recipes unconditionally when a warehouse exists. A refund for a burnt meal or an already-consumed drink must not restore raw ingredients. The reversal reads the **current** recipe and location settings, rather than an immutable record of the original consumed ingredients/location. Editing a recipe between sale and refund can return different ingredients.

The normal stock job also resolves the recipe at processing time. Delayed posting plus recipe edits can therefore change the cost/stock meaning of an already billed sale.

**Change:** separate financial refund from goods disposition: restock sealed goods, quarantine, waste, no physical return, or void-before-preparation. Snapshot the consumption plan and link reversals to original stock moves; coordinate pending/failed jobs with returns. Do not require a cash refund to undo legitimate food consumption.

Evidence: [pos-invoice.service.ts:640](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:640), [pos-invoice.service.ts:784](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:784), [pos-invoice.service.ts:1354](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:1354), [pos-stock-location.ts:15](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/inventory/pos-stock-location.ts:15).

### F17 — P1: shift controls can allocate cash to the wrong drawer or close too early

A stale/missing session falls back to any open session in the organization, without terminal/register/branch scoping. On multiple tills this can charge another drawer. The shift-close unfinished-order query still uses legacy statuses and omits canonical `confirmed`/`in_progress`; those orders can be missed. Close is also not serialized against payment/movement writes with a shared session-row lock.

Cash movement/deposit/variance GL failures can be swallowed into an audit marker while the drawer operation proceeds. This means a successful close is not proof of a reconciled ledger.

**Change:** bind terminal → branch → register → session explicitly; require a clear handover/reassignment for stale sessions. Use canonical active states. Lock the session for close and money writes. Make unposted cash movements a visible financial exception that must be resolved before accounting close.

Evidence: [pos.service.ts:1222](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos.service.ts:1222), [cash-session.service.ts:215](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/accounting/treasury/cash-session.service.ts:215), [cash-session.service.ts:236](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/accounting/treasury/cash-session.service.ts:236), [cash-session.service.ts:1345](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/accounting/treasury/cash-session.service.ts:1345).

### F18 — P1: offline replay changes the original operation and has inconsistent coverage

`enqueueSale` adds/replaces `occurredAt` after the original online attempt. The idempotency service hashes the body, so a response-lost sale can replay with the same key but a different body and be rejected. The tab-settle fallback additionally omits original discount, customer and approval fields.

The queue has a single origin-wide store without an immutable organization/operator identity per operation; replay uses the currently logged-in API client. A login/organization change can misattribute or reject old work. The newer order-backed payment branches only show an error on network failure, while the counter fallback queues a sale. “Offline-ready” therefore does not describe all selling paths equally.

**Change:** create the complete immutable operation envelope before the first attempt: tenant, operator, terminal, session, order ID, timestamp, version, exact payload and key. Persist/replay it unchanged, disallow replay under another tenant, and support order-backed settlement deliberately. Display receipts as pending versus confirmed, with original operator and reconciliation status. Treat 401/409 recovery separately from permanently rejected sales.

Evidence: [offline-queue.ts:161](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/features/pos/offline-queue.ts:161), [offline-queue.ts:267](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/features/pos/offline-queue.ts:267), [Terminal.tsx:1207](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:1207), [Terminal.tsx:1229](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/Terminal.tsx:1229), [idempotency.service.ts:101](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/kernel/idempotency/idempotency.service.ts:101).

### F19 — P1/P2: retail catalog and scan behavior need consolidation

The product picker fetches only page 1 and filters the category locally. Categories can omit stock that exists beyond that first page. A retail scanner currently has both an immediate search/lookup effect and a separate debounced scan path. The debouncer suppresses identical codes within 800 ms, which conflicts with intentionally scanning two identical items rapidly; overlapping async lookup paths also need protection from stale results.

**Change:** server-side category filtering and pagination/virtualization; one scanner input pipeline with clear termination and duplicate-event handling. Distinguish duplicate transport events from two physical scans. Support packaging barcodes, variable-weight codes or scales only when their unit and price semantics are implemented and tested.

Evidence: [api.ts:42](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/api.ts:42), [RetailTerminal.tsx:401](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/RetailTerminal.tsx:401), [scanner-debounce.ts:23](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/scanner-debounce.ts:23).

### F20 — P1: production packaging and database isolation are not a proven deployment path

Compose starts the API in production using the database container's superuser credentials. The API's production posture check refuses that unless an explicit bypass is configured. Moving to a non-superuser alone is insufficient: tenant context is set for interactive transactions, while ordinary reads and batch transactions do not receive that context.

The web image bakes `http://localhost:3000` as its API address. On another terminal, localhost refers to that terminal. The provided nginx config has no API reverse proxy. The API runtime stage also tries to build the shared package after a production-only dependency install, although TypeScript is a development dependency; Prisma generation occurs in the build stage, while runtime installs fresh dependencies with scripts disabled. This packaging needs an actual clean-container build/start rehearsal.

**Change:** define one supported deployment topology, preferably same-origin TLS with an API proxy; configure non-superuser runtime access with functioning tenant context; separate migration credentials; package the generated Prisma client and prebuilt shared library correctly. Restrict database/Redis/admin interfaces to the intended private boundary. Verify from a second physical terminal.

Evidence: [docker-compose.yml:39](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/docker-compose.yml:39), [Dockerfile.api:27](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/infra/docker/Dockerfile.api:27), [Dockerfile.web:14](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/infra/docker/Dockerfile.web:14), [nginx.conf:1](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/infra/docker/nginx.conf:1), [prisma.service.ts:63](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/kernel/prisma/prisma.service.ts:63), [prisma.service.ts:126](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/kernel/prisma/prisma.service.ts:126).

### F21 — P1: dependency advisories need remediation and documented triage

The production dependency scan reports 15 high advisories, including dependency paths through upload handling, email/template tooling and supporting libraries. Some reported browser dependencies reference Node-only behaviors, and some transitive tooling may not be reachable at runtime. Do not equate package counts with exploitable endpoints, but do not ship without triage.

**Change:** update/replace affected direct dependencies, regenerate the lockfile, identify reachable input paths and record justified exceptions. Verify the deployed image, not only the development install. Retain the raw scan as evidence.

Evidence: [dependency scan](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/docs/audit/2026-09-03-dependencies.json).

### F22 — conditional P1: fiscalization is only a placeholder

The fiscalization method logs a pending audit entry when a provider is configured; it does not submit/sign invoices or persist the fiscal response/QR data. Setting `FISCAL_PROVIDER=efris` does not implement EFRIS.

If deploying to a Ugandan VAT-registered business, URA states that EFRIS is compulsory for VAT-registered taxpayers. Use a verified integration or an explicitly documented compliant external invoicing workflow; the current flag is not a compliance solution. Confirm the individual business's requirements with its accountant. [URA EFRIS handbook](https://ura.go.ug/en/efris-handbook/).

Evidence: [pos-invoice.service.ts:1290](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/billing/pos-invoice.service.ts:1290).

## 4. Detailed selling-interface review

These recommendations are based on component behavior and styling; they are not a claim of completed visual usability testing.

**Keep:** category strip, image tiles, large numeric keypad, selected-line editing, visible total, separate restaurant/retail views, customer account information, tender list and change display. These are appropriate foundations for touch selling.

**Make the next action clear.** “Bill,” “KOT,” “Pay,” “Settle,” table settlement and “More” expose overlapping actions. Choose visible labels such as “Send new items,” “Print bill,” and “Take payment.” Show the current order number, table/order type, customer, cashier and register consistently. Explain whether a printed bill is provisional or a posted invoice.

**Make saves and delivery visible.** Add a small persistent state bar: order saved/version, pending kitchen items, kitchen delivery status, payment status and offline sync status. Toasts alone disappear too quickly to protect a busy cashier from a failed save or missed kitchen ticket.

**Reduce customization friction.** The implementation can take a cashier through separate variant, accompaniment and add-on dialogs. Prefer one item sheet with defaults, required selections first, optional extras collapsed, clear price changes and a single “Add” action. Simple coffee should add in one tap; a customized meal should have one coherent confirmation. Reopening an existing line should edit its full customization without reconstructing it manually.

**Do not silently replace selections.** The accompaniment picker removes the first selected option when the maximum is reached. For “choose two sides,” tapping a third option silently replaces one. Block with a clear limit message or make the replacement explicit. Validate defaults against maximum as well as minimum. Server enforcement should honor `isRequired` even when configuration has `minSelect=0`. See [AccompanimentPicker.tsx:52](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/AccompanimentPicker.tsx:52) and [pos-accompaniment.service.ts:535](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-accompaniment.service.ts:535).

**Use one money display.** OrderPanel hardcodes UGX while other components use organization currency with an IDR fallback. Centralize locale, currency, precision and rounding. Show tax-inclusive/exclusive behavior and applied discount value clearly. See [OrderPanel.tsx:102](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/OrderPanel.tsx:102).

**Speed up payment.** An exact cash sale currently needs amount entry/addition and then settlement. Add an exact-cash action and denomination buttons, while retaining multi-tender editing. Show “Amount entered” or “Applied” until the sale is confirmed; “Paid” is misleading for unsaved tender rows. Make provider confirmation distinct from manually recording card/mobile-money payment. Prevent dismissal/editing during a submitted payment or provide safe status recovery.

**Show the real reason for a failure.** Prefer the server's actionable message over generic Axios text. Preserve the order and input after rejection; offer reload/resolve conflict, retry dispatch or review pending payment. Do not close a workflow just because its handler swallowed an error.

**Tailor each operating mode.** Café should prioritize takeaway name/number and fast favorites. Restaurant should prioritize table, course, seat/guest, send-round and bill split. Retail should prioritize barcode, quantity/UOM, customer, price and return/exchange. Organization-wide mode configuration is useful for a simple business, but mixed café/retail operations need terminal-specific capabilities.

**Validate touch and responsive layouts.** The main POS layout allocates a fixed 360/400 px order column. At smaller tablet widths this can crowd the product grid. Test 1024×768, 1280×800, 1366×768 and a narrow handheld layout with long item names, 30-line orders and dialogs. Review focus, keyboard access, contrast and touch target size. Separate scroll areas should not hide Pay or lose the selected item. See [pos-pro.css:241](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web/src/pages/pos/pos-pro.css:241).

**Remove unsupported operational claims.** The login screen advertises 99.9% uptime, sub-200 ms sync and offline readiness. Those are not measurements established by this audit. Replace them with factual feature descriptions until supported by monitored service results.

## 5. Menu and inventory design to complete

Keep these concepts distinct in both data and UI:

| Concept | Meaning | Required behavior |
|---|---|---|
| Stock product | Coffee beans, milk, packaged juice, finished cake slice | Stock UOM, sales UOM, cost, location, barcode, purchasing and valuation |
| Menu item | A sellable latte or plated meal | Price/tax, availability, station, preparation instructions and recipe |
| Variant | Small/large; single/double | Absolute/delta price policy plus correct ingredient quantities or alternative recipe |
| Instruction modifier | No ice, well done | Kitchen instruction; no invented stock issue |
| Paid add-on | Extra shot, cheese, topping | Price plus defined ingredient/finished-product consumption |
| Included accompaniment | Choose rice or fries | Choice limits, default, substitution/upcharge, recipe/UOM and station routing |
| Combo | Meal bundle | Parent price, selected components, correct component quantities, tax and refund allocation |

Before menu publication, add a validation screen showing missing recipes, invalid default selections, required groups with no available option, missing tax/account/station configuration and inactive linked inventory. An empty recipe for a tracked item currently becomes a later inventory exception; setup should identify it before the first sale.

Availability needs an intentional policy: manually sold out, schedule/daypart, or recipe-derived remaining portions. Validate at order acceptance as well as catalog display, and decide how an existing open order behaves if a dish becomes unavailable. Show meaningful warnings without allowing silent changes to ingredients or extras.

Recipe costing should include UOM conversion, yield/waste, preparation batches and variant differences. Freeze the relevant recipe and costs for historical audit/reversal. Add menu margin and actual-versus-theoretical consumption reports only after the underlying movements reconcile.

Accompaniment reporting still references legacy order/document shape and returns zero revenue; it should be rebuilt from canonical invoice lines and recorded selections before being trusted. See [pos-accompaniment.service.ts:563](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api/src/modules/pos/pos-accompaniment.service.ts:563).

For retail, distinguish menu-size variants from inventory-tracked SKU variants. A shirt size/color needs its own barcode and stock balance; it is not merely a different menu price. Add weighted goods, packaging conversions, lot/expiry or serial selection only for shops that actually need them, and exercise those choices at the selling interface.

## 6. Cash and kitchen operating workflows

A dependable cash day should be:

1. Open a specific register with counted float and named cashier.
2. Accept a priced order; record each tender in its actual cash/bank/wallet/clearing account.
3. Record expenses, pay-outs, safe drops and deposits with a reason and account.
4. Keep refunds tied to original payments and a separately recorded stock disposition.
5. Close against counted physical cash, with pending orders/payments/sync/postings visible.
6. Reconcile card and mobile-money settlement separately, including fees and timing differences.
7. Approve variance, lock the accounting period and retain a reproducible Z-report.

Do not require physical cash to equal total sales. Credit, cards, mobile money and store credit have different reconciliation paths. A balanced journal is necessary but can still contain the wrong cash/AR account; compare the journal with drawer movements, allocations and provider settlement.

A dependable restaurant round should be:

1. Create/select table and guest/seat; add distinctly identified items and customizations.
2. Send only the new round/course.
3. Confirm delivery at each station; retain pending dispatches.
4. Track preparation, ready and served independently of payment.
5. Send and acknowledge amendments, cancellations, remakes and waste.
6. Let expo see whether all stations for an order/course are ready.
7. Split/pay without creating duplicate kitchen work or releasing the table too early.

Existing KDS layouts, priority, recall and timers are valuable. Add visible connection age, stale-board warning and audio-unlock handling on the actual device. Avoid marking a whole multi-station order ready merely because one station completed its ticket. Keep completion history immutable through recall/remake.

## 7. Functionality to add or strengthen by business type

These are scope recommendations, not claims that every store needs every feature.

| Business | Must be reliable for launch | Additional capabilities to assess |
|---|---|---|
| Café | Fast cash/card/mobile payment, sizes/extras, takeaway identifier, accurate milk/coffee consumption, receipt/printer recovery, close/reconcile | Favorites, daypart menus, sold-out portions, loyalty integrated with payment, customer-facing pickup display |
| Restaurant | Table/guest service, rounds/courses, station routing, cancellation acknowledgement, split/merge/move, deposits/credit policy, refund/waste distinction | Seat-based bills, shared-item split, tips/service charges and allocation, reservations/no-show deposits, delivery dispatch and commissions, allergen workflow |
| Retail | Exact/repeated scans, paginated catalog, price/tax integrity, cash/account reconciliation, stock issue, full/partial return and exchange | SKU variation matrix, pack/unit conversions, weighted goods/scales, label printing, promotions/price lists, serial/lot/expiry capture, stocktake and replenishment |

I did not establish an end-to-end tip/service-charge workflow, seat-based service, structured allergen warnings, retail exchange flow or integrated payment-provider authorization in the reviewed selling paths. Generic metadata, order-type labels or related ERP models should not be presented as completed selling functionality.

For allergens, provide structured information and an explicit kitchen alert/acknowledgement; free-text notes alone are a weak operational control. For delivery, collect address/contact, promised time, dispatch status, fee and payment responsibility; selecting “Delivery” is only the first step.

## 8. Stabilization plan and release acceptance

**Stage 1 — protect money and preserve work.** Fix F01–F09, F17 and F18 first. Centralize pricing, tender routing and authorization; repair store-credit redemption and refunds; remove unsafe compensation; preserve exact retry payloads and unsaved carts. Do not add more selling features while these foundations diverge.

**Stage 2 — make preparation and inventory trustworthy.** Fix line identity, durable kitchen send/cancel, live-ticket visibility, combo quantities and extra stock transactions. Implement portion/option stock semantics and refund disposition appropriate for the initial menu. Close the exception-monitor loop with visible owners and resolution records.

**Stage 3 — finish the launch profile.** Polish the selling interface around one café/restaurant/retail profile, configure real taxes/accounts/recipes/hardware, and complete the missing features that profile requires. Leave unrelated ERP modules outside the initial operational scope.

**Stage 4 — prove deployment and recovery.** Build a clean release artifact, migrate a staging copy, exercise the least-privilege database role, test another terminal over TLS, rehearse backup restore and rollback, and resolve reachable dependency advisories. CI should gate the exact artifact/tag; the tag release workflow currently builds web without showing a dependency on the full test workflow.

| Acceptance scenario | Required result |
|---|---|
| Same sale via counter, table, open order and split | Identical totals and intended cash/AR/tax/stock effects |
| Inclusive/exclusive/mixed tax and fixed/percent discounts | UI, invoice, receipt, journal and reports agree to currency precision |
| Cash, card, bank, mobile money, mixed and credit | Correct collection account; cash drawer changes only by actual cash |
| Spend prepaid credit twice simultaneously | No overspend; balance, ledger and receipt agree |
| Change base price/discount or spoof manager ID via API | Unauthorized action rejected and audited |
| Two tills settle one order | One valid settlement; the rejected attempt cannot refund the successful one |
| Lost response and failed idempotency-completion write | Original result recovered; no duplicate business operation |
| Partial → partial → remaining refund; duplicate line request | No over-refund, correct refund tender and residual |
| Prepared-food refund versus sealed retail return | Correct money reversal and explicit waste/restock disposition |
| Save fails just before Pay/New order | Cart remains recoverable; stale server order is not silently charged |
| Same item with different milk/sides; append another round | Correct independent line state; exactly one dispatch per intended quantity |
| Two kitchen sends, printer off, one station fails | No duplicate prep; pending work visible and recoverable |
| More than 200 newer tickets | Old active tickets remain visible until handled |
| Small/large, extra shot, milk substitution, combo with 2× component | Correct price, recipe/UOM, stock quantity, tax and partial-return allocation |
| Cash close while sale/payment is in flight | Close waits/rejects safely; final Z report reconciles |
| Offline response-loss, restart, shift change, user/org change | Immutable correctly attributed operations; no silent loss or reassignment |
| Repeated identical scans and large catalog | Each physical scan counted once; products accessible beyond page 1 |
| Clean container install and upgrade from current data | Starts with intended config; migrations succeed; no destructive seed |
| Restore from backup and replay pending work | Agreed recovery time and data-loss bounds demonstrated |
| Real peak service rehearsal | Cashier, server, kitchen and manager complete a full simulated day and reconcile |

The existing E2E file is API-only and references old paths such as `/pos/refund`; its default base also omits the application's `/api/v1` prefix. It refers to a browser smoke file that was not found in the repository. Repair this suite and add a small set of meaningful browser workflows for the selling UI. See [pos-sell-loop.spec.ts:1](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/tests/e2e/pos-sell-loop.spec.ts:1) and [CI workflow](C:/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/.github/workflows/ci.yml).

**Release decision after those gates:** begin with one supervised site/register and a narrow feature profile. Expand only after daily cash, payment, stock and accounting reconciliations remain clean and recovery has been demonstrated. The present working tree does not yet meet that bar.

