# Dependency advisory triage (F21)

Source scan: [`2026-09-03-dependencies.json`](2026-09-03-dependencies.json) — 15 high, 28 moderate, 4 low, 0 critical. A package count is not a count of exploitable endpoints; this records reachability and remediation.

## Remediated via `pnpm.overrides` (in `package.json`, lockfile regenerated)

| Package | Advisory | Was | Pinned | Note |
|---|---|---|---|---|
| axios | HTTP adapter can use an inherited proxy/URL | 1.17 | ≥1.18 (→1.20) | direct dep |
| brace-expansion | ReDoS / unbounded expansion | 2.1.1 | ≥2.1.4 (→5.x) | transitive (glob/minimatch) |
| js-yaml | merge-key chains / quadratic CPU | 4.1 | ≥4.3.1 | transitive |
| nanoid | non-secure/custom generators loop | 3.3.12 | ≥3.3.18 | transitive |
| postcss | path traversal in source map | 8.5.15 | ≥8.5.18 | build-time |
| multer | DoS | 2.1.1 | ≥2.2.0 (→2.3) | upload handling |
| dompurify | (via jspdf) | 3.4.11 | ≥3.4.12 (→3.4.14) | PDF/receipt render |
| qs | prototype pollution | 6.15.2 | ≥6.16 | transitive (body parsing) |
| uuid | | 11.0.3 | ≥11.1.1 | transitive |
| body-parser | | 2.2.2 | ≥2.3 | transitive (express 5 path) |

The override forces the resolution globally by name; a few subtrees still resolve an older compatible line (e.g. `body-parser@1.19.x` under an express-4 dependency, `qs@6.15.1`, `multer@1.4.x`) — these are lower-severity or unreachable at runtime and are left for a dependency-tree cleanup.

## Not remediated — no fixed release

| Package | Advisory | Reachability | Decision |
|---|---|---|---|
| lodash | code injection (advisory lists `patched >=4.18.0`, which does not exist) | dev/build tooling | monitor; no upstream fix; not in a request path |
| html-minifier | ReDoS (`patched <0.0.0` = none) | build-time only (not shipped to runtime) | accept; not reachable in production image |

## Not remediated — breaking major, deferred

| Package | Advisory | Fixed in | Decision |
|---|---|---|---|
| nodemailer | addressparser / raw-option bypass | ≥9.0.1 (major) | schedule a mail-layer upgrade + test; email is not on the sale path |
| deepmerge-ts | stack exhaustion | ≥8.0.0 (major) | evaluate with the dependency that pulls it |
| react-router / react-router-dom | | ≥7.18 (major) | plan a router major upgrade separately |
| mjml | | ≥5.0.0-alpha | alpha; wait for stable |

## Required follow-up

Local `node_modules` could not be re-materialised on this OneDrive checkout (`pnpm install` → `EINVAL rename node_modules`). On a clean, non-OneDrive checkout:

1. `pnpm install --frozen-lockfile`
2. `pnpm audit --prod` (and against the built Docker image)
3. Record the residual counts here and re-triage anything new.

The raw scan is retained as evidence. Do not treat this file as a clean bill of health until step 2 is run against the deployed image.
