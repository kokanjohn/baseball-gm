// §100 (2d) The radar on the dashboard, in the real app: a new team; the next-game card's radar;
// it survives a redraw; tapping opens the full radar on the game's ballpark, its loop ready from the shared frames.
//   node tools/harness/test-dashboard-radar.mjs outDir [theme]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForSelector('#dash-radar-slot .radar-card', { timeout: 20000 });
const t0 = Date.now();
await page.waitForFunction(() => document.querySelector('.radar-card .rc-time')?.textContent, null, { timeout: 30000 });
await page.waitForTimeout(4000);   // let the loop load
const focus = await page.getAttribute('#dash-radar-slot', 'data-focus');
const game = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get(); const g = s.schedule[s.currentGameIndex || 0]; return { isHome: g.isHome, opp: g.opponentId }; });
check(`the next-game card has a radar on the game's ballpark (${focus}; ${game.isHome ? 'home' : '@ ' + game.opp})`, focus === (game.isHome ? 'user' : game.opp));
const place = await page.textContent('.radar-card .rc-place');
check(`it names the place (${place}) and shows a time (${await page.textContent('.radar-card .rc-time')})`, !!place);
// A redraw keeps the same radar.
await page.evaluate(() => { window.__card = document.querySelector('.radar-card'); });
await page.evaluate(async () => { const EB = await import('/baseball-gm/ui/EventBus.js'); EB.emit('roster:changed'); });
await page.waitForTimeout(300);
check('a dashboard redraw keeps the same radar (no restart)', await page.evaluate(() => document.querySelector('.radar-card') === window.__card && document.getElementById('dash-radar-slot').contains(window.__card)));
await page.$eval('.radar-card', el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/dash-radar-${theme}.png` });
// Tap: the full radar, centred on the same park, its past loop ready at once (shared frames).
await page.click('.radar-card');
await page.waitForSelector('#radar-sheet.open', { timeout: 5000 });
const sheetFocus = await page.$eval('.rs-park', el => el.value);
check(`tapping opens the full radar on the same park (${sheetFocus})`, sheetFocus === focus);
const t1 = Date.now();
await page.waitForFunction(() => !document.querySelector('.rs-status')?.textContent, null, { timeout: 30000 });
const ms = Date.now() - t1;
check(`its Past 2 hrs loop is ready at once from the card's frames (${ms} ms)`, ms < 1200);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/dash-sheet-${theme}.png` });
await page.click('.rs-done');
await page.waitForTimeout(500);
check('Done closes it', (await page.$('#radar-sheet')) === null);
check('no page errors', errors.length === 0, errors.join(' | '));
// The idle dashboard still doesn't scroll, at any phone height: the radar takes the room there is.
for (const h of [932, 844, 760, 700, 640]) {
  const c2 = await browser.newContext({ viewport: { width: 390, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const p2 = await c2.newPage();
  await p2.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
  await p2.waitForTimeout(500);
  await p2.evaluate(async () => {
    const GE = await import('/baseball-gm/engine/GameEngine.js');
    await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
    const App = await import('/baseball-gm/ui/App.js'); await App.init();
  });
  await p2.waitForSelector('#dash-radar-slot .radar-card', { state: 'attached', timeout: 20000 });
  await p2.waitForTimeout(600);
  const r = await p2.evaluate(() => {
    const t = document.getElementById('tab-dashboard'), card = document.querySelector('.radar-card');
    const btn = document.querySelector('.ngc-radar');
    // The same dashboard without the radar: what it would scroll anyway.
    const slot = document.getElementById('dash-radar-slot'), bh = btn.hidden;
    const over = t.scrollHeight - t.clientHeight;
    slot.style.display = 'none'; btn.hidden = true;
    const base = t.scrollHeight - t.clientHeight;
    slot.style.display = ''; btn.hidden = bh;
    return { over, base, idle: t.classList.contains('dash-idle'), folded: card.style.display === 'none', button: btn && !btn.hidden, map: Math.round(card.querySelector('.rc-map').getBoundingClientRect().height) };
  });
  check(`${h}px tall: the radar adds no scrolling to the idle dashboard (overflow ${r.over}px, ${r.base}px without it; ${r.folded ? 'a Radar button on the next-game card' : `radar map ${r.map}px`})`,
        r.idle && r.over <= Math.max(1, r.base) && r.folded === r.button);
  if (r.folded) {
    await p2.click('.ngc-radar');
    await p2.waitForSelector('#radar-sheet.open', { timeout: 5000 });
    check(`${h}px tall: the Radar button opens the full radar`, true);
    await p2.click('.rs-done'); await p2.waitForTimeout(300);
  }
  if (h === 640 || h === 760) await p2.screenshot({ path: `${out}/dash-${h}-${theme}.png` });
  await c2.close();
}
await browser.close();
process.exit(ok ? 0 : 1);
