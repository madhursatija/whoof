// Service worker for MS Vitality PWA.
// Strategy: cache-first for static assets, network-first for HTML.
// IndexedDB data is always local, so no special SW handling is needed for it.

const CACHE_NAME = 'ms-vitality-v1';

// Assets to pre-cache on install. Paths are relative to SW scope (/)
const PRECACHE = [
  '/',
  '/styles.css',
  '/vendor/chart.umd.js',
  '/vendor/fake-indexeddb.mjs',
];

// ---- Install: pre-cache core assets ----------------------------------------

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE).catch(() => {
      // Non-fatal: some assets may 404 in dev; don't break install.
    })),
  );
});

// ---- Activate: prune old caches --------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// ---- Fetch: cache-first for JS/CSS/fonts, network-first for HTML -----------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin GETs.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip BLE / WebSocket / API traffic.
  if (url.pathname.startsWith('/api/')) return;

  // HTML: network-first so the user always gets fresh markup.
  if (request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Static assets (JS, CSS, fonts, images): cache-first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (!res || res.status !== 200) return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        return res;
      });
    }),
  );
});
