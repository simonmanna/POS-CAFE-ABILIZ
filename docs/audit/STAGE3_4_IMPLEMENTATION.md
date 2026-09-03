# Stage 3 (retail + UI) and Stage 4 (deploy / deps / fiscal)

Implemented 4 September 2026, on top of Stages 1 / 1.5 / 2. Scope: F19 and the section-4 UI items (Stage 3), and F20–F22 plus the e2e/CI repair (Stage 4).

**Release position unchanged — this is staging-ready, not production-certified.** The remaining gates are named at the end; several require a live deployment, real hardware, and a DB integration run this workstation cannot perform (the local dev DB is behind `schema.prisma`, and `node_modules` cannot be re-materialised here — see Verification).

## Stage 3 — F19 retail + UI

- **F19 catalog (server-side category)** — `useProductsForPos` now sends `categoryId` to the API and `RetailTerminal` passes the active category, so the 200-row window is per-category instead of global-then-client-filtered. A category with more than one page of products is no longer silently truncated. (`apps/web/src/pages/pos/api.ts`, `RetailTerminal.tsx`.)
- **F19 single scan pipeline** — the retail terminal had both an immediate `useEffect` lookup on `search` and a debounced `onScan`, so one scan raced two async lookups and could double-add. The immediate path is removed; `onScan` is the only pipeline, guarded by a `scanSeq` token that drops a stale lookup when a newer scan starts. (`RetailTerminal.tsx`.)
- **F19 duplicate scans** — the debouncer's 800 ms "suppress the same string" window wrongly dropped a genuine second scan of the same barcode; it existed only to hide the now-removed second path. Removed: the caller clears the field after each completed scan, so two physical scans are two events. (`scanner-debounce.ts`.)
- **Accompaniment max-select no longer silently evicts** — at the group limit, a further tap is blocked with a toast instead of quietly dropping the first pick. (`AccompanimentPicker.tsx`.)
- **Server enforces `isRequired`** — the validator now requires `max(minSelect, isRequired ? 1 : 0)`, so a group with `isRequired: true, minSelect: 0` can no longer be settled empty. (`pos-accompaniment.service.ts`.)
- **Accompaniment report revenue** — rebuilt to aggregate by option id and join `priceImpact` + group name, so revenue and group are real instead of hardcoded `0`/blank; legacy rows with names but no ids are still counted (revenue 0). (`pos-accompaniment.service.ts`.)
- **One money formatter** — `OrderPanel` used a hardcoded `UGX`; it now reads the organization currency like every sibling, so one screen can't show two currencies. (`OrderPanel.tsx`.)
- **Login claims** — the unsupported "99.9% uptime / <200 ms / 24-7 offline" stats are replaced with factual feature labels. (`login.tsx`.)
- **Server error surfacing** — the axios interceptor now extracts the API's `message` (string or array) as `err.userMessage` and shows it for 4xx/5xx instead of generic "Server error". (`apps/web/src/lib/api.ts`.)

**Deferred UI redesigns (documented, not built):** a persistent order state bar, a single combined item sheet, and an exact-cash/denomination button are larger UX changes left for a focused pass.

## Stage 4 — F20 deployment / isolation

- **API image builds correctly** — the runtime stage no longer runs `pnpm install --prod … && pnpm --filter @erp/shared build` (which could not work: TypeScript is a devDependency and `--ignore-scripts` skips Prisma generation). It now copies the build stage's `node_modules`, compiled `packages/shared/dist`, `apps/api/dist` and generated Prisma client. (`infra/docker/Dockerfile.api`.)
- **Same-origin web** — the web image no longer bakes `http://localhost:3000` (which only resolved on the API host). `VITE_API_URL` defaults empty → the client uses the relative `/api/v1` base, and nginx proxies `/api/` to the API container (with SSE buffering off for the KDS stream). (`infra/docker/Dockerfile.web`, `nginx.conf`, `docker-compose.yml`.)
- **Network exposure** — Postgres and Redis are bound to `127.0.0.1`, the API is `expose`d on the internal network only (no public port), and Adminer moved behind a `debug` compose profile. Secrets (`POSTGRES_PASSWORD`, JWT secrets) are required via `:?`. (`docker-compose.yml`.)
- **Batch-transaction tenant GUC** — `$transaction([...])` now injects `SET LOCAL app.org_id` as the batch's first statement (it runs on one connection in one tx), closing the documented gap where batch writes ran without RLS context. (`prisma.service.ts`.)

