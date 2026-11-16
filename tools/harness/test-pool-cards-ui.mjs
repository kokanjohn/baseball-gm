// §122.57 r182 the pool's newly dealt cards on screen: a half-hour-before-first-pitch question (its money in the text,
// two answers) and a notice with nothing to decide (one "Understood", like the other notices).
//   node tools/harness/test-pool-cards-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const info = await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  SM.mutate(s => { s.settings.theme = theme; s.inbox = []; s.scheduledCards = []; });
  const q = CE.deliverCardById('pg30_concessions');
  const n = CE.deliverCardById('ms_4_followup');
  return { q: q?.instanceId, n: n?.instanceId, qSubject: q?.subject, nLabels: [n?.yesLabel, n?.noLabel] };
}, { theme });
check(`two cards delivered: ${info.qSubject}; the notice's buttons ${JSON.stringify(info.nLabels)}`, !!info.q && !!info.n && info.nLabels[0] === 'Understood' && info.nLabels[1] == null);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };
await tap('.nav-item[data-tab="decisions"]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/pool-cards-list-${theme}.png` });
await tap(`[data-open="${info.q}"]`);
await page.waitForTimeout(2600);
const qr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.innerText.trim()) }));
check(`the concessions question: "${qr.body.slice(0, 120)}…" — ${qr.btn.join(' / ')}`, /\$\d+K in lost sales/.test(qr.body) && qr.btn.length === 2 && !/\{/.test(qr.body));
await page.screenshot({ path: `${out}/pool-card-pg30-${theme}.png` });
await tap('.nav-item[data-tab="decisions"]');
await page.waitForTimeout(600);
await tap(`[data-open="${info.n}"]`);
await page.waitForTimeout(2600);
const nr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.innerText.trim()) }));
check(`the notice: ${nr.btn.join(' / ')}`, nr.btn.length === 1 && nr.btn[0] === 'Understood');
await page.screenshot({ path: `${out}/pool-card-notice-${theme}.png` });
await tap(`[data-resolve="${info.n}"]`);
await page.waitForTimeout(600);
const done = await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c.instanceId === id)?.resolved; }, info.n);
check('Understood clears it', done === true);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
