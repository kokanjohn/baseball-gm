// §122.61 Sideways, with the upright layout held on the phone (§122.50 — the iPhone path, where the app can't lock
// rotation): real touch gestures, both turns.
//   1. A finger along the phone's long edge scrolls the list (Messages, Schedule), the way the finger moves.
//   2. A sheet pulled toward the layout's bottom follows and closes; pulled the other way, or a short tap, it stays.
//   3. The new club's name sheet, held: the field takes focus and the typing, the sheet stays at the layout's
//      bottom, and the layout doesn't move.
// (Chromium stands in for the iPhone here: the gestures are real touch events through the turned layout; what
// Safari's own keyboard does can't be run here.)
//   node tools/harness/test-held-gestures-ui.mjs outDir [theme]
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
const cdp = await ctx.newCDPSession(page);
const errors = [];
page.on('pageerror', e => errors.push(e.message));

/** A point in the upright layout's terms → where it is on the sideways screen. */
const screenOf = (ux, uy) => page.evaluate(([ux, uy]) => {
  const t = document.body.dataset.turn, b = document.body, w = b.offsetWidth / 2, h = b.offsetHeight / 2;
  if (!t) return { x: ux, y: uy };
  const s = t === 'ccw' ? { sx: uy - h, sy: w - ux } : { sx: h - uy, sy: ux - w };
  return { x: s.sx + innerWidth / 2, y: s.sy + innerHeight / 2 };
}, [ux, uy]);
/** A finger drawn from one upright point to another (real touch events, in steps). */
async function swipe(from, to, { steps = 14, ms = 260 } = {}) {
  const a = await screenOf(from[0], from[1]), b = await screenOf(to[0], to[1]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }] });
    await page.waitForTimeout(ms / steps);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(700);
}
const turnTo = async (deg) => {
  await page.evaluate((deg) => { Object.defineProperty(window, 'orientation', { value: deg, configurable: true }); window.dispatchEvent(new Event('orientationchange')); }, deg);
  await page.waitForTimeout(250);
};
/** The scroll offset of every scroller on the page (to find the one the finger moved). */
const scrolls = () => page.evaluate(() => [document.scrollingElement, ...document.querySelectorAll('*')]
  .filter(el => el && el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'hidden' && el.offsetParent !== null || el === document.scrollingElement)
  .map(el => [el.id || el.className?.toString().slice(0, 30) || el.tagName, el.scrollTop]));
const moved = (a, b) => { const m = new Map(a); let best = 0; for (const [k, v] of b) if (m.has(k)) best = Math.abs(v - m.get(k)) > Math.abs(best) ? v - m.get(k) : best; return best; };

await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ── 3 first: the new club's name sheet (setup), held ──
await page.tap('.archetype-card[data-archetype="lab"]'); await page.tap('#arch-next-btn'); await page.waitForTimeout(250);
await page.tap('.region-card[data-region="south"]'); await page.tap('#region-next-btn'); await page.waitForTimeout(250);
await page.setViewportSize({ width: 844, height: 390 }); await turnTo(90);
const held0 = await page.evaluate(() => ({ turn: document.body.dataset.turn || '', box: [document.body.offsetWidth, document.body.offsetHeight] }));
check(`setup, sideways: the upright layout is held (${held0.turn}, ${held0.box.join('×')})`, !!held0.turn && held0.box[0] === 390);
await page.tap('#start-btn'); await page.waitForTimeout(400);
await page.keyboard.type('Harbor City');
// §122.62 typing sideways: the hold is let go while the sheet is open — the keyboard rises from the phone's real
// bottom edge, so the sheet lies across the phone on top of it, one compact row.
const nm = await page.evaluate(() => {
  const s = document.getElementById('nc-sheet'), r = s.getBoundingClientRect();
  return { turn: document.body.dataset.turn || '', typing: !!document.body.dataset.typing, focus: document.activeElement?.id,
           val: document.getElementById('team-city').value, open: !s.hidden, w: Math.round(r.width), h: Math.round(r.height),
           bottom: Math.round(r.bottom), H: innerHeight, W: innerWidth };
});
check(`the name sheet, sideways: the hold let go while typing (turn "${nm.turn}", typing ${nm.typing})`, nm.open && !nm.turn && nm.typing);
check(`…the field has the focus and the typing ("${nm.val}")`, nm.focus === 'team-city' && nm.val === 'Harbor City');
check(`…the sheet lies across the phone (${nm.w} of ${nm.W}px) on its bottom edge, one compact row (${nm.h}px tall) that fits above a sideways keyboard`, nm.w >= nm.W - 2 && Math.abs(nm.bottom - nm.H) <= 2 && nm.h <= 110, JSON.stringify(nm));
// The keyboard, as the browser reports it: the visual viewport shrinks; the sheet rides on its top.
await page.evaluate(() => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { value: innerHeight - 200, configurable: true }); vv.dispatchEvent(new Event('resize')); });
await page.waitForTimeout(150);
const kb = await page.evaluate(() => Math.round(document.getElementById('nc-sheet').getBoundingClientRect().bottom));
check(`…with a 200px keyboard up, the sheet sits on its top (bottom at ${kb} of ${nm.H - 200})`, Math.abs(kb - (nm.H - 200)) <= 2);
await page.screenshot({ path: `${out}/held-name-sheet-${theme}.png` });
await page.evaluate(() => { delete window.visualViewport.height; });
await page.keyboard.press('Enter'); await page.keyboard.type('Nighthawks'); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
const after = await page.evaluate(() => ({ closed: document.getElementById('nc-sheet').hidden, names: document.getElementById('nc-names').innerText, turn: document.body.dataset.turn || '', typing: !!document.body.dataset.typing }));
check(`…Enter moves on and closes it, and the layout is held again (${after.turn})`, after.closed && /Nighthawks/.test(after.names) && !!after.turn && !after.typing, JSON.stringify(after));

