/**
 * ui/PushClient.js
 * Browser side of push notifications (§12, §61).
 *
 *   enablePush()        — ask permission, subscribe this device (VAPID), sync
 *   syncPushSchedule()  — send the current card schedule to the worker
 *   sendTestPush()      — real end-to-end test: worker → push service → phone
 *
 * The worker's POST /register REPLACES the device's whole schedule, so every
 * sync sends the complete list of upcoming cards (CardEngine.getPushSchedule).
 * When notifications are paused in Settings the schedule is sent empty.
 *
 * The VAPID public key always comes from the worker (GET /vapid-key) — never a
 * copy bundled in the app, which went stale at every key rotation and, used
 * offline, subscribed the device with a key that could receive nothing (§77).
 * Without the worker, push can't be set up anyway (registration needs it).
 *
 * r134 the sync heals itself. Before, a sync that found no subscription (the
 * Oct 26 key rotation removed one made with the old key; Android can also drop
 * or replace a subscription) quietly gave up, while Settings still said
 * "Enabled" — the device received nothing for twelve days. Now, with
 * permission granted, a missing or wrong-key subscription is replaced and
 * registered on the next sync; sw.js re-registers one Android replaces
 * (pushsubscriptionchange); deviceStatus() tells Settings what the worker
 * actually holds for this device.
 *
 * r138 (§120) the schedule also carries our next game as it will happen —
 * the look-ahead (engine/LookAhead.js) plays it forward on the same seeded
 * dice, and GamePushes turns it into pushes: the start held, delays, play
 * resuming, postponed, suspended, our player hurt, the final. The look-ahead
 * is rerun whenever the save changed, at most once a minute while the app is
 * just running, and at once when it matters: going to the background (the
 * last word before the app closes), a GM decision, a roster move.
 *
 * Browser-only module (navigator / fetch). Not imported by engines or the harness.
 */

import { PUSH_WORKER_URL } from '../data/constants.js';
import * as StateManager from '../store/StateManager.js';
import { getPushSchedule } from '../engine/CardEngine.js';
import { lookAhead } from '../engine/LookAhead.js';
import { getNextGame } from '../engine/GameEngine.js';

export const NOTIF_PREF_KEY = 'bgm_notif_enabled';
const DEVICE_ID_KEY  = 'bgm_push_device_id';
const TEST_ITEM_KEY  = 'bgm_push_test_item';   // r134 Send Test's closed-app item, until it's due
const SYNC_DEBOUNCE  = 1500;
// r134 shared with sw.js (pushsubscriptionchange): which device this is and
// where the worker lives. The service worker can't read localStorage.
const META_DB = 'bgm-push', META_STORE = 'meta';

let _syncTimer = null;
let _syncFresh = false;   // r138 a pending sync must rerun the look-ahead
let _lastSyncSignature = '';
// r138 the look-ahead, kept until the save changes (StateManager.revision).
const AHEAD_THROTTLE_MS = 60_000;          // while the app just runs (the world's clock changes the save often)
const AHEAD_HORIZON_MS  = 36 * 3600_000;   // further out, the next visit will look again
let _ahead = { rev: -1, at: 0, L: null };

export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function pushPaused() {
  return localStorage.getItem(NOTIF_PREF_KEY) === 'false';
}

/**
 * enablePush()
 * @returns {Promise<'granted'|'denied'|'default'|'unsupported'|'unreachable'|'error'>}
 *   'unreachable' — the push server couldn't be reached (offline): try again later.
 */
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm;
  localStorage.setItem(NOTIF_PREF_KEY, 'true');
  try {
    const sub = await _getSubscription({ create: true });
    await _register(_currentSchedule(), sub);
    _lastSyncSignature = '';
    return 'granted';
  } catch (err) {
    console.error('[PushClient] enable failed:', err);
    return err?.code === 'unreachable' ? 'unreachable' : 'error';
  }
}

/**
 * syncPushSchedule({ immediate })
 * Debounced. Safe to call often (after every release, commit, resolve).
 * Skips the network call when nothing changed since the last sync.
 */
export function syncPushSchedule({ immediate = false, fresh = false } = {}) {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  clearTimeout(_syncTimer);
  _syncFresh = _syncFresh || fresh || immediate;
  const run = () => {
    const f = _syncFresh; _syncFresh = false;
    _syncNow({ fresh: f }).catch(err => console.warn('[PushClient] sync failed:', err.message));
  };
  if (immediate) run(); else _syncTimer = setTimeout(run, SYNC_DEBOUNCE);
}

