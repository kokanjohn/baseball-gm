/**
 * Baseball GM — Push Notification Scheduler
 * Cloudflare Worker + KV storage
 *
 * Receives FCM tokens + schedules from the app.
 * Cron fires every minute, sends due notifications via FCM HTTP v1 API.
 *
 * Endpoints:
 *   POST /register   — store FCM token + schedule
 *   POST /schedule   — update schedule for existing token
 *   GET  /vapid-key  — not needed for FCM but kept for compatibility
 */

const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects/baseball-gm-push/messages:send';

// ── Get a Google OAuth2 access token using a service account ─────────────────
// We store the service account JSON as a Worker secret: FCM_SERVICE_ACCOUNT_JSON
async function getFCMAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header  = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const payload = btoa(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

  const msg = `${header}.${payload}`;

  // Import private key
  const pemBody = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----','')
    .replace('-----END PRIVATE KEY-----','')
    .replace(/\s/g,'');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(msg)
  );
  const jwt = `${msg}.${btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

// ── Send one FCM push notification ────────────────────────────────────────────
async function sendFCM(fcmToken, item, env) {
  const accessToken = await getFCMAccessToken(env.FCM_SERVICE_ACCOUNT_JSON);
  const res = await fetch(FCM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: {
          title: item.title || 'The Front Office',
          body:  item.body  || '',
        },
        webpush: {
          notification: {
            icon:     'https://kokanjohn.github.io/baseball-gm/icon-192.png',
            badge:    'https://kokanjohn.github.io/baseball-gm/icon-192.png',
            tag:      item.tag || 'bgm',
            renotify: true,
          },
          fcm_options: {
            link: 'https://kokanjohn.github.io/baseball-gm/Baseball_GM.html',
          },
        },
        data: { cardId: item.id || '' },
      },
    }),
  });
  return res.status;
}

// ── Request handlers ──────────────────────────────────────────────────────────

async function handleRegister(req, env) {
  const { userId, subscription, schedule } = await req.json();
  if(!userId || !subscription || !subscription.fcmToken)
    return new Response('Bad request', { status: 400 });
  await env.SCHEDULES.put(`sub:${userId}`, JSON.stringify({
    fcmToken: subscription.fcmToken,
    schedule: schedule || [],
  }), { expirationTtl: 60 * 60 * 24 * 90 });
  return new Response('OK');
}

async function handleSchedule(req, env) {
  const { userId, schedule } = await req.json();
  if(!userId || !schedule) return new Response('Bad request', { status: 400 });
  const existing = await env.SCHEDULES.get(`sub:${userId}`, 'json');
  if(!existing) return new Response('Not found', { status: 404 });
  existing.schedule = schedule;
  await env.SCHEDULES.put(`sub:${userId}`, JSON.stringify(existing), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
  return new Response('OK');
}

// ── Cron: fire due notifications ──────────────────────────────────────────────

async function handleCron(env) {
  const now  = Date.now();
  const list = await env.SCHEDULES.list({ prefix: 'sub:' });

  for(const key of list.keys){
    const data = await env.SCHEDULES.get(key.name, 'json');
    if(!data || !data.fcmToken || !data.schedule || !data.schedule.length) continue;

    const due     = data.schedule.filter(item => item.deliverAt <= now);
    const pending = data.schedule.filter(item => item.deliverAt  > now);
    if(!due.length) continue;

    for(const item of due){
      try {
        const status = await sendFCM(data.fcmToken, item, env);
        if(status === 404) {
          // Token no longer valid — remove record
          await env.SCHEDULES.delete(key.name);
          break;
        }
      } catch(e) {
        console.error('FCM send failed:', e.message);
      }
    }

    data.schedule = pending;
    await env.SCHEDULES.put(key.name, JSON.stringify(data), {
      expirationTtl: 60 * 60 * 24 * 90,
    });
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if(request.method === 'OPTIONS') return new Response(null, { headers: cors });

    let res;
    if(request.method === 'POST' && url.pathname === '/register')
      res = await handleRegister(request, env);
    else if(request.method === 'POST' && url.pathname === '/schedule')
      res = await handleSchedule(request, env);
    else if(request.method === 'GET' && url.pathname === '/vapid-key')
      res = new Response('n/a — using FCM', { status: 200 });
    else
      res = new Response('Not found', { status: 404 });

    const headers = new Headers(res.headers);
    for(const [k,v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },

  async scheduled(event, env) {
    await handleCron(env);
  },
};
