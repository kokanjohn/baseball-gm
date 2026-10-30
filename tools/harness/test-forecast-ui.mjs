// §102.7 (step 3) The forecast on screen, in the real app: a new team; the next game's forecast line
// on the dashboard (from the worker, the same numbers the engine gives), the forecast sheet, and the idle
// dashboard still not scrolling.
//   node tools/harness/test-forecast-ui.mjs outDir [theme] [throttle]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark', throttle = '1'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
if (+throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +throttle }); }
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForSelector('#ngc-fc', { state: 'attached', timeout: 20000 });
const t0 = Date.now();
await page.waitForFunction(() => document.getElementById('ngc-fc')?.textContent !== 'Forecast…', null, { timeout: 30000 });
const ms = Date.now() - t0;
const line = (await page.textContent('#ngc-fc')).trim();
check(`the next game's forecast line fills in (${ms} ms): “${line}”`, /^\d+° · .+/.test(line));
// The same numbers as the engine, worked out directly here.
const direct = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { weatherContext } = await import('/baseball-gm/engine/WeatherClimate.js');
  const { forecastForGame } = await import('/baseball-gm/engine/GameWeather.js');
  const { forecastLine } = await import('/baseball-gm/ui/components/ForecastSheet.js');
  const s = SM.get(), g = s.schedule[s.currentGameIndex];
  const f = forecastForGame(weatherContext(s), Date.now(), g);
  return { line: forecastLine(f), f };
});
check(`it's exactly the engine's forecast for that game (“${direct.line}”)`, direct.line === line);
// Idle dashboard: no scrolling added (against the same page without the line).
const over = await page.evaluate(() => {
  const t = document.getElementById('tab-dashboard'); const el = document.getElementById('ngc-fc');
  const a = t.scrollHeight - t.clientHeight; el.style.display = 'none'; const b = t.scrollHeight - t.clientHeight; el.style.display = '';
  return { a, b };
});
check(`the idle dashboard still doesn't scroll (overflow ${over.a}px; ${over.b}px without the line)`, over.a <= Math.max(0, over.b));
await page.screenshot({ path: `${out}/fc-dashboard-${theme}.png` });
// The sheet.
await page.click('#ngc-fc');
await page.waitForSelector('#fc-sheet .fc-game', { timeout: 20000 });
await page.waitForTimeout(500);
const sheet = await page.textContent('#fc-sheet');
check(`the forecast sheet shows the same game forecast (${direct.f.tempF}°, ${direct.f.label}, ${direct.f.chance}%)`,
      sheet.includes(`${direct.f.tempF}°`) && sheet.includes(direct.f.label) && sheet.includes(`${direct.f.chance}% chance`));
check(`…hour by hour through the game (${direct.f.hours.length} hours), the first at first pitch with the headline's temperature`,
      (await page.$$('#fc-sheet .fc-hour')).length === direct.f.hours.length && direct.f.hours[0]?.tempF === direct.f.tempF);
