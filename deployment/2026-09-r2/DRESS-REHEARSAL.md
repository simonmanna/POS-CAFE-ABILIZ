# G9: hardware dress rehearsal at the café

G5 proves the software. G9 proves **this café's machine, network, terminals,
printers and people**. Both gates are required, and one cannot stand in for the
other.

The dress rehearsal runs the **real Job 2 wrapper in `-Rehearse` mode** on the
café server, against a disposable copy of a fresh café backup. The live
`POS-CAFE` database is never touched. Choose a quiet hour or run after closing.
The café can keep trading on the old system for the software part. The
terminal part needs 2 to 3 tills taken out of service for about an hour.

Date: __________  Server: __________  Run ID: `cutover-<date>-r<n>` (rehearse)

## 1. Setup on the café server

- [ ] New build installed in `C:\microsoft\POS-CAFE-v2`; `.\m0-release-freeze.ps1 -InstallRoot C:\microsoft\POS-CAFE-v2` hashes equal the M0 manifest
- [ ] `C:\microsoft\POS-CAFE` (old install) untouched; `git -C C:\microsoft\POS-CAFE rev-parse HEAD` recorded: ________
- [ ] Fresh backup of `POS-CAFE` taken with the café's normal procedure → restored into `cafe_rollback_test_r1` (the legacy stand-in); read-only flag set
- [ ] `ref_baseline_20260727` built on this server (`build-ref-baseline.ps1`)
- [ ] `cafe-config.json` filled from G0; a copy `cafe-config.rehearse.json` with `legacyDb = cafe_rollback_test_r1`, `targetDb = cafe_pos_v2_rehearsal`
- [ ] A copy `authorization.rehearse.json` (the gates may still be OPEN: preflight will list them. That is expected, and it proves the check works)

## 2. Software timings on this machine

Run the whole wrapper in rehearse mode and record the times:

| Phase | Command | Time | Result |
|---|---|---|---|
| preflight | `.\cutover.ps1 -RunId ... -Config cafe-config.rehearse.json -Authorization authorization.rehearse.json -Phase preflight -Rehearse` | | |
| freeze | `... -Phase freeze -Rehearse` | | |
| backup | `... -Phase backup -Rehearse` | | |
| migrate | `... -Phase migrate -Rehearse` | | |
| switch | `... -Phase switch -Rehearse` | | |
| accept | `... -Phase accept -Rehearse` (controlled sale on a test till) | | |
| abort drill | new run: preflight → freeze → `-Phase abort -Rehearse` | | |

- [ ] Total from freeze to switch = ______ min (sets the maintenance window: at least 3× this, plus terminal work)
- [ ] The final-backup restore finished on this disk in ______ s
- [ ] The offsite copy reached the real offsite medium and verified

## 3. Role and service account (the posture from G0)

- [ ] The API starts under the **real NSSM service account** (`ObjectName`: ________) against `cafe_pos_v2_rehearsal` on a spare port
- [ ] `/health`, `/health/ready`, `/health/startup` = 200 under that account
- [ ] `RLS_ALLOW_SUPERUSER` matches decision `rlsPosture` (the API refuses to boot as a superuser without it)
- [ ] If the app role is not a superuser: `cutover.ps1 -Phase migrate` app-role access check passed
- [ ] The receipt printer is reachable **from the service account** (NSSM services often run as LocalSystem, which cannot see a user-installed printer)

## 4. Terminals (every one in `cafe-config.json` → `terminals`)

Point one till at a test origin/port serving the new build, then:

| Terminal | Site data cleared | New build loads | Login + PIN | Register bound | Receipt paper + cut | Drawer kicks | KOT to kitchen | KOT to bar | Offline → online replay once | Initials |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |

## 5. Failure cases

| # | Case | Expected | Pass |
|---|---|---|---|
| F1 | Pull a till's network cable mid-sale, reconnect | queued sale replays once, no duplicate number | |
| F2 | Stop the API service mid-shift, start it | terminals recover; shift intact | |
| F3 | Receipt printer off / out of paper | sale completes; clear reprint path | |
| F4 | Power-cycle the server (if the owner allows it) | services auto-start; health 200 | |
| F5 | Rollback drill: `-Phase abort -Rehearse` after `switch` | old services back (printed commands match `services.txt`); legacy writable | |
| F6 | Clear site data after the rollback drill | the old build loads again on the till; no new service worker left | |

## 6. People

- [ ] Shift lead walked the BEFORE and AFTER sheets of [terminal-checklist.md](terminal-checklist.md) on a real till
- [ ] Cashiers briefed: `silent → warn` stock warnings, new login/PIN screens, new receipt layout
- [ ] Owner has seen the controlled-sale procedure (keep it, or refund/void with a reason; never delete)
- [ ] Every person named in `authorization.json` is available in the window, and their phone numbers are listed

## Sign-off

G9 result: PASS / FAIL    Findings and their fixes: ______________________________

Owner: ______________________  Date: ________

Engineer: ___________________  Date: ________