**Deliberately NOT changed (tracked hardening gate):** the API still connects as the Postgres superuser with `RLS_ALLOW_SUPERUSER=true`. Tenant isolation is enforced at the application layer by the Prisma tenancy extension (every query is scoped to the caller's `organizationId`); RLS is a defence-in-depth backstop that is bypassed by a superuser. Moving the API onto a non-superuser role requires the org-id GUC to be set on **every** standalone read, not only inside interactive transactions. The correct implementation is the canonical Prisma RLS extension pattern — wrap each non-raw operation as `base.$transaction([ set_config('app.org_id', <org>, true), query(args) ])`, with `AsyncLocalStorage` nesting detection so an operation already inside an interactive tenant transaction is not re-wrapped. This must ship with a DB-backed cross-tenant integration test and its own staging acceptance; flipping the role without it would either break every read (RLS default-deny) or, done carelessly, leak across tenants. It is intentionally not enabled by default here.

## Stage 4 — F21 dependencies

`package.json` gains `pnpm.overrides` pinning the high-severity advisories to patched lines, and `pnpm-lock.yaml` is regenerated: axios ≥1.18 (→1.20), brace-expansion ≥2.1.4 (→5.x), js-yaml ≥4.3.1, nanoid ≥3.3.18, postcss ≥8.5.18, multer ≥2.2.0 (→2.3), dompurify ≥3.4.12, qs ≥6.16, uuid ≥11.1.1, body-parser ≥2.3. Triage of every advisory (including the ones left, e.g. lodash/html-minifier with no fixed release, and majors like nodemailer/react-router deferred as breaking) is in [`DEPENDENCY_TRIAGE.md`](DEPENDENCY_TRIAGE.md). Re-run the scan after a clean `pnpm install` on a non-OneDrive checkout to confirm the counts drop.

## Stage 4 — F22 fiscalization

`fiscalizeInvoice` is honest about being a seam, not compliance. `Invoice` gains `fiscalStatus` / `fiscalCode` / `fiscalQr` / `fiscalizedAt` (migration `20260905000000_invoice_fiscalization`); when a provider is configured but no adapter is wired, the invoice is marked `fiscalStatus: 'pending'` on the row (queryable/reportable) rather than only in an audit log. Setting `FISCAL_PROVIDER` is still **not** an EFRIS/EFD implementation — see [`FISCALIZATION.md`](FISCALIZATION.md) for how to wire a real device and the compliance caveat.

## e2e / CI

- `tests/e2e/pos-sell-loop.spec.ts` now targets the `api/v1` prefix, uses the live `POST /pos/invoices/:id/refund` route with a manager approval + stock disposition, and drops the reference to the non-existent `web-smoke.spec.ts`.
- `release.yml` gains a `verify` job (arch + typecheck + shared/web build) that the release `build` job `needs`, so a tag can no longer cut a release from a commit that fails checks. `ci.yml` also runs its full DB-backed job on `v*` tags.

## Verification

- `pnpm typecheck` — green (shared, api, web).
- `pnpm lint:arch` — no violations (637 modules).
- API unit suite — **438 passed**; the only failures are the pre-existing env-drift suites `rls.spec.ts` and `audit.service.spec.ts` (`The column openingBalance does not exist in the current database`), unchanged by this work.
- `pnpm-lock.yaml` regenerated with the overrides (`pnpm install --lockfile-only` succeeded). Local `node_modules` could **not** be re-materialised here — `pnpm install` fails with a Windows/OneDrive `EINVAL rename … node_modules → node_modules/.ignored` quirk unrelated to these changes — so the running dev tree still resolves the pre-bump versions. CI/Docker install from the lockfile with `--frozen-lockfile` and will pick up the patched versions; re-run `pnpm audit` there to confirm.
- `prisma generate` reports the usual Windows `EPERM` on the query-engine dll; the generated types are written (`fiscalStatus` present), so typecheck is valid. Stop the dev server and re-run `pnpm db:generate` before booting the API.
- Not run here (need a live stack): the repaired e2e suite, a clean-container `docker compose build`/`up` from a second terminal, backup/restore, and the F20 non-superuser-role acceptance.

## Remaining gates before a production pilot

1. Implement and test the per-read tenant GUC and move the API onto the non-superuser DB role (F20 hardening above), with a cross-tenant integration test.
2. Rehearse the clean-container build + start from a second physical terminal over TLS; confirm the `/api` proxy, SSE (KDS), uploads and health checks.
3. Re-materialise `node_modules` on a non-OneDrive checkout, run `pnpm install --frozen-lockfile`, re-run `pnpm audit`, and record residual advisories against the triage doc.
4. Decide fiscalization per business: wire a real EFRIS/EFD adapter or document a compliant external invoicing workflow; do not present `FISCAL_PROVIDER` as compliance.
5. Run the repaired e2e suite and an authenticated cashier/manager/kitchen acceptance day with real printer, drawer and scanner.
