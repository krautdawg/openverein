// Mitgliederportal: always the network. Only when it is unreachable, navigations get a small offline page.
// Nothing else is cached: no API answers, no app files, so nothing goes stale between deploys.
const CACHE = 'portal-offline-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/portal-offline.html')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') e.respondWith(fetch(e.request).catch(() => caches.match('/portal-offline.html')));
});
