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
 *   POST /test-send   → { userId, subscription } — sends a test push NOW and
 *                       returns the push service's answer + a VAPID key check
 *   GET  /status      → diagnostics: last cron run, key check, per-device
 *                       schedule size and last send result (no secrets)
 * Cron (every minute)
 *   Sends every schedule item with deliverAt <= now as an encrypted Web Push,
 *   then keeps only the items still in the future.
 *
 * Bindings / secrets: SCHEDULES (KV), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *
 * §98 KV budget (Workers Free: 1,000 writes and 1,000 list calls a day, reset
 * at 00:00 UTC; past either, every further call of that kind throws). The cron
 * runs 1,440 times a day, so it must never list or write on a minute with
 * nothing to send. Devices are found through one index key (`meta:devices`,
 * written only when a device is added or removed); a schedule is written
 * only when it changed; the cron writes only after it sent something. Before
 * r93 the cron listed and wrote every minute — both limits ran out each
 * afternoon (US Eastern), and from then until 00:00 UTC no push went out,
 * /register failed and /status threw (Error 1101).
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
  return { status: res.status, response: txt.slice(0, 300) };
}

/** Send one item and describe exactly what happened (never throws). */
async function sendAndReport(subscription, item, env) {
  const at = Date.now();
  try {
    const { status, response } = await sendPush(subscription, item, env);
    return { at, id: item.id, ok: status >= 200 && status < 300, status, response,
             pushService: _host(subscription.endpoint) };
  } catch (e) {
    return { at, id: item.id, ok: false, status: 0, error: String(e?.message || e),
             pushService: _host(subscription.endpoint) };
  }
}

function _host(u) { try { return new URL(u).host; } catch { return '?'; } }

/** Does VAPID_PRIVATE_KEY produce VAPID_PUBLIC_KEY? (a mismatch = every push 403s) */
async function vapidKeyCheck(env) {
  try {
    if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { ok: false, error: 'VAPID secret(s) missing' };
    const key = await crypto.subtle.importKey('pkcs8', wrapPkcs8(b64ToBytes(env.VAPID_PRIVATE_KEY)),
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const pub = b64ToBytes(env.VAPID_PUBLIC_KEY);
    const matches = pub.length === 65 && bytesToB64url(pub.slice(1, 33)) === jwk.x
                                      && bytesToB64url(pub.slice(33)) === jwk.y;
    const subject = String(env.VAPID_SUBJECT || '');
    return {
      ok: matches && /^(mailto:|https:)/.test(subject),
      privateMatchesPublic: matches,
      subjectValid: /^(mailto:|https:)/.test(subject),
      publicKeyPrefix: env.VAPID_PUBLIC_KEY.slice(0, 12),
    };
  } catch (e) {
    return { ok: false, error: 'private key unreadable: ' + String(e?.message || e) };
  }
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
  const key = `sub:${userId}`;
  const prev = await env.SCHEDULES.get(key, 'json');
  // §98 nothing changed (same device subscription, same schedule): no write.
  const same = prev && prev.subscription?.endpoint === subscription.endpoint
    && JSON.stringify(prev.schedule || []) === JSON.stringify(items);
  if (!same) {
    await env.SCHEDULES.put(key, JSON.stringify({ ...(prev || {}), subscription, schedule: items }),
                            { expirationTtl: KV_TTL_SECONDS });
  }
  await _indexAdd(env, userId);
  console.log('[Register]', userId, 'items:', items.length, same ? '(unchanged)' : '(saved)');
  return new Response('OK');
}

// ── §98 the device index (one key, so the cron never lists) ───────────

async function _devices(env) {
  let ids = await env.SCHEDULES.get('meta:devices', 'json');
  if (!Array.isArray(ids)) {
    // First run after the index existed: one list call builds it.
    const list = await env.SCHEDULES.list({ prefix: 'sub:' });
    ids = list.keys.map(k => k.name.slice(4));
    await env.SCHEDULES.put('meta:devices', JSON.stringify(ids));
  }
  return ids;
}
async function _indexAdd(env, userId) {
  const ids = await _devices(env);
  if (!ids.includes(userId)) await env.SCHEDULES.put('meta:devices', JSON.stringify([...ids, userId]));
}
async function _indexRemove(env, userId) {
  const ids = await _devices(env);
  if (ids.includes(userId)) await env.SCHEDULES.put('meta:devices', JSON.stringify(ids.filter(x => x !== userId)));
}

// POST /test-send { userId, subscription } — send right now, report the result.
async function handleTestSend(req, env) {
  let data;
  try { data = await req.json(); } catch { return _json({ ok: false, error: 'Bad JSON' }, 400); }
  const { userId, subscription } = data || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return _json({ ok: false, error: 'missing subscription' }, 400);
  }
  const keys   = await vapidKeyCheck(env);
  const result = await sendAndReport(subscription, {
    id: `test-${Date.now()}`, title: 'The Front Office', body: 'Push notifications are working. ⚾', tag: 'bgm-test',
  }, env);
  if (userId) {
    const rec = await env.SCHEDULES.get(`sub:${userId}`, 'json');
    if (rec) await env.SCHEDULES.put(`sub:${userId}`, JSON.stringify({ ...rec, lastResult: result }),
                                     { expirationTtl: KV_TTL_SECONDS });
  }
  return _json({ ...result, keys });
}

