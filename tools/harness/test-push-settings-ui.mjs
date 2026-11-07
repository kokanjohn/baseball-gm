// r134 The Settings → Notifications line in the real app, against a fake push
// worker and a fake browser push service (Chromium headless has no FCM):
//   receiving — the device is registered and the worker holds its schedule;
//   not registered — the worker holds another endpoint; "Register This Device"
//                    repairs it and the line turns to receiving;
//   paused.
//   node tools/harness/test-push-settings-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
const WORKER = 'https://baseball-gm-push.baseball-gm.workers.dev';
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// A fake push service on the page: permission granted, subscriptions in memory.
await page.addInitScript(() => {
  const key = new Uint8Array(65).fill(7); key[0] = 4;
  let n = 0;
  const pm = {
    sub: null,
    async getSubscription() { return this.sub; },
    async subscribe({ applicationServerKey }) {
      const endpoint = `https://fcm.googleapis.com/fcm/send/fake-${++n}`;
      this.sub = { endpoint, options: { applicationServerKey },
                   toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
                   unsubscribe: async () => { pm.sub = null; return true; } };
      return this.sub;
    },
  };
  window.__pm = pm; window.__key = key;
  const sw = { ready: Promise.resolve({ pushManager: pm }), controller: null,
               register: async () => ({ addEventListener() {}, update() {}, waiting: null, installing: null }),
               addEventListener() {}, getRegistration: async () => null };
  Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => sw, configurable: true });
  window.PushManager = window.PushManager || function () {};
  Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
  localStorage.setItem('bgm_notif_enabled', 'true');
});

// The fake worker. mode: 'normal' mirrors the last /register; 'stale' answers
// as if the worker held a different endpoint (the Nov 7 situation).
let mode = 'normal', lastReg = null;
await page.route(`${WORKER}/**`, async (route) => {
  const url = route.request().url(), path = new URL(url).pathname;
  const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
  if (path === '/vapid-key') return route.fulfill({ body: Buffer.from(new Uint8Array([4, ...new Array(64).fill(7)])).toString('base64url') });
  if (path === '/register') { lastReg = body; return route.fulfill({ body: 'OK' }); }
  if (path === '/device') {
    const known = !!lastReg;
    const d = { ok: true, known, endpointMatches: mode !== 'stale' && known && lastReg.subscription.endpoint === body.endpoint,
                scheduled: lastReg?.schedule?.length || 0, nextAt: lastReg?.schedule?.[0]?.deliverAt ?? null };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  }
  return route.fulfill({ status: 404, body: 'Not found' });
});

await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(1200);

const statusText = () => page.evaluate(() => document.getElementById('notif-status')?.textContent);
const btnState   = () => page.evaluate(() => { const b = document.getElementById('notif-fix-btn');
  return b && b.style.display !== 'none' ? b.textContent : null; });
const shoot = async (name) => {
  const sec = await page.evaluateHandle(() => document.getElementById('notif-status').closest('.settings-section'));
  await sec.asElement().scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await sec.asElement().screenshot({ path: `${out}/push-settings-${name}-${theme}.png` });
};
const waitStatus = async (re) => { for (let i = 0; i < 40; i++) { if (re.test(await statusText() || '')) return true; await page.waitForTimeout(100); } return false; };

// 1. Receiving: the app-open sync created the subscription and registered.
await page.click('#settings-btn');
check('receiving on this device, with the schedule size', await waitStatus(/^Receiving on this device · \d+ alerts? scheduled$|nothing scheduled yet/), await statusText());
check('no fix button while receiving', (await btnState()) === null);
await shoot('receiving');

// 2. The worker holds another endpoint: not registered, with the fix.
mode = 'stale';
await page.evaluate(() => document.getElementById('settings-modal')?.classList.remove('open'));
await page.click('#settings-btn');
check('a stale worker record reads "not registered"', await waitStatus(/^Not registered on this device/), await statusText());
check('…with "Register This Device"', (await btnState()) === 'Register This Device');
await shoot('unregistered');

// 3. Register This Device repairs it.
mode = 'normal';
await page.evaluate(() => { window.__pm.sub = null; });
await page.click('#notif-fix-btn');
check('after Register This Device the line reads receiving', await waitStatus(/^Receiving on this device/), await statusText());

// 4. Paused.
await page.click('#notif-toggle-label');
check('paused', await waitStatus(/^Paused$/), await statusText());
await shoot('paused');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
