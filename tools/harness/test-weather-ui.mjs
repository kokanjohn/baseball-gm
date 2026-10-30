// §102.4 (4d-1) The weather on screen, in the real app: a new team, then our
// next game given a weather plan for each situation —
//   1. a rain delay in progress: the live card says so, with a running clock and the radar;
//   2. a start held up, then called off: "Start delayed", then the makeup (next-game card, schedule, scores);
//   3. a game called official after six: the result, the reason, the schedule's "(6)".
//   node tools/harness/test-weather-ui.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const MIN = 60_000;

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.evaluate(async (theme) => {
    const GE = await import('/baseball-gm/engine/GameEngine.js');
    await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
    const SM = await import('/baseball-gm/store/StateManager.js');
    SM.mutate(s => { s.settings.theme = theme; });
  }, theme);
  return { page, errors, ctx };
}

/** Give our next game a weather plan (times in minutes from now) and start the app. */
async function plan(page, p) {
  await page.evaluate(async ({ p, MIN }) => {
    const SM = await import('/baseball-gm/store/StateManager.js');
    const now = Date.now();
    SM.mutate(s => {
      const g = s.schedule[s.currentGameIndex || 0];
      g.gameTime = now + p.gameAt * MIN;
      const venueId = g.isHome ? 'user' : g.opponentId;
      const at = (m) => g.gameTime + m * MIN;
      g.wx = { v: 1, venueId, gameTime: g.gameTime, playMin: 180, outcome: p.outcome || 'played', calledBy: p.calledBy || null,
               reason: p.reason || null, decidedAt: p.decidedAt != null ? now + p.decidedAt * MIN : null,
               startAt: p.outcome === 'postponed' ? null : at(p.startAt || 0),
               delays: (p.delays || []).map(d => ({ startT: at(d.from), endT: at(d.to), atPlayMin: d.atPlayMin, reason: d.reason || 'rain', mm: 6 })),
               endT: p.outcome === 'called' ? at(p.delays[p.delays.length - 1].to) : null, stopAtPlayMin: p.stopAt ?? null };
    });
    const App = await import('/baseball-gm/ui/App.js');
    await App.init();
  }, { p, MIN });
}
const tickNow = (page) => page.evaluate(async () => { const GE = await import('/baseball-gm/engine/GameEngine.js'); GE.tick(); });

