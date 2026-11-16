// §122.58 (§122.51 phase 5) the weather on screen: a real held start (found in a new league) — the dashboard's
// first-pitch card with the estimate the messages gave, the schedule's note, and Scores' estimate in place of the
// scheduled time; then the card when the game is postponed today.
//   node tools/harness/test-weather-screens-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { pinEnv } from './ui-env.mjs';   // §122.69 the same moment and dice every run
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await pinEnv(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const t0 = Date.now();
await page.clock.setFixedTime(t0);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
// A new league in each region until one has a held start early on (its first word before first pitch).
const info = await page.evaluate(async ({ theme }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  for (const region of ['south', 'east', 'north', 'west', 'south', 'east']) {
    for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId ?? sl.id);   // (one club at a time)
    await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                            primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region, gameMode: 'live' });
    SM.mutate(s => { s.settings.theme = theme; });
    const sched = SM.get().schedule;
    for (let i = 0; i < Math.min(40, sched.length); i++) {
      const g = sched[i];
      const ev = GE.weatherStoryOf(g);
      const sd = ev.find(e => e.kind === 'start_delayed' && e.at < g.gameTime - 10 * 60_000);
      if (!sd) continue;
      // (the games before it out of the way: as if the club had already played them)
      SM.mutate(s => { for (let k = s.currentGameIndex; k < i; k++) { const x = s.schedule[k]; x._committed = true; x.cancelled = true; x.result = 'postponed'; x.status = 'postponed'; } s.currentGameIndex = i; });
      return { region, i, T: g.gameTime, at: sd.at, est: sd.estStart, opp: g.opponent, home: g.isHome };
    }
  }
  return null;
}, { theme });
check(`a held start found (${info ? `${info.region}, game ${info.i}, ${info.home ? 'home' : 'road'}` : 'none'})`, !!info);
if (!info) { await browser.close(); process.exit(1); }
const now = info.at + 3 * 60_000;
await page.clock.setFixedTime(now);
const est = new Date(info.est).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(1500);
const tap = async (sel) => { try { await page.tap(sel, { timeout: 8000 }); } catch (e) { await page.screenshot({ path: `${out}/wx-stuck-${theme}.png` }); throw e; } await page.waitForTimeout(500); };
await tap('.nav-item[data-tab="dashboard"]');
await page.waitForTimeout(800);
const card = await page.evaluate(() => ({ label: document.querySelector('#fp-card .fp-label')?.innerText || '', time: document.querySelector('#fp-card .fp-time')?.innerText || '', sub: document.querySelector('#fp-card .fp-sub')?.innerText || '' }));
check(`the first-pitch card: "${card.label}" ${card.time} — "${card.sub}" (told: ${est})`, /delayed|estimate/i.test(card.label) && card.time.replace(/\s/g, ' ').includes(est.replace(/\s/g, ' ')));
await page.screenshot({ path: `${out}/wx-card-delayed-${theme}.png` });
await tap('.nav-item[data-tab="schedule"]');
await page.waitForTimeout(800);
const row = await page.evaluate(() => document.querySelector('.game-item.current-game')?.innerText || '');
check(`the schedule's row: "${row.replace(/\s+/g, ' ').slice(0, 120)}"`, /Delayed · est\. first pitch/.test(row));
await page.screenshot({ path: `${out}/wx-schedule-delayed-${theme}.png` });
// Postponed today: the game called off, made up two days later.
await page.evaluate(async ({ i, T, now }) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { const g = s.schedule[i]; g.postponements = [...(g.postponements || []), { date: g.date, gameTime: T, decidedAt: now - 60_000, reason: 'rain' }];
                   g.gameTime = T + 2 * 86_400_000; g.makeup = { how: 'dh' };
                   const d = new Date(`${g.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 2); g.date = d.toISOString().slice(0, 10); });
}, { i: info.i, T: info.T, now });
await tap('.nav-item[data-tab="dashboard"]');
await page.waitForTimeout(800);
const ppd = await page.evaluate(() => document.querySelector('#fp-ppd')?.innerText || '');
check(`postponed today: "${ppd.replace(/\s+/g, ' ')}"`, /Postponed \(rain\)/i.test(ppd) && /Made up/.test(ppd) && /doubleheader/.test(ppd));
await page.screenshot({ path: `${out}/wx-card-postponed-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
