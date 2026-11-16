// §122.58 (phase 4) the traveling party's word on screen: a wet road game's updates in Messages (a heads-up, the
// start held, a new estimate, under way, a delay, a postponement), from the Travel Coordinator, each "Understood".
//   node tools/harness/test-away-weather-ui.mjs outDir [theme]
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
const info = await page.evaluate(async ({ theme, now }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const WM = await import('/baseball-gm/engine/WeatherMessages.js');
  SM.mutate(s => { s.settings.theme = theme; s.inbox = []; s.scheduledCards = []; });
  const g = SM.get().schedule.find(x => !x.isHome && !x.isSpring && x.gameTime > now + 2 * 86_400_000);
  const T = g.gameTime, M = 60_000, city = 'Tideland';
  const evs = [
    { kind: 'outlook', at: T - 9 * 60 * M, chance: 70, wx: 'rain', rainAt: T - 30 * M, proj: 'delayed', estStart: T + 30 * M },
    { kind: 'start_delayed', at: T - 40 * M, estStart: T + 35 * M, reason: 'rain' },
    { kind: 'start_estimate', at: T + 10 * M, estStart: T + 60 * M, prevEst: T + 35 * M },
    { kind: 'first_pitch', at: T + 60 * M, lateMin: 60 },
    { kind: 'delay', at: T + 150 * M, estResume: T + 190 * M, reason: 'lightning' },
  ].map(e => ({ ...e, id: `${e.kind}:${T}:${Math.round(e.at / M)}` }));
  evs.forEach((e, k) => {
    const m = WM.awayMessage(e, { gameTime: T, city, seed: 'ui-away' });
    CE.deliverCrewMessage({ key: `wx:story:1:${T}:${e.id}`, gameTime: T, ...m }, now - (evs.length + 1 - k) * 60_000);
  });
  const g2 = SM.get().schedule.find(x => !x.isHome && !x.isSpring && x.gameTime > T + 86_400_000);
  const p = WM.awayPostponedMessage({ city: 'Gulfport', reason: 'rain', makeup: 'tomorrow at 1:05 PM, as part of a doubleheader', seed: 'ui', id: 3 });
  CE.deliverCrewMessage({ key: `wx:story:1:${g2.gameTime}:ppd`, gameTime: g2.gameTime, ...p, calledOff: true }, now - 30_000);
  CE.releaseDueCards(now);
  const ib = SM.get().inbox.filter(c => c._wxCrew);
  return { ids: ib.map(c => c.instanceId), subjects: ib.map(c => c.subject), senders: [...new Set(ib.map(c => c.sender))], decisions: SM.get().inbox.filter(c => c._wxDecision).length };
}, { theme, now });
check(`six road updates, from the Travel Coordinator, nothing to decide: ${info.subjects.join(' | ')}`, info.ids.length === 6 && info.senders.length === 1 && info.senders[0] === 'Travel Coordinator' && info.decisions === 0);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };
await tap('.nav-item[data-tab="decisions"]');
await page.waitForTimeout(600);
const list = await page.evaluate(() => document.body.innerText);
check('Messages lists them with the host city', list.includes('Travel Coordinator') && list.includes('Tideland'), list.slice(0, 300));
await page.screenshot({ path: `${out}/away-weather-list-${theme}.png` });
const byStart = (pre) => info.ids[info.subjects.findIndex(x => x.startsWith(pre))];
const opened = [byStart('New estimate'), byStart("Today's game")];
for (const [id, label] of [[opened[0], 'estimate'], [opened[1], 'postponed']]) {
  await tap(`[data-open="${id}"]`);
  await page.waitForTimeout(2600);
  const r = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.innerText.trim()) }));
  check(`the ${label}, opened: "${r.body}" — ${r.btn.join(' / ')}`, (label === 'estimate' ? /\(was \d{1,2}:\d{2} [AP]M\)/ : /made up tomorrow/).test(r.body) && r.btn.length === 1 && r.btn[0] === 'Understood');
  await page.screenshot({ path: `${out}/away-weather-${label}-${theme}.png` });
  await tap(`[data-resolve="${id}"]`);
  await page.waitForTimeout(600);
  await tap('.nav-item[data-tab="decisions"]');
  await page.waitForTimeout(600);
}
const done = await page.evaluate(async (ids) => { const SM = await import('/baseball-gm/store/StateManager.js'); return ids.map(id => SM.get().inbox.find(c => c.instanceId === id)?.resolved); }, opened);
check('Understood clears them', done.every(Boolean));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
