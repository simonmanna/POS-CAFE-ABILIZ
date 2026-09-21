# Terminal checklist

One sheet per terminal. The database work is worthless if a till still holds an
unsent sale, or serves yesterday's JavaScript.

Terminal: ______________  Operator: ______________  Date: ____________

## Why this matters

The old and new web apps share one IndexedDB database, `pos-offline-queue`
(version 2 in the old build, 3 in the new one). The new build **replays whatever
it finds there**. A sale left queued on a till therefore reappears after the
cutover, against a database that already has it - or against one that never
will. Neither is acceptable, so the queue must be empty *before* the final
backup, and the storage cleared *after* the switch.

The new build also installs a service worker (`apps/web/src/sw.ts`); the old one
has none. A rollback therefore has to clear site data too, or the terminal keeps
serving the new app shell against the old API.

## BEFORE the final backup (on every terminal, while the OLD system is running)

- [ ] Offline-queue badge shows **0** pending sales
- [ ] Cart is empty (the old build persists it as `pos-cart`)
- [ ] No parked/held orders belonging to this terminal
- [ ] The cashier on this till has closed their shift, Z report printed and kept
- [ ] KDS screen shows no ticket still in `new`
- [ ] Terminal is then left **logged out and idle** until the switch is done

Signature: ______________

## AFTER the switch (on every terminal, once the new API is healthy)

- [ ] Clear site data for the POS origin
      (Chrome: Settings > Privacy > Site settings > View permissions and data
       stored across sites > the POS host > Delete data. Or DevTools >
       Application > Storage > Clear site data.)
      This removes `pos-offline-queue`, `pos-cart`, cached auth and the old
      cache entries in one action.
- [ ] Hard reload (Ctrl+Shift+R), confirm the new build loads
- [ ] Log in; confirm the role is right
- [ ] Bind this terminal to its cash register (the new build stores
      `pos-terminal-id` and `pos-register:<org>` locally, so this is per device)
- [ ] Print a test receipt - paper, cut, and the drawer kick
- [ ] Print a test KOT to the kitchen printer
- [ ] Offline-queue badge shows **0**

Signature: ______________

## If a rollback happens

- [ ] Clear site data again (removes the new service worker and cache)
- [ ] Hard reload, confirm the OLD build loads
- [ ] Log in, print one test receipt
- [ ] Report any sale that was rung up on the new system: it exists only there
      and must be re-entered by hand (see `rollback.ps1 -ReportV2Writes`)

Signature: ______________
