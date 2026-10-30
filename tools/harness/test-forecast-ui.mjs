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
await page.screenshot({ path: `${out}/fc-sheet-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
