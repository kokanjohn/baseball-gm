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

const CACHE_VERSION  = 'tfo-v2-r76';
const CACHE_NAME     = `the-front-office-${CACHE_VERSION}`;
const OFFLINE_URL    = '/baseball-gm/index.html';

// ─────────────────────────────────────────────────────────────
// ASSETS TO PRE-CACHE ON INSTALL
// All paths relative to the service worker scope (repo root).
// ─────────────────────────────────────────────────────────────

const PRECACHE_ASSETS = [
  '/baseball-gm/',
  '/baseball-gm/index.html',
  '/baseball-gm/manifest.json',
  '/baseball-gm/icon-192.png',
  '/baseball-gm/icon-512.png',

  // Data layer
  '/baseball-gm/data/constants.js',
  '/baseball-gm/data/player-names.js',
  '/baseball-gm/data/cards-pool.js',
  '/baseball-gm/data/cards-moments.js',
  '/baseball-gm/data/card-tokens.js',

  // Store layer
  '/baseball-gm/store/schema.js',
  '/baseball-gm/store/DB.js',
  '/baseball-gm/store/StateManager.js',

  // Engine layer
  '/baseball-gm/engine/PlayerFactory.js',
  '/baseball-gm/engine/LeagueFactory.js',
  '/baseball-gm/engine/RosterEngine.js',
  '/baseball-gm/engine/SeasonEngine.js',
  '/baseball-gm/engine/LeagueEngine.js',
  '/baseball-gm/engine/GameEngine.js',
  '/baseball-gm/engine/SimEngine.js',
  '/baseball-gm/engine/WeatherEngine.js',
  '/baseball-gm/engine/InjuryEngine.js',
  '/baseball-gm/engine/TradeEngine.js',
  '/baseball-gm/engine/TransactionEngine.js',
  '/baseball-gm/engine/PlayoffEngine.js',
  '/baseball-gm/engine/CardEngine.js',
  '/baseball-gm/engine/CardActions.js',
  '/baseball-gm/engine/MarketEngine.js',
  '/baseball-gm/engine/CardTokens.js',
  '/baseball-gm/engine/CardScheduler.js',
  '/baseball-gm/engine/IMPEngine.js',
  '/baseball-gm/engine/PrestigeEngine.js',
  '/baseball-gm/engine/OffseasonEngine.js',
  '/baseball-gm/engine/DevelopmentEngine.js',
  '/baseball-gm/engine/AllStarEngine.js',
  '/baseball-gm/engine/PitchingEngine.js',
  '/baseball-gm/engine/FinanceEngine.js',
  '/baseball-gm/engine/NarrativeEngine.js',

  // UI layer
  '/baseball-gm/ui/formatters.js',
  '/baseball-gm/ui/EventBus.js',
  '/baseball-gm/ui/App.js',
  '/baseball-gm/ui/PushClient.js',

  // Screens
  '/baseball-gm/ui/screens/SetupScreen.js',
  '/baseball-gm/ui/screens/TeamSelectScreen.js',
  '/baseball-gm/ui/screens/DashboardScreen.js',
  '/baseball-gm/ui/screens/InboxScreen.js',
  '/baseball-gm/ui/screens/TeamScreen.js',
  '/baseball-gm/ui/screens/LeagueScreen.js',
  '/baseball-gm/ui/screens/ScheduleScreen.js',
  '/baseball-gm/ui/screens/PlayoffScreen.js',
  '/baseball-gm/ui/components/OffseasonCard.js',
  '/baseball-gm/ui/components/AllStarCard.js',
  '/baseball-gm/ui/screens/HistoryScreen.js',
  '/baseball-gm/ui/screens/DebugScreen.js',

  // Components
  '/baseball-gm/ui/components/RadarWidget.js',
  '/baseball-gm/ui/components/PlayerCard.js',
  '/baseball-gm/ui/components/CardModal.js',
  '/baseball-gm/ui/components/BoxScore.js',
  '/baseball-gm/ui/components/LiveGame.js',
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
  // Lets the page display / compare the version the SW is actually serving.
  if (event.data?.type === 'GET_VERSION') {
    event.ports?.[0]?.postMessage({ version: CACHE_VERSION });
  }
});

// ─────────────────────────────────────────────────────────────
// PUSH — show inbox notifications from the push worker (§61)
// Always shown (also while the app is open), so a new message is noticed on
// any screen. tag = card instanceId, so a repeat replaces rather than stacks.
// ─────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : '' }; }

  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'The Front Office', {
      body:  data.body || 'New message in your inbox',
      tag:   data.tag  || 'bgm',
      icon:  '/baseball-gm/icon-192.png',
      badge: '/baseball-gm/icon-192.png',
      data:  data.data || {},
    }),
    // Let any open window pull the card into the inbox right away.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.forEach(c => c.postMessage({ type: 'PUSH_RECEIVED', cardId: data.data?.cardId }))),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('/baseball-gm/')) {
          client.postMessage({ type: 'OPEN_INBOX' });
          return client.focus();
        }
      }
      return self.clients.openWindow('/baseball-gm/?tab=inbox');
    })
  );
});