// ── 1. A rain delay in progress ─────────────────────────────────────────────
{
  const { page, errors, ctx } = await fresh();
  // First pitch 70 minutes ago; rain stopped play at 40 playing minutes, and won't let up for a while.
  await plan(page, { gameAt: -70, delays: [{ atPlayMin: 40, from: 40, to: 160, reason: 'rain' }] });
  await page.waitForSelector('#live-game-wrap', { timeout: 20000 });
  await page.waitForSelector('.lgv-wx-banner', { timeout: 20000 });
  const pill = await page.textContent('#lgv-status-pill');
  const title = await page.textContent('.lgv-wx-title');
  check(`the live card says it's a rain delay (${pill}; “${title.trim()}”)`, /RAIN DELAY/.test(pill) && /Rain delay · 3\d min/.test(title));
  check('the radar on the ballpark comes up in the delay', !!(await page.$('#lgv-wx #dash-radar-slot .radar-card')));
  const pbp = await page.textContent('#lgv-pbp-feed');
  check('the play-by-play has the tarp coming out', /tarp is coming out/.test(pbp));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/wx-delay-${theme}.png` });
  // The clock runs between ticks.
  const t1 = await page.textContent('[data-wx-since]');
  await page.evaluate(() => { const el = document.querySelector('[data-wx-since]'); el.dataset.wxSince = String(Number(el.dataset.wxSince) - 5 * 60_000); });
  await page.waitForTimeout(5600);
  const t2 = await page.textContent('[data-wx-since]');
  check(`the delay clock runs (${t1} → ${t2})`, t1 !== t2);
  check('no page errors (delay)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── 2. A start held up, then called off ─────────────────────────────────────
{
  const { page, errors, ctx } = await fresh();
  await plan(page, { gameAt: -25, outcome: 'postponed', calledBy: 'limit', reason: 'rain', decidedAt: 90 });
  await page.waitForSelector('.fp-card.fp-delay', { timeout: 20000 });
  const fp = await page.textContent('.fp-card');
  check(`before the call: “Start delayed” with how long (${fp.replace(/\s+/g, ' ').trim()})`, /Start delayed/.test(fp) && /2\d min/.test(fp));
  await page.screenshot({ path: `${out}/wx-start-delayed-${theme}.png` });
  const before = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get(); const g = s.schedule[s.currentGameIndex]; return { date: g.date, opp: g.opponentId }; });
  // The club calls it now.
  await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); SM.mutate(s => { s.schedule[s.currentGameIndex].wx.decidedAt = Date.now() - 1000; }); });
  await tickNow(page);
  await page.waitForTimeout(6000);   // the dashboard's 5-second pulse redraws
  const moved = await page.evaluate(async (b) => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
    const g = s.schedule.find(x => x.postponements?.some(p => p.date === b.date)); return g ? { date: g.date, status: g.status, cancelled: !!g.cancelled, notes: g.postponements } : null; }, before);
  check(`the game was called off (${moved ? (moved.cancelled ? 'a spring game: cancelled' : `made up ${moved.date}`) : 'not found'})`, !!moved);
  const ngc = await page.textContent('.next-game-card');
  check('the dashboard moved on to the next game', !/Start delayed/.test(await page.textContent('#dashboard-content')) && !!ngc);
  // The schedule: the row and its note.
  await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('schedule'); });
  await page.waitForTimeout(800);
  const sched = await page.textContent('#tab-schedule');
  check(`the schedule says what happened (${moved?.cancelled ? 'PPD, not made up' : 'Makeup of …'})`, moved?.cancelled ? /PPD/.test(sched) && /aren't made up/.test(sched) : /Makeup of/.test(sched));
  await page.screenshot({ path: `${out}/wx-schedule-${theme}.png` });
  // The scoreboard for that date shows it as postponed.
  await page.click('#sched-scores-btn');
  await page.waitForTimeout(500);
  // Back to the rainout's date.
  for (let k = 0; k < 6; k++) {
    const label = await page.textContent('#scores-nav');
    const [, m, d] = before.date.split('-').map(Number);
    if (label.includes(`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${d}`)) break;
    await page.click('#scores-nav .sg-nav-btn:first-of-type');
    await page.waitForTimeout(200);
  }
  const scores = await page.textContent('#scores-body');
  check(`that day's scoreboard lists it as PPD`, /PPD/.test(scores), scores.slice(0, 120));
  await page.screenshot({ path: `${out}/wx-scores-${theme}.png` });
  check('no page errors (postponement)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── 3. A game called official ───────────────────────────────────────────────
{
  const { page, errors, ctx } = await fresh();
  // A regular-season-like game: called at 130 playing minutes (the 7th), the call 2½ hours later.
  await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); SM.mutate(s => { const g = s.schedule[s.currentGameIndex]; g.isSpring = false; }); });
  await plan(page, { gameAt: -(130 + 150 + 3), outcome: 'called', calledBy: 'limit', reason: 'rain', stopAt: 130, delays: [{ atPlayMin: 130, from: 130, to: 280 }] });
  await page.waitForTimeout(7000);
  const g = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get(); const x = s.schedule[0]; return { status: x.status, committed: !!x._committed, ruling: x.wxResult?.ruling, score: x.score, gameTime: x.gameTime, date: x.date, susp: x.suspension || null }; });
  const ru = g.ruling;
  check(`the game was ruled (${ru ? `${ru.outcome}: ${ru.text}` : 'no ruling'})`, !!ru);
  await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('schedule'); });
  await page.waitForTimeout(800);
  const sched = await page.textContent('#tab-schedule');
  if (ru?.outcome === 'final') check(`the schedule shows it called short (“(${ru.innings})” and “Called after ${ru.innings} innings”)`, sched.includes(`(${ru.innings})`) && /Called after \d innings/.test(sched));
  else check('the schedule shows it suspended (SUSP, where it stopped, when it picks up)', /SUSP/.test(sched) && /Suspended .* picks up/.test(sched), sched.slice(0, 300));
  await page.screenshot({ path: `${out}/wx-called-${theme}.png` });
  check('no page errors (called)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
