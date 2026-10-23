/**
 * workers/push-worker.js — Cloudflare Worker "baseball-gm-push" (§12, §61)
 *
 * Deployed by pasting into Cloudflare → Workers & Pages → baseball-gm-push →
 * Edit code. This file is the source of truth for that worker.
 *
 * Endpoints
 *   GET  /vapid-key   → VAPID public key (text/plain)
 *   POST /register    → { userId, subscription, schedule: [{ id, deliverAt, title, body, tag }] }
 *                       Stores the subscription and REPLACES the whole schedule.
 *                       The app re-posts the full schedule whenever it changes.
 * Cron (every minute)
 *   Sends every schedule item with deliverAt <= now as an encrypted Web Push,
 *   then keeps only the items still in the future.
 *
 * Bindings / secrets: SCHEDULES (KV), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *
 * §61 fix: payload encryption followed RFC 8291 incorrectly — the IKM was
 * derived with info = as_public ‖ ua_public, but the standard requires
 * info = "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public. Browsers could not
 * decrypt any message and silently dropped every push.
 */

const MAX_SCHEDULE_ITEMS = 200;
const KV_TTL_SECONDS     = 60 * 60 * 24 * 90;

// ── Encoding helpers ────────────────────────────────────────────

function b64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s.padEnd(s.length + (4 - s.length % 4) % 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function enc(obj) {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────

function wrapPkcs8(raw) {
  // PKCS#8 wrapper for a raw 32-byte P-256 private key (no public key part)
  const prefix = new Uint8Array([
    48, 65, 2, 1, 0, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 8, 42, 134,
    72, 206, 61, 3, 1, 7, 4, 39, 48, 37, 2, 1, 1, 4, 32,
  ]);
  return concat(prefix, raw).buffer;
}

async function makeVapidHeader(endpoint, privateKeyB64, publicKeyB64, subject) {
  const origin  = new URL(endpoint).origin;
  const now     = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: origin, exp: now + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', wrapPkcs8(b64ToBytes(privateKeyB64)),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${bytesToB64url(new Uint8Array(sig))},k=${publicKeyB64}`;
}

// ── Payload encryption (RFC 8291, aes128gcm) ────────────────────

async function hkdf(salt, ikm, info, len) {
  const key  = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

async function encryptPayload(sub, payload) {
  const uaPublic = b64ToBytes(sub.keys.p256dh);   // browser (user agent) public key
  const auth     = b64ToBytes(sub.keys.auth);

  const asKeys   = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey    = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh     = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const te       = new TextEncoder();
  const keyInfo  = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);   // RFC 8291 §3.4
  const ikm      = await hkdf(auth, ecdh, keyInfo, 32);

  const salt     = crypto.getRandomValues(new Uint8Array(16));
  const cek      = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce    = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const cekKey   = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded   = concat(te.encode(payload), new Uint8Array([2]));            // last-record delimiter
  const cipher   = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// ── Send ─────────────────────────────────────────────────────────

async function sendPush(subscription, item, env) {
  const payload = JSON.stringify({
    title: item.title || 'The Front Office',
    body:  item.body  || '',
    tag:   item.tag   || 'bgm',
    data:  { cardId: item.id || '', url: '/baseball-gm/#inbox' },
  });
  const body  = await encryptPayload(subscription, payload);
  const vapid = await makeVapidHeader(subscription.endpoint, env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY, env.VAPID_SUBJECT);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Urgency':          'normal',
      'Authorization':    vapid,
    },
    body,
  });
  const txt = await res.text();
  console.log('[Push]', item.id, '→', res.status, txt.slice(0, 120));
  return res.status;
}

// ── Handlers ────────────────────────────────────────────────────

async function handleRegister(req, env) {
  let data;
  try { data = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const { userId, subscription, schedule } = data || {};
  if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return new Response('Bad request - missing userId or subscription', { status: 400 });
  }
  const items = (Array.isArray(schedule) ? schedule : [])
    .filter(i => i && Number.isFinite(i.deliverAt))
    .sort((a, b) => a.deliverAt - b.deliverAt)
    .slice(0, MAX_SCHEDULE_ITEMS)
    .map(i => ({
      id:        String(i.id || ''),
      deliverAt: i.deliverAt,
      title:     String(i.title || '').slice(0, 120),
      body:      String(i.body  || '').slice(0, 300),
      tag:       String(i.tag   || 'bgm').slice(0, 64),
    }));
  console.log('[Register]', userId, 'items:', items.length);
  await env.SCHEDULES.put(`sub:${userId}`, JSON.stringify({ subscription, schedule: items }),
                          { expirationTtl: KV_TTL_SECONDS });
  return new Response('OK');
}

async function handleCron(env) {
  const now  = Date.now();
  const list = await env.SCHEDULES.list({ prefix: 'sub:' });
  for (const key of list.keys) {
    const data = await env.SCHEDULES.get(key.name, 'json');
    if (!data?.subscription || !data.schedule?.length) continue;
    const due     = data.schedule.filter(i => i.deliverAt <= now);
    const pending = data.schedule.filter(i => i.deliverAt >  now);
    if (!due.length) continue;

    let gone = false;
    for (const item of due) {
      try {
        const status = await sendPush(data.subscription, item, env);
        if (status === 404 || status === 410) { gone = true; break; }   // subscription expired
      } catch (e) {
        console.error('[Cron] Push failed:', e.message);
      }
    }
    if (gone) { await env.SCHEDULES.delete(key.name); continue; }

    // Re-read before writing so a /register that landed during sending wins.
    const latest = await env.SCHEDULES.get(key.name, 'json');
    const sentIds = new Set(due.map(i => i.id));
    const schedule = (latest?.schedule || pending).filter(i => !(sentIds.has(i.id) && i.deliverAt <= now));
    await env.SCHEDULES.put(key.name, JSON.stringify({ ...(latest || data), schedule }),
                            { expirationTtl: KV_TTL_SECONDS });
  }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    let res;
    if (request.method === 'POST' && url.pathname === '/register') {
      res = await handleRegister(request, env);
    } else if (request.method === 'GET' && url.pathname === '/vapid-key') {
      res = new Response(env.VAPID_PUBLIC_KEY, { headers: { 'Content-Type': 'text/plain' } });
    } else {
      res = new Response('Not found', { status: 404 });
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(event, env) {
    try { await handleCron(env); } catch (e) { console.error('[Cron] Fatal:', e.message); }
  },
};

// Exported for the encryption round-trip test (tools/harness/test-webpush.mjs)
export { encryptPayload };