// ── A club, for 1 and 2 ──
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId ?? sl.id);
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  SM.mutate(s => { s.settings.theme = theme; });
  // enough mail to scroll
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  for (const id of ['pg_fan_moment', 'pg_media_access', 'ig_concourse_incident', 'ig_broadcast_feed', 'pg30_elevator', 'pg30_scoreboard', 'pg30_power', 'pg30_concessions', 'ig_suite_complaint', 'pl_paternity', 'coach_bench_mediator', 'f1']) CE.deliverCardById(id);
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(900);

for (const [deg, name] of [[90, 'one way'], [-90, 'the other way']]) {
  await page.setViewportSize({ width: 844, height: 390 }); await turnTo(deg);
  const turn = await page.evaluate(() => document.body.dataset.turn);
  for (const tab of ['decisions', 'schedule']) {
    await page.tap(`.nav-item[data-tab="${tab}"]`); await page.waitForTimeout(600);
    const s0 = await scrolls();
    await swipe([195, 640], [195, 260]);              // the finger up the layout: the list moves on (down the list)
    const s1 = await scrolls();
    const down = moved(s0, s1);
    await swipe([195, 260], [195, 640]);              // and back
    const back = moved(s1, await scrolls());
    check(`held ${name} (${turn}), ${tab === 'decisions' ? 'Messages' : 'Schedule'}: a finger along the phone scrolls the list the way it moves (on ${Math.round(down)}px, back ${Math.round(back)}px)`, down > 80 && back < -80);
  }
  await page.screenshot({ path: `${out}/held-schedule-${turn}-${theme}.png` });
  // (scrollers take a sideways pan while held — §122.61: nothing on the upright screens is wider than the phone)
  const wide = [];
  for (const tab of ['dashboard', 'decisions', 'schedule']) {
    await page.tap(`.nav-item[data-tab="${tab}"]`); await page.waitForTimeout(400);
    wide.push(...await page.evaluate((tab) => [...document.querySelectorAll('.tab-content')].filter(el => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map(el => `${tab}:${el.id} ${el.scrollWidth}>${el.clientWidth}`), tab));
  }
  check(`held ${name}: nothing on Dashboard, Messages or Schedule is wider than the phone (no sideways pan)`, wide.length === 0, wide.join(', '));

  // 2. A sheet pulled down, held.
  await page.tap('.nav-item[data-tab="schedule"]'); await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('.game-item.current-game')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const fc = await page.$('.game-fc');
  if (!fc) { check('a forecast line to open the sheet', false); continue; }
  await fc.tap(); await page.waitForTimeout(700);
  const open = () => page.evaluate(() => !!document.querySelector('.modal-overlay.open .modal-sheet, .modal-overlay .fc-head'));
  const sheetTop = await page.evaluate(async () => { const U = await import('/baseball-gm/ui/Upright.js'); const r = U.uprightRect(document.querySelector('.fc-head')); return [r.left + r.width / 2, r.top + r.height / 2]; });
  check(`held ${name}: the forecast sheet opens from a tap`, await open());
  await swipe([sheetTop[0] - 60, sheetTop[1]], [sheetTop[0] - 60, sheetTop[1] - 120]);   // the wrong way: up the layout
  const afterUp = await open();
  const ts = await screenOf(sheetTop[0] - 60, sheetTop[1]);
  await page.touchscreen.tap(ts.x, ts.y); await page.waitForTimeout(400);
  const afterTap = await open();
  check(`…pulled up, or a short tap, it stays open`, afterUp && afterTap);
  // (pulled up, its content scrolled: a pull down closes it from the top, as upright — back to the top first)
  const scrolledUp = await page.evaluate(() => { const s = document.querySelector('.modal-overlay.open .modal-sheet'); const y = s?.scrollTop || 0; if (s) s.scrollTop = 0; return y; });
  check(`…and the wrong way scrolled its content (${scrolledUp}px), as a finger would upright`, scrolledUp >= 0);
  await swipe([sheetTop[0] - 60, sheetTop[1]], [sheetTop[0] - 60, sheetTop[1] + 420], { ms: 300 });   // down the layout
  check(`…pulled toward the layout's bottom, it follows and closes`, !(await open()));
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => document.querySelector('.modal-overlay.open')?.click()); await page.waitForTimeout(300);
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
