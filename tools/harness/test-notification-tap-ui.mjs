// r273 §122.152 where a tapped notification opens: the game's own pushes (first pitch, one of ours hurt, the final)
// open the Dashboard; a message's push (and the 30-minute reminder) opens Messages.
//   node tools/harness/test-notification-tap-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

// ── the service worker's choice (sw.js _tapTab), on the ids GamePushes and the inbox really use ──
const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const src = sw.match(/function _tapTab\(data\) \{[\s\S]*?\n\}/)?.[0];
check('sw.js decides where a tap opens', !!src);
const tapTab = new Function(`${src}; return _tapTab;`)();
const cases = [['g:1767225900000:start', 'dashboard'], ['g:1767225900000:final', 'dashboard'], ['g:1767225900000:hurt:p_123', 'dashboard'],
  ['game-reminder-1767225900000', 'inbox'], ['ci_abc123', 'inbox'], ['', 'inbox']];
const wrong = cases.filter(([id, want]) => tapTab({ cardId: id }) !== want);
check(`first pitch, an injury and the final open the Dashboard; messages and the reminder open Messages`, wrong.length === 0, JSON.stringify(wrong));
check('a notification with no data opens Messages', tapTab(undefined) === 'inbox');

// ── the app ──
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(800);
const active = () => page.evaluate(() => document.querySelector('.nav-item.active')?.dataset.tab || '');
const post = (data) => page.evaluate((data) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data })), data);

await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(300);
await post({ type: 'OPEN_TAB', tab: 'dashboard' }); await page.waitForTimeout(600);
check(`app open on Messages, first pitch tapped: the Dashboard (${await active()})`, await active() === 'dashboard');
await post({ type: 'OPEN_TAB', tab: 'inbox' }); await page.waitForTimeout(600);
check(`a message's notification tapped: Messages (${await active()})`, await active() === 'decisions');

await page.goto('http://localhost:8765/baseball-gm/?tab=dashboard', { waitUntil: 'networkidle' }); await page.waitForTimeout(1200);
check(`app closed, first pitch tapped: opens on the Dashboard (${await active()})`, await active() === 'dashboard');
await page.goto('http://localhost:8765/baseball-gm/?tab=inbox', { waitUntil: 'networkidle' }); await page.waitForTimeout(1200);
check(`app closed, a message tapped: opens on Messages (${await active()})`, await active() === 'decisions');
check('…and the address is cleaned up', await page.evaluate(() => location.search === ''));
await page.screenshot({ path: `${out}/notification-tap-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
