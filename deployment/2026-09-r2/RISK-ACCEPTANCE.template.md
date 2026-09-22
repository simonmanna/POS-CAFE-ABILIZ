# RISK ACCEPTANCE — must-go cutover (release 2026-09-r2)

> Copy this file to `C:\POS-BACKUPS\RISK-ACCEPTANCE.md`, fill every blank,
> sign it, and point `authorization.json` evidence for each waived gate at
> `<this file>#<gate>`. Be honest: every skipped gate says **WAIVED** here.
> Never write evidence that does not exist. `cutover.ps1 -Phase preflight`
> refuses to run until every gate M0–G10 has status PASS with a signer, a date
> and an evidence path — a waived gate satisfies that check by pointing at this
> signed document, not by pretending the work happened.

- Date: ____________  Release: 2026-09-r2  Kit hash: ____________ (from the release manifest)
- New install: `C:\microsoft\POS-CAFE-2`  ·  Old install (rollback): `C:\microsoft\POS-CAFE`
- Databases: legacy `POS-CAFE` (frozen read-only at cutover) → new `cafe_pos_v2` (promoted workspace)

## People

| Role | Name | Phone |
|---|---|---|
| Owner (decision authority) | | |
| Engineer (operator) | | |
| **Rollback authority** (the only person who may start a post-write rollback) | | |
| Approver (the second person on every confirmation) | | |
| Shift lead (terminal sheets) | | |

## Window

- Cutover date: ____________  Window start: ______  **go/no-go deadline**: ______
- Rule: if `-Phase accept` has not PASSED by the deadline → `cutover.ps1 -Phase abort`; the café trades on the old system; nothing is lost.

## Waived gates — honestly marked

| Gate | Status | Risk accepted | Paid off by | Evidence after pay-off |
|---|---|---|---|---|
| G1 reference backup | **WAIVED** — replaced by today's fresh backup | older restore point | — | `backup-manifest.json` |
| G2 dev-machine rehearsal | **WAIVED** — replaced by the §3 production rehearsal | kit only proven in production mode on this machine | — | §3 run evidence |
| G3 / G4 / G6 / G7 sign-offs | **WAIVED** — evidence auto-produced by the §3 run | mapping + fingerprints reviewed by the engineer only | Day 1 | `fingerprint.json`, `MigrationReport.md` |
| G5 full manual UAT | **WAIVED** → 15-minute smoke test in §3 | unseen defects surface in trading | Day 1 | signed `UAT-CHECKLIST.md` |
| G8 recovery drill | **WAIVED** — covered by the backup test restore + the abort path | slower post-write rollback | Week 1 | rollback drill evidence |
| G9 full hardware rehearsal | **WAIVED** → 1 till / 1 printer / 1 drawer in §3 | multi-till issues appear Day 1 | Day 1 | terminal sheets |
| D6 stock count | **WAIVED** — option B (migrate as-is) | drift / negative stock visible until counted | Week 1 | count + signed adjustments |

## Gates NOT waived

| Gate | How it is satisfied |
|---|---|
| M0 release freeze | release manifest + install hashes (re-run after the §1.1 kit edit — the kitHash changed) |
| G0 short discovery | `cafe-config.json` filled from the walk-through; old `update-pos.ps1` task disabled |
| §3 dress rehearsal + smoke test | **hard stop — GO only after PASS** |
| G11 / G12 / G13 | run live on cutover day by `cutover.ps1` |

## authorization.json entries for waived gates (example)

```json
"G5": { "status": "PASS", "signedBy": "<owner full name>", "date": "<today>",
        "evidence": "C:\\POS-BACKUPS\\RISK-ACCEPTANCE.md#G5" }
```

Still required by preflight (not waivable): one-line `decidedBy` on every
decision D1–D21; `approvedMapping` copied from the §3 run output; the
maintenance window above; signatures for owner / engineer / rollback authority;
at least one `authorizedApprovers`.

## Decisions being taken now

- D19 drawer ledger: counted float ________ ; ledger amount ________ ; adjustment ________ (booked in the app, never SQL) — signed: ____________
- D11 database timezone: UTC · D14 feature flags: all `ENABLE_*=false` · D21 payment methods: MTN + Airtel
- D15 RLS posture: keep the rehearsed role — the old app role is `postgres` (a superuser), so the new `.env` sets `RLS_ALLOW_SUPERUSER=true`; hardening is a separate, later change.

## Signatures

Owner: ______________________  Date: ________

Engineer: ___________________  Date: ________