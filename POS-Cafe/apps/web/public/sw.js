/* Generic ERP service worker.
 *
 * Used for Web Push delivery (VAPID). The service receives a `push` event
 * with a JSON payload, displays a Notification, and optionally opens a URL
 * on click.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Notification', body: '', href: null, tag: null };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_e) {
    // ignore parse errors
  }
  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { href: payload.href },
    tag: payload.tag || undefined,
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = event.notification?.data?.href;
  if (href) {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            client.navigate?.(href);
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(href);
      }),
    );
  }
});
