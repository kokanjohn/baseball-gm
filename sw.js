// ── Baseball GM Service Worker ───────────────────────────────────────────────
// Bump CACHE_VERSION with every update to force cache refresh on all devices.
const CACHE_VERSION = 'bgm-v44';
const ASSETS = [
  '/baseball-gm/Baseball_GM.html',
  '/baseball-gm/manifest.json',
];

// ── Scheduled notification store ─────────────────────────────────────────────
// Maps notif id → { deliverAt, title, body, tag, timerId }
const _scheduled = new Map();

function _scheduleNotif(item){
  const { id, deliverAt, title, body, tag } = item;
  const delay = deliverAt - Date.now();
  if(delay < 0) return;
  if(_scheduled.has(id)) clearTimeout(_scheduled.get(id).timerId);
  const timerId = setTimeout(() => {
    self.registration.showNotification(title, {
      body, icon:'/baseball-gm/icon-192.png',
      badge:'/baseball-gm/icon-192.png',
      tag, renotify:true, data:{ cardId:id },
    });
    _scheduled.delete(id);
  }, Math.max(0, delay));
  _scheduled.set(id, { deliverAt, title, body, tag, timerId });
}

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if(!msg || !msg.type) return;
  if(msg.type === 'SCHEDULE_NOTIFS'){
    (msg.items || []).forEach(item => _scheduleNotif(item));
  }
  if(msg.type === 'CANCEL_NOTIF'){
    const id = msg.id;
    if(_scheduled.has(id)){ clearTimeout(_scheduled.get(id).timerId); _scheduled.delete(id); }
    self.registration.getNotifications({ tag:'card-'+id })
      .then(notifs => notifs.forEach(n => n.close()));
  }
  if(msg.type === 'CANCEL_ALL'){
    _scheduled.forEach(({ timerId }) => clearTimeout(timerId));
    _scheduled.clear();
  }
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const cardId = e.notification.data && e.notification.data.cardId;
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for(const client of list){
        if(client.url.includes('/baseball-gm/') && 'focus' in client){
          client.focus();
          if(cardId) client.postMessage({ type:'OPEN_CARD', cardId });
          return;
        }
      }
      return clients.openWindow('/baseball-gm/Baseball_GM.html'+(cardId?'?card='+cardId:''));
    })
  );
});

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS)));
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if(url.origin !== self.location.origin) return;
  if(!ASSETS.some(a => url.pathname === a)) return;
  e.respondWith(
    caches.open(CACHE_VERSION).then(cache =>
      cache.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(r => {
          if(r && r.status === 200) cache.put(e.request, r.clone());
          return r;
        }).catch(() => null);
        return cached || fetchPromise;
      })
    )
  );
});

// ── Server-sent push events ───────────────────────────────────────────────────
// When the Cloudflare worker fires a push, this handler receives it,
// extracts the notification payload, and shows it.
self.addEventListener('push', e => {
  if(!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { return; }
  const { title='The Front Office', body='', tag='bgm', data={} } = payload;
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/baseball-gm/icon-192.png',
      badge: '/baseball-gm/icon-192.png',
      tag,
      renotify: true,
      data,
    })
  );
});
