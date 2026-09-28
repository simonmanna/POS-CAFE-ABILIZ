/**
 * Keep the till on the latest deployed build — automatically.
 *
 * The browser only checks the service worker for updates on navigation. A
 * register tab that stays open for days (which is exactly how a till is used)
 * would otherwise keep running an old bundle indefinitely, even after a fix
 * ships: a stuck-payment incident (Sept 27) happened precisely this way — the
 * sync fix was deployed but never reached the terminal.
 *
 * - Poll `registration.update()` every 30 minutes and whenever the window
 *   regains focus / becomes visible (cheap 304 in the common case).
 * - When a NEW worker takes control while a previous one existed, reload the
 *   page once so the cashier runs the code that matches the server. The
 *   write-ahead offline queue + cart persistence make an interrupted payment
 *   recoverable, which is what PendingSaleRecovery exists for.
 */
export function installServiceWorkerUpdater() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  let refreshing = false;
  let hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A first-ever install also claims clients; only reload for real updates.
    if (hadController && !refreshing) {
      refreshing = true;
      window.location.reload();
    }
    hadController = true;
  });

  void navigator.serviceWorker.ready.then((registration) => {
    const check = () => void registration.update().catch(() => { /* offline till: next tick retries */ });
    window.setInterval(check, 30 * 60 * 1000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  });
}
