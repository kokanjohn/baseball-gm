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
 * Browser-only module (navigator / fetch). Not imported by engines or the harness.
 */

import { PUSH_WORKER_URL } from '../data/constants.js';
import * as StateManager from '../store/StateManager.js';
import { getPushSchedule } from '../engine/CardEngine.js';

export const NOTIF_PREF_KEY = 'bgm_notif_enabled';
const DEVICE_ID_KEY  = 'bgm_push_device_id';
const SYNC_DEBOUNCE  = 1500;

let _syncTimer = null;
let _lastSyncSignature = '';

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
    await _getSubscription({ create: true });
    await _register(_currentSchedule());
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
export function syncPushSchedule({ immediate = false } = {}) {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  clearTimeout(_syncTimer);
  const run = () => _syncNow().catch(err => console.warn('[PushClient] sync failed:', err.message));
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

  // Part 2: the closed-app test via the regular schedule/cron path.
  const later = {
    id:        `test-closed-${Date.now()}`,
    deliverAt: Date.now() + 90 * 1000,
    title:     'The Front Office',
    body:      'Delivered with the app closed. ⚾',
    tag:       'bgm-test-closed',
  };
  try { await _register([later, ..._currentSchedule()]); } catch { /* reported via result */ }
  _lastSyncSignature = ''; // next normal sync replaces the test entry
  return result;
}

// ─────────────────────────────────────────────────────────────
// INTERNALS
// ─────────────────────────────────────────────────────────────

function _currentSchedule() {
  if (pushPaused()) return [];
  const state = StateManager.get();
  return state ? getPushSchedule(state) : [];
}

async function _syncNow() {
  const schedule  = _currentSchedule();
  const signature = JSON.stringify(schedule.map(i => [i.id, i.deliverAt]));
  if (signature === _lastSyncSignature) return;
  const sub = await _getSubscription({ create: false });
  if (!sub) return; // never enabled on this device
  await _register(schedule);
  _lastSyncSignature = signature;
}

async function _register(schedule) {
  const sub = await _getSubscription({ create: false });
  if (!sub) throw new Error('no push subscription');
  const res = await fetch(`${PUSH_WORKER_URL}/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userId: _deviceId(), subscription: sub.toJSON(), schedule }),
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

function _b64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s.padEnd(s.length + (4 - s.length % 4) % 4, '='));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
