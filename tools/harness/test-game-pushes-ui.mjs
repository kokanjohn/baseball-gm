// §120 (r138) Game pushes in the real app, against a fake push worker and a
// fake browser push service (as test-push-settings-ui.mjs):
//   1. opened 10 hours before first pitch, the app registers our next game's
//      pushes (the final at least) — exactly the look-ahead's;
//   2. a GM change (the batting order) → the app re-sends a schedule that
//      matches the game as it now will go, at once (never the stale one);
//   3. Settings: the five toggles; Final Score off → no final in the schedule.
//   node tools/harness/test-game-pushes-ui.mjs outDir [theme]
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
await page.addInitScript(() => {
  const key = new Uint8Array(65).fill(7); key[0] = 4;
  const pm = {
    sub: null,
    async getSubscription() { return this.sub; },
    async subscribe({ applicationServerKey }) {
      const endpoint = 'https://fcm.googleapis.com/fcm/send/fake-1';
      this.sub = { endpoint, options: { applicationServerKey }, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
                   unsubscribe: async () => { pm.sub = null; return true; } };
      return this.sub;
    },
  };
  const sw = { ready: Promise.resolve({ pushManager: pm }), controller: null,
               register: async () => ({ addEventListener() {}, update() {}, waiting: null, installing: null }),
               addEventListener() {}, getRegistration: async () => null };
  Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => sw, configurable: true });
  window.PushManager = window.PushManager || function () {};
  Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
  localStorage.setItem('bgm_notif_enabled', 'true');
});
const regs = [];
await page.route(`${WORKER}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname;
  const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
  if (path === '/vapid-key') return route.fulfill({ body: Buffer.from(new Uint8Array([4, ...new Array(64).fill(7)])).toString('base64url') });
  if (path === '/register') { regs.push(body); return route.fulfill({ body: 'OK' }); }
  if (path === '/device') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, known: true, endpointMatches: true, scheduled: regs.at(-1)?.schedule?.length || 0, nextAt: regs.at(-1)?.schedule?.[0]?.deliverAt ?? null }) });
  return route.fulfill({ status: 404, body: 'Not found' });
});

let now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const T0 = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; s.push.quietStart = '03:00'; s.push.quietEnd = '03:01'; });
  return SM.get().schedule[0].gameTime;
}, theme);
now = T0 - 10 * 3600_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(2500);

const gameItems = (reg) => (reg?.schedule || []).filter(i => i.id.startsWith('g:')).map(({ id, deliverAt, title, body, tag }) => ({ id, deliverAt, title, body, tag }));
const expected = () => page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const LA = await import('/baseball-gm/engine/LookAhead.js');
  return CE.getPushSchedule(SM.get(), Date.now(), LA.lookAhead(Date.now())).filter(i => i.id.startsWith('g:'))
    .map(({ id, deliverAt, title, body, tag }) => ({ id, deliverAt, title, body, tag }));
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Opened 10 hours before.
const first = gameItems(regs.at(-1));
const exp1 = await expected();
console.log(`    ${first.length} game pushes registered: ${first.map(i => i.title).join(' | ')}`);
check('opened 10 hours ahead, the app registers our next game\'s pushes, the final among them', first.some(i => i.id === `g:${T0}:final`));
check('…exactly the look-ahead\'s', same(first, exp1), JSON.stringify(first).slice(0, 200));

// 2. A GM change: a bench hitter takes over at DH. The app re-sends at once.
const n0 = regs.length;
const swapped = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const EB = await import('/baseball-gm/ui/EventBus.js');
  const st = SM.get(), t = st.userTeam;
  const inLineup = new Set(t.lineupSlots.map(x => x.playerId));
  const bench = t.rosterIds.map(id => st.players[id]).find(p => p && !inLineup.has(p.id) && !['SP', 'RP'].includes(p.pos) && !p.injury);
  SM.mutate(s => { const dh = s.userTeam.lineupSlots.find(x => x.slot === 'DH'); if (dh && bench) dh.playerId = bench.id; });
  EB.emit('roster:changed', { type: 'swap' });
  return { dh: SM.get().userTeam.lineupSlots.find(x => x.slot === 'DH')?.playerId, bench: bench?.id, idx: SM.get().currentGameIndex, status: SM.get().schedule[SM.get().currentGameIndex]?.status };
});
console.log('    the change:', JSON.stringify(swapped));
await page.waitForTimeout(2500);
const after = gameItems(regs.at(-1)), exp2 = await expected();
console.log(`    after the change: ${after.map(i => i.title).join(' | ')} (expected: ${exp2.map(i => i.title).join(' | ')})${same(after, first) ? ' (the game goes the same way)' : ''}`);
check('after a GM change the registered pushes match the game as it now will go', same(after, exp2), JSON.stringify(after).slice(0, 200));
check('…sent at once (no one-minute wait)', regs.length > n0 || same(exp2, first));

// 3. Settings.
await page.click('#settings-btn');
await page.waitForTimeout(400);
const toggles = await page.$$eval('.push-alert-toggle', els => els.map(e => ({ k: e.dataset.alert, on: e.checked })));
check('Settings shows the five kinds, all on', toggles.length === 5 && toggles.every(t => t.on), JSON.stringify(toggles));
const sec = await page.evaluateHandle(() => document.getElementById('notif-status').closest('.settings-section'));
await sec.asElement().scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
await sec.asElement().screenshot({ path: `${out}/push-alerts-${theme}.png` });
await page.click('.push-alert-toggle[data-alert="final"] + .toggle-track');
await page.waitForTimeout(2500);
check('Final Score off → no final in the registered schedule', !gameItems(regs.at(-1)).some(i => i.id.endsWith(':final'))
      && await page.evaluate(async () => (await import('/baseball-gm/store/StateManager.js')).get().push.alerts.final === false));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