/**
 * sendTestPush()
 * Two-part end-to-end test (§62):
 *   1. NOW: asks the worker to send a push immediately (POST /test-send) and
 *      returns the push service's real answer — success or the exact reason.
 *   2. +90s: queues a second test through the normal schedule + cron, so the
 *      user can close the app and prove delivery while it is closed.
 * @returns {Promise<{ ok, status, response?, error?, keys? }>}
 */
export async function sendTestPush() {
  if (!pushSupported())                      return { ok: false, error: 'This browser does not support push.' };
  if (Notification.permission !== 'granted') return { ok: false, error: 'Notifications are not enabled.' };
  let sub;
  try { sub = await _getSubscription({ create: true }); }
  catch (err) { return { ok: false, error: err?.code === 'unreachable' ? err.message : `could not subscribe this device (${err?.message})` }; }
  if (!sub) return { ok: false, error: 'Could not subscribe this device.' };

  let result;
  try {
    const res = await fetch(`${PUSH_WORKER_URL}/test-send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId: _deviceId(), subscription: sub.toJSON() }),
    });
    result = res.headers.get('content-type')?.includes('json')
      ? await res.json()
      : { ok: false, status: res.status, error: `worker answered ${res.status} — is the latest worker deployed?` };
  } catch (err) {
    result = { ok: false, error: `could not reach the push server (${err.message})` };
  }

  // Part 2: the closed-app test via the regular schedule/cron path. r134 it
  // stays in every sync until it's due — before, closing the app synced the
  // schedule without it and the cron never saw it.
  const later = {
    id:        `test-closed-${Date.now()}`,
    deliverAt: Date.now() + 90 * 1000,
    title:     'The Front Office',
    body:      'Delivered with the app closed. ⚾',
    tag:       'bgm-test-closed',
  };
  try { localStorage.setItem(TEST_ITEM_KEY, JSON.stringify(later)); } catch { /* private mode */ }
  try { await _register(_currentSchedule(), sub); } catch { /* reported via result */ }
  _lastSyncSignature = '';
  return result;
}

/**
 * deviceStatus()
 * r134 what is really true for this device, for the Settings line. Syncs
 * first (which heals a missing subscription), then asks the worker what it
 * holds for this device (POST /device).
 * @returns {Promise<{ state: 'unsupported'|'off'|'blocked'|'paused'|'unregistered'
 *                            |'receiving'|'unreachable'|'unknown',
 *                     scheduled?: Number, nextAt?: Number }>}
 *   'unknown' — the worker predates /device (r134 not deployed yet).
 */
export async function deviceStatus() {
  if (!pushSupported()) return { state: 'unsupported' };
  if (Notification.permission === 'denied')  return { state: 'blocked' };
  if (Notification.permission !== 'granted') return { state: 'off' };
  if (pushPaused()) return { state: 'paused' };
  let sub;
  try {
    await _syncNow();
    sub = await _getSubscription({ create: false });
  } catch (err) {
    return { state: err?.code === 'unreachable' ? 'unreachable' : 'unregistered' };
  }
  if (!sub) return { state: 'unregistered' };
  try {
    const res = await fetch(`${PUSH_WORKER_URL}/device`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId: _deviceId(), endpoint: sub.endpoint }),
    });
    if (res.status === 404) return { state: 'unknown' };
    const d = await res.json();
    if (!d?.ok) return { state: 'unreachable' };
    if (!d.known || !d.endpointMatches) return { state: 'unregistered' };
    return { state: 'receiving', scheduled: d.scheduled, nextAt: d.nextAt };
  } catch {
    return { state: 'unreachable' };
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNALS
// ─────────────────────────────────────────────────────────────

function _currentSchedule({ fresh = true } = {}) {
  if (pushPaused()) return [];
  const state = StateManager.get();
  const items = state ? getPushSchedule(state, Date.now(), _lookAheadFor(state, fresh)) : [];
  const test = _pendingTestItem();
  return test ? [test, ...items].sort((a, b) => a.deliverAt - b.deliverAt) : items;
}

/**
 * r138 our next game as it will happen (null when there's none soon). Rerun
 * when the save changed since — at once when `fresh`, else at most once a
 * minute. A failure leaves the game's pushes out rather than guessing.
 */
function _lookAheadFor(state, fresh) {
  const rev = StateManager.revision(), now = Date.now();
  if (rev === _ahead.rev) return _ahead.L;
  if (!fresh && now - _ahead.at < AHEAD_THROTTLE_MS) return _ahead.L;
  let L = null;
  try {
    const g = getNextGame();
    if (g && Number.isFinite(g.gameTime) && g.gameTime - now <= AHEAD_HORIZON_MS) L = lookAhead(now);
  } catch (err) {
    console.warn('[PushClient] look-ahead failed:', err?.message);
  }
  _ahead = { rev, at: now, L };
  return L;
}

/** Send Test's closed-app item while it's still due to send (r134). */
function _pendingTestItem() {
  let item = null;
  try { item = JSON.parse(localStorage.getItem(TEST_ITEM_KEY) || 'null'); } catch { /* corrupt */ }
  if (item && Number.isFinite(item.deliverAt) && item.deliverAt > Date.now() - 2 * 60_000) return item;
  try { localStorage.removeItem(TEST_ITEM_KEY); } catch { /* private mode */ }
  return null;
}

/**
 * r134 permission granted means the GM turned push on (enablePush is the only
 * place the app asks), so a missing or wrong-key subscription is a fault to
 * repair here — never a reason to stop syncing.
 */
async function _syncNow({ fresh = true } = {}) {
  const sub       = await _getSubscription({ create: true });
  const schedule  = _currentSchedule({ fresh });
  const signature = JSON.stringify([sub.endpoint, schedule.map(i => [i.id, i.deliverAt, i.title, i.body])]);
  if (signature === _lastSyncSignature) return;
  await _register(schedule, sub);
  _lastSyncSignature = signature;
}

async function _register(schedule, sub) {
  if (!sub) throw new Error('no push subscription');
  _saveMeta();
  const body = JSON.stringify({ userId: _deviceId(), subscription: sub.toJSON(), schedule });
  const res = await fetch(`${PUSH_WORKER_URL}/register`, {
    method:  'POST',
    // §94 may be sent as the app goes to the background; let it finish
    // (browsers cap keepalive requests at 64 KB).
    keepalive: body.length < 60_000,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`worker /register ${res.status}`);
}

async function _getSubscription({ create }) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = await _vapidKey();
  // A subscription made with a different VAPID key cannot receive our pushes.
  if (sub && !_sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub && create) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  return sub;
}

let _keyCache = null;
/**
 * The worker's current VAPID public key. Throws (code 'unreachable') when the
 * worker can't be reached — the caller stops there, and an existing
 * subscription is left alone (it is only replaced when the key is known to
 * have changed). A failure is not cached, so the next attempt asks again.
 */
async function _vapidKey() {
  if (_keyCache) return _keyCache;
  let b64 = '';
  try {
    const res = await fetch(`${PUSH_WORKER_URL}/vapid-key`);
    if (res.ok) b64 = (await res.text()).trim();
  } catch { /* offline */ }
  if (!b64) {
    const err = new Error('could not reach the notification server — check your connection and try again');
    err.code = 'unreachable';
    throw err;
  }
  _keyCache = _b64ToBytes(b64);
  return _keyCache;
}

function _sameKey(buf, bytes) {
  if (!buf) return true; // browser didn't expose it — assume unchanged
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}

function _deviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_ID_KEY, id); }
  return id;
}

/** Mirror the device id and worker URL for sw.js (r134). Best effort. */
let _metaSaved = false;
function _saveMeta() {
  if (_metaSaved || typeof indexedDB === 'undefined') return;
  _metaSaved = true;
  try {
    const open = indexedDB.open(META_DB, 1);
    open.onupgradeneeded = (e) => { e.target.result.createObjectStore(META_STORE); };
    open.onsuccess = (e) => {
      try {
        const db = e.target.result;
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put({ deviceId: _deviceId(), workerUrl: PUSH_WORKER_URL }, 'push');
        tx.oncomplete = () => db.close();
      } catch { _metaSaved = false; }
    };
    open.onerror = () => { _metaSaved = false; };
  } catch { _metaSaved = false; }
}

function _b64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s.padEnd(s.length + (4 - s.length % 4) % 4, '='));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
