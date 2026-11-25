// §122.51 (phase 3) the grounds crew's word on screen: a wet home game's messages in Messages (the morning
// look, the tarp, the start's estimate and its revision, a held start under way), each opened, "Understood".
//   node tools/harness/test-crew-messages-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '/tmp/tfo-shots', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
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
  SM.mutate(s => { s.settings.theme = theme; });
  const g = SM.get().schedule.find(x => x.isHome && !x.isSpring && x.gameTime > now + 2 * 86_400_000);
  const T = g.gameTime, M = 60_000;
  // A wet game day, as the story tells it (the messages as if they'd just come in, in order).
  const evs = [
    { kind: 'outlook', at: T - 9 * 60 * M, chance: 70, wx: 'rain', rainAt: T - 75 * M, proj: 'delayed', estStart: T + 30 * M },
    { kind: 'tarp_on', at: T - 80 * M, reason: 'rain', inGame: false },
    { kind: 'start_delayed', at: T - 60 * M, estStart: T + 35 * M },
    { kind: 'crew_trouble', at: T + 20 * M, mins: 20, estStart: T + 55 * M, inGame: false },
    { kind: 'first_pitch', at: T + 55 * M, lateMin: 55 },
  ].map(e => ({ ...e, id: `${e.kind}:${T}:${Math.round(e.at / M)}` }));
  const opp = g.opponent || 'Gulfport Mullets';
  evs.forEach((e, k) => {
    const m = WM.crewMessage(e, { gameTime: T, opp, seed: 'ui' });
    CE.deliverCrewMessage({ key: `wx:story:1:${T}:${e.id}`, gameTime: T, ...m }, now - (evs.length - k) * 60_000);
  });
  // A decision too: the forecast shows no game (the next home game after it).
  const g2 = SM.get().schedule.find(x => x.isHome && !x.isSpring && x.gameTime > T + 86_400_000);
  const w = WM.decisionWords('calloff', { chance: 90 }, { gameTime: g2.gameTime, opp, seed: 'ui' });
  CE.deliverWeatherDecision({ key: `wx:dec:1:${g2.gameTime}:calloff`, kind: 'calloff', gameTime: g2.gameTime, ...w, expiresAtMs: now + 45 * M, chance: 90, urgent: true }, now - 30_000);
  // §122.56 the crowd during a delay: one card, three answers.
  const wc = WM.decisionWords('comps', { waitMin: 50, inGame: true }, { gameTime: T, opp, seed: 'ui', costK: 11 });
  CE.deliverWeatherDecision({ key: `wx:dec:1:${T}:comps`, kind: 'comps', gameTime: T, ...wc, costK: 11, revenueK: 4, expiresAtMs: now + 20 * M, urgent: true }, now - 20_000);
  CE.releaseDueCards(now);
  const ib = SM.get().inbox.filter(c => c._wxCrew);
  const dec = SM.get().inbox.find(c => c._wxDecision === 'calloff');
  const crowd = SM.get().inbox.find(c => c._wxDecision === 'comps');
  return { ids: ib.map(c => c.instanceId), subjects: ib.map(c => c.subject), est: new Date(T + 35 * M).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), dec: dec?.instanceId, decTime: g2.gameTime, crowd: crowd?.instanceId };
}, { theme, now });
check(`five crew messages delivered: ${info.subjects.join(' | ')}`, info.ids.length === 5);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

await tap('.nav-item[data-tab="decisions"]');
await page.waitForTimeout(600);
const list = await page.evaluate(() => document.body.innerText);
check('Messages lists the crew\'s word, the estimate in the subject', list.includes('Head Groundskeeper') && list.includes(`First pitch delayed`), list.slice(0, 300));
await page.screenshot({ path: `${out}/crew-messages-${theme}.png` });
const delayed = info.ids[info.subjects.findIndex(x => x.startsWith('First pitch delayed'))];
await tap(`[data-open="${delayed}"]`);
await page.waitForTimeout(2600);
const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check(`opened: "${read.body}" — ${read.btn.join(' / ')}`, read.body.includes(info.est) && read.btn.length === 1 && read.btn[0] === 'Understood');
await page.screenshot({ path: `${out}/crew-message-open-${theme}.png` });
await tap(`[data-resolve="${delayed}"]`);
await page.waitForTimeout(600);
const left = await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().inbox.find(c => c.instanceId === id)?.resolved; }, delayed);
check('Understood clears it', left === true);

await tap('.nav-item[data-tab="decisions"]');
await page.waitForTimeout(600);
await tap(`[data-open="${info.dec}"]`);
await page.waitForTimeout(2600);
const dr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check(`the call-off question: ${dr.btn.join(' / ')}`, /no window/.test(dr.body) && dr.btn.includes('Call It Off') && dr.btn.includes('Wait It Out'));
await page.screenshot({ path: `${out}/crew-calloff-${theme}.png` });
await tap(`[data-resolve="${info.dec}"][data-choice="no"]`);
await page.waitForTimeout(800);
const waited = await page.evaluate(async (gt) => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().schedule.find(g => g.gameTime === gt)?.wxWaited; }, info.decTime);
check('Wait It Out: the club waits (and remembers the chance it waited on)', waited?.chance === 90 && waited.auto === false);
await tap('.nav-item[data-tab="decisions"]');
await page.waitForTimeout(600);
await tap(`[data-open="${info.crowd}"]`);
await page.waitForTimeout(2600);
const cr = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.innerText.trim()), rec: !!document.querySelector('.mc-rec') }));
check(`the crowd during a delay: ${cr.btn.join(' / ')}`, cr.btn.length === 3 && cr.btn.some(b => /Free Food/.test(b)) && cr.btn.includes('Keep the Stands Open') && cr.btn.includes('Close the Stands') && !cr.rec);
await page.screenshot({ path: `${out}/crew-crowd-${theme}.png` });
await tap(`[data-resolve="${info.crowd}"][data-pick="sell"]`);
await page.waitForTimeout(800);
const picked = await page.evaluate(async (id) => { const SM = await import('/baseball-gm/store/StateManager.js'); const c = SM.get().inbox.find(x => x.instanceId === id); return c && { r: c.resolved, p: c._pick }; }, info.crowd);
check('Keep the Stands Open: taken', picked?.r && picked.p === 'sell');
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
