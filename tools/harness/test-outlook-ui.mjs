// r277 §122.156 the Schedule's Forecast button: the 10-day outlook as a TV weather segment shows it — ten tiles,
// each the day, a large icon, the high and low and the chance of rain; each day where the club is.
//   node tools/harness/test-outlook-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
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
await page.tap('.nav-item[data-tab="schedule"]'); await page.waitForTimeout(600);
const btns = await page.$$eval('.sched-head-btns button', bs => bs.map(b => b.textContent.trim()));
check(`the Schedule's top: ${btns.join(' | ')}`, btns.join('|') === 'Forecast|Scores');
await page.tap('#sched-fc-btn');
await page.waitForFunction(() => document.querySelectorAll('.ol-tile:not(.ol-wait)').length === 10, null, { timeout: 30000 }).catch(() => {});
const t = await page.evaluate(() => [...document.querySelectorAll('.ol-tile')].map(el => ({
  day: el.querySelector('.ol-day')?.textContent.trim(), where: el.querySelector('.ol-where')?.textContent.trim(), venue: el.dataset.venue,
  icon: !!el.querySelector('.ol-icon svg'), iconW: Math.round(el.querySelector('.ol-icon')?.getBoundingClientRect().width || 0),
  hi: el.querySelector('.ol-hi')?.textContent.trim(), lo: el.querySelector('.ol-lo')?.textContent.trim(), pct: el.querySelector('.ol-pct')?.textContent.trim(),
  top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom) })));
console.log(t.map(x => `    ${x.day} ${x.where ? `(${x.where}) ` : ''}${x.hi}/${x.lo} ${x.pct}`).join('\n'));
check(`ten days, starting today (${t.length})`, t.length === 10 && t[0].day === 'Today');
check('each: a large icon, the high and low, the chance of rain', t.every(x => x.icon && x.iconW >= 44 && /^-?\d+°$/.test(x.hi) && /^-?\d+°$/.test(x.lo) && /^\d+%$/.test(x.pct)));
check('two rows of five, all on screen at once', new Set(t.map(x => x.top)).size === 2 && Math.max(...t.map(x => x.bottom)) <= 800);
const hdr = await page.evaluate(() => ({ k: document.querySelector('.ol-kicker')?.textContent, c: document.querySelector('.ol-city')?.textContent }));
check(`the header: “${hdr.k}” · ${hdr.c}`, hdr.k === '10-Day Outlook' && !!hdr.c);

// each day where the club is: the park of that day's game, else the next game's
const want = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { outlookVenues } = await import('/baseball-gm/ui/components/OutlookSheet.js');
  const { outlookFor } = await import('/baseball-gm/ui/components/ForecastSource.js');
  const days = await outlookFor(SM.get(), 'user', Date.now());
  return outlookVenues(SM.get(), days, Date.now());
});
check(`each day at the club's park that day (${want.join(', ')})`, want.every((v, i) => t[i].venue === v) && t.every(x => (x.venue !== 'user') === !!x.where));
await page.screenshot({ path: `${out}/outlook-${theme}.png` });
await page.tap('#ol-close'); await page.waitForTimeout(400);
check('closes', await page.evaluate(() => !document.getElementById('ol-sheet')));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
