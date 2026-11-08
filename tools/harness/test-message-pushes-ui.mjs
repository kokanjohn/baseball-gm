// §121 (r139) Every message pushable, in the real app — against a fake push
// worker and a fake browser push service (as test-game-pushes-ui.mjs):
//   1. opened, the app works out the next day in its worker (the page never
//      runs it) and registers every message the world will make — exactly
//      the look-ahead's (computed here on the page to compare);
//   2. a GM answer → the foresight is stale → worked out again in the worker
//      a moment later, and the schedule re-sent to match;
//   3. the app closing right after an answer (before the worker is done):
//      worked out on the page at once, so the last word is never stale.
//   node tools/harness/test-message-pushes-ui.mjs [hoursIn=40]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const HOURS_IN = parseFloat(process.argv[2] || '40');
const WORKER = 'https://baseball-gm-push.baseball-gm.workers.dev';
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'warning' && /look-ahead/.test(m.text())) errors.push(m.text()); });
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
  if (path === '/device') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, known: true, endpointMatches: true, scheduled: 0, nextAt: null }) });
  return route.fulfill({ status: 404, body: 'Not found' });
});

await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
// A new club; the world played on a while (so there's an inbox and a trade desk), then the app opened.
const T0 = await page.evaluate(async () => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.push.quietStart = '03:00'; s.push.quietEnd = '03:01'; });
  return SM.get().schedule[0].gameTime;
});
const now = T0 - 30 * 3600_000 + HOURS_IN * 3600_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });

const status = () => page.evaluate(async () => (await import('/baseball-gm/ui/PushClient.js')).foresightStatus());
const waitFor = async (pred, ms = 20000) => { for (let t = 0; t < ms; t += 250) { const s = await status(); if (pred(s)) return s; await page.waitForTimeout(250); } return status(); };
const msgItems = (reg) => (reg?.schedule || []).filter(i => !i.id.startsWith('g:') && !i.id.startsWith('game-reminder') && !i.id.startsWith('test-'))
  .map(({ id, deliverAt, title, body }) => ({ id, deliverAt, title, body }));
const expected = () => page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const LA = await import('/baseball-gm/engine/LookAhead.js');
  const n = Date.now();
  const f = LA.foresee(n, n + 24 * 3600_000, 36 * 3600_000);
  return { items: CE.getPushSchedule(SM.get(), n, f.game, f.foreseen).filter(i => i.kind === 'messages')
             .map(({ id, deliverAt, title, body }) => ({ id, deliverAt, title, body })),
           planned: (SM.get().scheduledCards || []).filter(c => !c._seed && c.deliverAtMs > n && c.deliverAtMs <= n + 24 * 3600_000).length };
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Opened.
const s1 = await waitFor(s => s.where === 'worker' && s.valid);
await page.waitForTimeout(800);
const e1 = await expected();
const r1 = msgItems(regs.at(-1));
console.log(`    worker: ${s1.ms} ms, ${s1.messages} messages foreseen in the next 24 hours (${e1.planned} of them already planned); ${r1.length} message pushes registered`);
r1.slice(0, 6).forEach(i => console.log(`      ${new Date(i.deliverAt).toISOString().slice(5, 16)}  ${i.title}: ${i.body}`));
check('opened, the next day is worked out in the worker (not on the page)', s1.where === 'worker' && s1.valid, JSON.stringify(s1));
check('…and every message the world will make is registered — exactly the look-ahead\'s', same(r1, e1.items), `${r1.length} vs ${e1.items.length}`);

// 2. A GM answer.
const answered = await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const EB = await import('/baseball-gm/ui/EventBus.js');
  const c = CE.getInbox().find(x => !x.resolved && !x.isCompose);
  if (!c) return null;
  try { CE.resolve(c.instanceId, 'no'); } catch { CE.resolve(c.instanceId, 'yes'); }
  EB.emit('card:resolved', { instanceId: c.instanceId, choice: 'no' });
  return c.subject;
});
const stale = await status();
check('an answer makes the foresight stale at once', !!answered && stale.valid === false, `${answered} ${JSON.stringify(stale)}`);
const s2 = await waitFor(s => s.where === 'worker' && s.valid && s.at !== s1.at);
await page.waitForTimeout(800);
const e2 = await expected(), r2 = msgItems(regs.at(-1));
check('…worked out again in the worker a moment later, and the schedule re-sent to match', s2.valid && same(r2, e2.items), `${r2.length} vs ${e2.items.length}`);

// 3. Closing right after an answer.
const n3 = regs.length;
await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const EB = await import('/baseball-gm/ui/EventBus.js');
  const c = CE.getInbox().find(x => !x.resolved && !x.isCompose);
  if (c) { try { CE.resolve(c.instanceId, 'no'); } catch { CE.resolve(c.instanceId, 'yes'); } EB.emit('card:resolved', { instanceId: c.instanceId, choice: 'no' }); }
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(1200);
const s3 = await status(), e3 = await expected(), r3 = msgItems(regs.at(-1));
check('closing right after an answer: worked out on the page at once, and the last schedule sent is current',
      s3.where === 'page' && s3.valid && same(r3, e3.items), `${JSON.stringify(s3)} ${r3.length} vs ${e3.items.length}`);
check('no page errors (and no failed look-ahead)', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
