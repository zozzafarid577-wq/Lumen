// Lumen's service worker. It does one job: show the phone pop-ups the
// server sends (api/_lib/push.js) and open the right page when one is
// tapped. It caches nothing — every page still comes from the network.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Lumen', {
    body: data.body || '',
    icon: '/assets/app/icon-192.png',
    badge: '/assets/app/icon-192.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if (c.url === url && 'focus' in c) return c.focus();
    }
    for (const c of open) {
      if ('navigate' in c) { await c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
