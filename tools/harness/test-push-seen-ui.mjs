// r236 §122.115 In the real app with its service worker:
// (1) a push for a message already in Messages, with the app on screen, shows no notification;
// (2) a push for one not in Messages still does;
// (3) opening a message in Messages takes its notification off the phone.
//   node tools/harness/test-push-seen-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ channel: 'chromium' });   // the new headless: notifications work
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'America/New_York' });
await pinEnv(ctx);
await ctx.grantPermissions(['notifications']);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|push|Push/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload({ waitUntil: 'networkidle' });   // now controlled
await page.waitForTimeout(500);
const id = await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return SM.get().inbox.find(c => !c.resolved)?.instanceId;
}, { theme });
await page.waitForTimeout(800);
check('a message is in Messages', !!id);
const perm = await page.evaluate(() => Notification.permission);
check(`notifications allowed (${perm})`, perm === 'granted');

// A real push into the service worker (CDP), the app on screen.
const cdp = await ctx.newCDPSession(page);
await cdp.send('ServiceWorker.enable');
let regId = null;
cdp.on('ServiceWorker.workerRegistrationUpdated', e => { for (const r of e.registrations) if (/baseball-gm/.test(r.scopeURL)) regId = r.registrationId; });
for (let i = 0; i < 20 && !regId; i++) await page.waitForTimeout(100);
check('the service worker is registered', !!regId);
const push = (tag) => cdp.send('ServiceWorker.deliverPushMessage', { origin: 'http://localhost:8765', registrationId: regId,
  data: JSON.stringify({ title: 'Head Trainer', body: 'A test', tag }) });
const notes = (tag) => page.evaluate(async (tag) => (await (await navigator.serviceWorker.ready).getNotifications(tag ? { tag } : {})).map(n => n.tag), tag);

await push(id); await page.waitForTimeout(2500);
check('a push for a message already in Messages: no notification', (await notes(id)).length === 0, JSON.stringify(await notes()));
await push('not-in-messages'); await page.waitForTimeout(2500);
check('a push for one not in Messages: shown', (await notes('not-in-messages')).length === 1, JSON.stringify(await notes()));

// Opening a message clears its notification.
await page.evaluate(async (id) => (await navigator.serviceWorker.ready).showNotification('Head Trainer', { tag: id, body: 'x' }), id);
await page.waitForTimeout(300);
check('its notification is up', (await notes(id)).length === 1);
await page.click('[data-tab="decisions"]'); await page.waitForTimeout(500);
await page.click(`[data-open="${id}"]`); await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/push-seen-${theme}.png` });
check('opening the message clears its notification', (await notes(id)).length === 0, JSON.stringify(await notes()));
check('the other notification stays', (await notes('not-in-messages')).length === 1);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