// 3b: the 10-day outlook — every day filled in, the engine's numbers, our game under its day with the same line.
const t1 = Date.now();
await page.waitForFunction(() => document.querySelectorAll('#fc-sheet .fc-d-main').length === 10, null, { timeout: 60000 });
const outlookMs = Date.now() - t1;
const shown = await page.$$eval('#fc-sheet .fc-day', rows => rows.map(r => ({ label: r.querySelector('.fc-d-label')?.textContent, temp: r.querySelector('.fc-d-temp')?.textContent.replace(/\s+/g, ''), pct: r.querySelector('.fc-d-pct')?.textContent })));
const eng = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { weatherContext } = await import('/baseball-gm/engine/WeatherClimate.js');
  const { dailyForecast, withinDay } = await import('/baseball-gm/engine/WeatherForecast.js');
  const { forecastForGame } = await import('/baseball-gm/engine/GameWeather.js');
  const { venueOf } = await import('/baseball-gm/ui/components/RadarSheet.js');
  const s = SM.get(), g = s.schedule[s.currentGameIndex], ctx = weatherContext(s), v = venueOf(g), p = ctx.map.parks[v], now = Date.now();
  // A day shown beside our games there can't be less likely to rain than any of them.
  return dailyForecast(ctx, now, p.x, p.y, 10).map(d0 => {
    const games = s.schedule.filter(x => !x._committed && x.gameTime > now && x.date === d0.dateIso && venueOf(x) === v).map(x => forecastForGame(ctx, now, x));
    const d = withinDay(d0, games);
    const bad = games.some(f => f.chance > d.chance || f.hours.some(h => h.chance > f.chance));
    return { label: d.label, temp: `${d.hiF ?? '—'}°/${d.loF ?? '—'}°`, pct: d.chance >= 10 ? `${d.chance}%` : '', bad };
  });
});
await page.waitForTimeout(1500);   // (a day beside our games settles once their forecasts are in)
const shown2 = await page.$$eval('#fc-sheet .fc-day', rows => rows.map(r => ({ label: r.querySelector('.fc-d-label')?.textContent, temp: r.querySelector('.fc-d-temp')?.textContent.replace(/\s+/g, ''), pct: r.querySelector('.fc-d-pct')?.textContent })));
const off = shown2.map((d, i) => JSON.stringify(d) === JSON.stringify({ label: eng[i].label, temp: eng[i].temp, pct: eng[i].pct }) ? null : `day ${i}: ${JSON.stringify(d)} vs ${JSON.stringify(eng[i])}`).filter(Boolean);
check('no day is less likely to rain than a game in it, no game less likely than an hour of it', eng.every(d => !d.bad));
check(`the 10-day outlook fills in (${outlookMs} ms) with the engine's numbers, day for day`, off.length === 0, off.slice(0, 2).join(' | '));
await page.waitForFunction(() => [...document.querySelectorAll('#fc-sheet .fc-d-gfc')].every(e => e.textContent !== '…'), null, { timeout: 30000 });
const gameRow = await page.$eval('#fc-sheet .fc-d-gfc', e => e.textContent).catch(() => null);
check(`our game is under its day with the dashboard's line (“${gameRow}”)`, gameRow === `· ${line}`);
await page.$eval('#fc-sheet .fc-day-list', el => el.scrollIntoView());
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/fc-sheet-${theme}.png` });
// Our park and the game's, when they differ.
if (await page.$('#fc-sheet .fc-park:not(.on)')) {
  const other = await page.$eval('#fc-sheet .fc-park:not(.on)', b => b.textContent);
  await page.click('#fc-sheet .fc-park:not(.on)');
  await page.waitForFunction(() => document.querySelectorAll('#fc-sheet .fc-d-main').length === 10, null, { timeout: 60000 });
  check(`switching to ${other} shows that park's outlook`, (await page.textContent('#fc-city')).length > 0 && !!(await page.$('#fc-sheet .fc-park.on')));
}
// 3c: the schedule — upcoming games within ten days, each with the engine's line for that game.
await page.click('#fc-close');
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('schedule'); });
await page.waitForSelector('#schedule-content .game-fc', { timeout: 20000 });
const t2 = Date.now();
await page.waitForFunction(() => [...document.querySelectorAll('#schedule-content .game-fc')].every(b => b.textContent !== 'Forecast…'), null, { timeout: 60000 });
const schedMs = Date.now() - t2;
const rows = await page.$$eval('#schedule-content .game-fc', bs => bs.map(b => ({ idx: +b.dataset.fcIdx, text: b.textContent })));
const want = await page.evaluate(async (idxs) => {
  const SM = await import('/baseball-gm/store/StateManager.js');
  const { weatherContext } = await import('/baseball-gm/engine/WeatherClimate.js');
  const { forecastForGame } = await import('/baseball-gm/engine/GameWeather.js');
  const { forecastLine } = await import('/baseball-gm/ui/components/ForecastSheet.js');
  const s = SM.get(), ctx = weatherContext(s), now = Date.now();
  const within = s.schedule.filter(g => !g._committed && g.gameTime > now && g.gameTime - now <= 10 * 86_400_000).length;
  return { lines: idxs.map(i => forecastLine(forecastForGame(ctx, now, s.schedule[i]))), within };
}, rows.map(r => r.idx));
const bad = rows.filter((r, k) => r.text !== want.lines[k]).map(r => `#${r.idx} “${r.text}”`);
check(`the schedule shows each upcoming game's forecast (${rows.length} games within ten days in the open month, of ${want.within}; ${schedMs} ms), the engine's line for each`,
      rows.length >= 1 && bad.length === 0, bad.join(' | '));
check('the next game reads the same on the schedule as on the dashboard', rows[0]?.text === line);
await page.screenshot({ path: `${out}/fc-schedule-${theme}.png` });
await page.click('#schedule-content .game-fc');
await page.waitForSelector('#fc-sheet .fc-game .fc-g-temp', { timeout: 20000 });
check('tapping it opens that game\'s forecast', (await page.textContent('#fc-sheet .fc-g-temp')) === `${direct.f.tempF}°`);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
