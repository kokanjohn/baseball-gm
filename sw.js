// ── Baseball GM Service Worker ───────────────────────────────────────────────
// Bump CACHE_VERSION with every update to force cache refresh on all devices.
const CACHE_VERSION = 'bgm-v6';
const ASSETS = [
  '/baseball-gm/Baseball_GM.html',
  '/baseball-gm/manifest.json',
];

// Install — cache core assets and skip waiting immediately
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS))
  );
});

// Activate — delete any old caches, claim all clients immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — cache-first for our assets, network-only for everything else
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle same-origin requests for our own assets
  if(url.origin !== self.location.origin) return;
  if(!ASSETS.some(a => url.pathname === a)) return;

  e.respondWith(
    caches.open(CACHE_VERSION).then(cache =>
      cache.match(e.request).then(cached => {
        // Return cached version immediately, fetch update in background
        const fetchPromise = fetch(e.request).then(response => {
          if(response && response.status === 200){
            cache.put(e.request, response.clone());
          }
          return response;
        }).catch(() => null);
        return cached || fetchPromise;
      })
    )
  );
});