// GET /status — diagnostics (no secrets, no full endpoints).
async function handleStatus(env) {
  const now  = Date.now();
  const subs = [];
  for (const id of (await _devices(env)).slice(0, 20)) {
    const d = await env.SCHEDULES.get(`sub:${id}`, 'json');
    const sched = d?.schedule || [];
    subs.push({
      device:       id.slice(0, 8),
      pushService:  _host(d?.subscription?.endpoint),
      scheduled:    sched.length,
      nextInMin:    sched.length ? Math.round((sched[0].deliverAt - now) / 60000) : null,
      lastResult:   d?.lastResult || null,
    });
  }
  return _json({
    now,
    lastSend: await env.SCHEDULES.get('meta:cron', 'json'),   // §98 written only when the cron sent something
    keys:  await vapidKeyCheck(env),
    subscriptions: subs,
  });
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handleCron(env) {
  const now = Date.now();
  // §98 reads only, unless there is something to send.
  const ids = await _devices(env);
  let report = null;
  for (const id of ids) {
    const key = `sub:${id}`;
    const data = await env.SCHEDULES.get(key, 'json');
    if (!data?.subscription || !data.schedule?.length) continue;
    const due = data.schedule.filter(i => i.deliverAt <= now);
    if (!due.length) continue;
    report = report || { at: now, sent: 0, failures: 0, lastError: null };

    let gone = false, last = null;
    for (const item of due) {
      last = await sendAndReport(data.subscription, item, env);
      report.sent++;
      if (!last.ok) { report.failures++; report.lastError = last; }
      if (last.status === 404 || last.status === 410) { gone = true; break; }   // subscription expired
    }
    if (gone) { await env.SCHEDULES.delete(key); await _indexRemove(env, id); continue; }

    // Re-read before writing so a /register that landed during sending wins.
    const latest = await env.SCHEDULES.get(key, 'json');
    const sentIds = new Set(due.map(i => i.id));
    const schedule = (latest?.schedule || data.schedule).filter(i => !(sentIds.has(i.id) && i.deliverAt <= now));
    await env.SCHEDULES.put(key, JSON.stringify({ ...(latest || data), schedule, lastResult: last }),
                            { expirationTtl: KV_TTL_SECONDS });
  }
  if (report) await env.SCHEDULES.put('meta:cron', JSON.stringify({ ...report, finishedAt: Date.now() }));
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
    try {
      if (request.method === 'POST' && url.pathname === '/register') {
        res = await handleRegister(request, env);
      } else if (request.method === 'POST' && url.pathname === '/test-send') {
        res = await handleTestSend(request, env);
      } else if (request.method === 'GET' && url.pathname === '/status') {
        res = await handleStatus(env);
      } else if (request.method === 'GET' && url.pathname === '/vapid-key') {
        res = new Response(env.VAPID_PUBLIC_KEY, { headers: { 'Content-Type': 'text/plain' } });
      } else {
        res = new Response('Not found', { status: 404 });
      }
    } catch (e) {
      // §98 say what failed (a KV daily limit, for one) instead of Error 1101.
      console.error('[Fetch]', url.pathname, e?.message);
      res = _json({ ok: false, error: String(e?.message || e) }, 503);
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
