// r134 the browser side of push (ui/PushClient.js), with a fake browser.
//   node tools/harness/check-push-client.mjs
// The bug this guards: from the Oct 26 key rotation to Nov 7 the GM's phone
// had no push subscription. The sync looked for one without creating it,
// found none, and gave up quietly, so the worker held nothing for the device;
// Settings still said "Enabled". Here the sync must repair a missing or
// wrong-key subscription and register the real schedule, deviceStatus() must
// tell the truth, and Send Test's closed-app item must survive later syncs.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { PUSH_WORKER_URL } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const settle = () => new Promise(r => setTimeout(r, 30));

seedRandom(5);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(SM.get().schedule[0].gameTime - 6 * 3600_000);

// ── A fake browser ───────────────────────────────────────────────
const KEY_NEW = new Uint8Array(65).fill(7);  KEY_NEW[0] = 4;
const KEY_OLD = new Uint8Array(65).fill(3);  KEY_OLD[0] = 4;
const b64url = (u8) => Buffer.from(u8).toString('base64url');
let subCounter = 0;
const makeSub = (key) => {
  const endpoint = `https://fcm.googleapis.com/fcm/send/sub-${++subCounter}`;
  const sub = {
    endpoint,
    options: { applicationServerKey: key.buffer.slice(0) },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => { if (pm.sub === sub) pm.sub = null; unsubscribed++; return true; },
  };
  return sub;
};
let unsubscribed = 0;
const pm = {
  sub: null,
  async getSubscription() { return this.sub; },
  async subscribe({ applicationServerKey }) { this.sub = makeSub(new Uint8Array(applicationServerKey)); return this.sub; },
};
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { ready: Promise.resolve({ pushManager: pm }) } }, configurable: true });
globalThis.PushManager = function () {};
globalThis.Notification = { permission: 'granted', requestPermission: async () => 'granted' };

const calls = [];
let device = null;   // what /device answers; null → mirror the last /register
globalThis.fetch = async (url, init = {}) => {
  const path = url.replace(PUSH_WORKER_URL, '');
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ path, body });
  if (path === '/vapid-key') return new Response(b64url(KEY_NEW));
  if (path === '/register')  return new Response('OK');
  if (path === '/test-send') return new Response(JSON.stringify({ ok: true, status: 201 }), { headers: { 'content-type': 'application/json' } });
  if (path === '/device') {
    if (device === 'old-worker') return new Response('Not found', { status: 404 });
    if (device === 'down') throw new Error('offline');
    const last = calls.filter(c => c.path === '/register').pop()?.body;
    const d = device || { ok: true, known: !!last, endpointMatches: last?.subscription?.endpoint === body.endpoint,
                          scheduled: last?.schedule?.length || 0, nextAt: last?.schedule?.[0]?.deliverAt ?? null };
    return new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('Not found', { status: 404 });
};
const registers = () => calls.filter(c => c.path === '/register');

const P = await import('../../ui/PushClient.js');
localStorage.setItem(P.NOTIF_PREF_KEY, 'true');

// 1. The Nov 7 bug: permission granted, no subscription on the device.
console.log('\nA missing subscription is repaired by the next sync');
P.syncPushSchedule({ immediate: true }); await settle();
const r1 = registers().pop();
check('the sync created a subscription with the worker\'s key', !!pm.sub
      && new Uint8Array(pm.sub.options.applicationServerKey).every((v, i) => v === KEY_NEW[i]));
check('and registered this device\'s schedule with the worker', !!r1 && r1.body.subscription.endpoint === pm.sub.endpoint);
check('the schedule carries the game reminders (it was never empty)',
      (r1?.body.schedule || []).some(i => i.id.startsWith('game-reminder-')), JSON.stringify(r1?.body.schedule?.map(i => i.id)));

// 2. Unchanged → no network register; a new endpoint → registered again.
console.log('\nOnly what changed is sent');
let n = registers().length;
P.syncPushSchedule({ immediate: true }); await settle();
check('an unchanged schedule and subscription is not re-sent', registers().length === n);

// 3. A subscription made with the old (rotated) key is replaced.
console.log('\nA subscription made with an old key is replaced');
pm.sub = makeSub(KEY_OLD); const oldEndpoint = pm.sub.endpoint; unsubscribed = 0;
P.syncPushSchedule({ immediate: true }); await settle();
const r3 = registers().pop();
check('the old-key subscription was removed', unsubscribed === 1);
check('a new one with the current key took its place and was registered',
      pm.sub && pm.sub.endpoint !== oldEndpoint && r3.body.subscription.endpoint === pm.sub.endpoint);

// 4. Android dropped the subscription since the last sync: the next sync notices.
console.log('\nA subscription dropped since the last sync');
pm.sub = null; n = registers().length;
P.syncPushSchedule({ immediate: true }); await settle();
check('the next sync re-subscribes and registers (the endpoint is part of what changed)',
      registers().length === n + 1 && registers().pop().body.subscription.endpoint === pm.sub.endpoint);

// 5. deviceStatus tells the truth.
console.log('\nThe Settings line');
let st = await P.deviceStatus();
check('registered with the worker → receiving, with the schedule size',
      st.state === 'receiving' && st.scheduled === registers().pop().body.schedule.length, JSON.stringify(st));
device = { ok: true, known: true, endpointMatches: false, scheduled: 0, nextAt: null };
check('the worker holds a different endpoint → not registered', (await P.deviceStatus()).state === 'unregistered');
device = { ok: true, known: false, endpointMatches: false, scheduled: 0, nextAt: null };
check('the worker doesn\'t know the device → not registered', (await P.deviceStatus()).state === 'unregistered');
device = 'old-worker';
check('a worker from before r134 → unknown (Settings falls back to "Enabled")', (await P.deviceStatus()).state === 'unknown');
device = 'down';
check('worker unreachable → unreachable', (await P.deviceStatus()).state === 'unreachable');
device = null;
localStorage.setItem(P.NOTIF_PREF_KEY, 'false');
check('paused → paused', (await P.deviceStatus()).state === 'paused');
localStorage.setItem(P.NOTIF_PREF_KEY, 'true');
Notification.permission = 'denied';
check('blocked → blocked', (await P.deviceStatus()).state === 'blocked');
Notification.permission = 'granted';

// 6. Send Test's closed-app item survives the sync made when the app is hidden.
console.log('\nSend Test\'s closed-app check');
const t = await P.sendTestPush();
check('the immediate test reports success', t.ok === true);
clock.advance(20_000);
SM.mutate(s => { s.push = { ...(s.push || {}), gameReminder: false }; });   // the schedule changes
P.syncPushSchedule({ immediate: true }); await settle();
const r6 = registers().pop();
check('a later sync (going to the background) still carries the closed-app test',
      r6.body.schedule.some(i => i.id.startsWith('test-closed-')) && !r6.body.schedule.some(i => i.id.startsWith('game-reminder-')));
clock.advance(5 * 60_000);
SM.mutate(s => { s.push = { ...(s.push || {}), gameReminder: true }; });
P.syncPushSchedule({ immediate: true }); await settle();
check('once it\'s long past due it leaves the schedule', !registers().pop().body.schedule.some(i => i.id.startsWith('test-closed-')));

// 7. Permission never granted → nothing is created or sent.
console.log('\nNo permission, no subscription');
Notification.permission = 'default'; pm.sub = null; n = calls.length;
P.syncPushSchedule({ immediate: true }); await settle();
check('without permission the sync does nothing', calls.length === n && !pm.sub);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
