// Mitgliederportal: network first; when offline, navigations get the last loaded app shell.
// No API responses are cached and nothing is written offline.
const SHELL = 'portal-shell-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add('/portal')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/portal', copy)); return res; }).catch(() => caches.match('/portal')));
  } else if (url.origin === location.origin && url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.open(SHELL).then(async (c) => (await c.match(req)) ?? fetch(req).then((res) => { c.put(req, res.clone()); return res; })));
  }
});
