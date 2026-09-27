// App shell + models cached for offline/fast reopen. The index is network-first so rebuilds show up.
const VERSION = 'po-v3';
const SHELL = ['./', 'index.html', 'style.css', 'js/app.js', 'js/crypto.js', 'js/face.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  const cacheFirst = (sameOrigin && url.pathname.includes('/models/')) || url.hostname === 'cdn.jsdelivr.net';
  const networkFirst = sameOrigin && !cacheFirst;
  if (!cacheFirst && !networkFirst) return; // Drive thumbnails etc. go straight to network
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (cacheFirst) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
