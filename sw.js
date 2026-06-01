/**
 * sw.js — Service Worker for The Front Office PWA
 *
 * Strategy: cache-first for all app shell assets, network fallback.
 * On install: pre-cache all known static assets.
 * On activate: delete stale caches from previous versions.
 * On fetch: serve from cache, fall back to network, cache new responses.
 *
 * Cache versioning: bump CACHE_VERSION when deploying new builds.
 * This triggers the activate handler to clear the old cache automatically.
 *
 * Rules:
 *   - Never cache cross-origin requests (IndexedDB is handled by the app, not here)
 *   - Never cache the service worker itself
 *   - POST requests and non-GET requests bypass the cache entirely
 *   - If both cache and network fail, serve the offline fallback
 */

const CACHE_VERSION  = 'tfo-v2-r1';
const CACHE_NAME     = `the-front-office-${CACHE_VERSION}`;
const OFFLINE_URL    = '/index.html';

// ─────────────────────────────────────────────────────────────
// ASSETS TO PRE-CACHE ON INSTALL
// All paths relative to the service worker scope (repo root).
// ─────────────────────────────────────────────────────────────

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',

  // Data layer
  '/data/constants.js',
  '/data/player-names.js',
  '/data/cards-pool.js',

  // Store layer
  '/store/schema.js',
  '/store/DB.js',
  '/store/StateManager.js',

  // Engine layer
  '/engine/PlayerFactory.js',
  '/engine/LeagueFactory.js',
  '/engine/RosterEngine.js',
  '/engine/SeasonEngine.js',
  '/engine/LeagueEngine.js',
  '/engine/GameEngine.js',
  '/engine/SimEngine.js',
  '/engine/WeatherEngine.js',
  '/engine/InjuryEngine.js',
  '/engine/TradeEngine.js',
  '/engine/CardEngine.js',
  '/engine/IMPEngine.js',
  '/engine/PrestigeEngine.js',
  '/engine/OffseasonEngine.js',
  '/engine/NarrativeEngine.js',

  // UI layer
  '/ui/formatters.js',
  '/ui/EventBus.js',
  '/ui/App.js',

  // Screens
  '/ui/screens/SetupScreen.js',
  '/ui/screens/DashboardScreen.js',
  '/ui/screens/InboxScreen.js',
  '/ui/screens/TeamScreen.js',
  '/ui/screens/LeagueScreen.js',
  '/ui/screens/ScheduleScreen.js',
  '/ui/screens/GameScreen.js',
  '/ui/screens/PlayoffScreen.js',
  '/ui/screens/OffseasonScreen.js',
  '/ui/screens/HistoryScreen.js',

  // Components
  '/ui/components/RadarWidget.js',
  '/ui/components/LiveDiamond.js',
  '/ui/components/Linescore.js',
  '/ui/components/PlayerCard.js',
  '/ui/components/CardModal.js',
];

// ─────────────────────────────────────────────────────────────
// INSTALL — pre-cache all assets
// ─────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[SW] Pre-cache failed:', err);
      })
  );
});

// ─────────────────────────────────────────────────────────────
// ACTIVATE — clean up stale caches
// ─────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name.startsWith('the-front-office-') && name !== CACHE_NAME)
            .map(name => {
              console.log('[SW] Deleting stale cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// ─────────────────────────────────────────────────────────────
// FETCH — cache-first, network fallback
// ─────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Only handle same-origin requests
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the service worker itself
  if (url.pathname === '/sw.js') return;

  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) return cached;

        // Not in cache — fetch from network and cache the response
        return fetch(request)
          .then(response => {
            // Only cache valid responses
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone before consuming — response body can only be read once
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, responseToCache));

            return response;
          })
          .catch(() => {
            // Network failed — serve offline fallback for navigation requests
            if (request.destination === 'document') {
              return caches.match(OFFLINE_URL);
            }
            // For non-document requests (JS modules etc.) — nothing to serve
            return new Response('', { status: 503, statusText: 'Service Unavailable' });
          });
      })
  );
});

// ─────────────────────────────────────────────────────────────
// MESSAGE — force update from app
// ─────────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
