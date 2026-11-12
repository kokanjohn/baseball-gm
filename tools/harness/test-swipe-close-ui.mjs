// r154 Every bottom sheet closes with a swipe down (ui/components/SwipeClose.js), in the real app on a
// touch screen — and the first spring game's starter goes two innings, not eight.
//   node tools/harness/test-swipe-close-ui.mjs outDir [theme]
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
const cdp = await ctx.newCDPSession(page);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const first = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  return { gameTime: SM.get().schedule[0].gameTime };
}, theme);
// The first spring game, played out (the app closed through it).
now = first.gameTime + 15 * 3600_000;
await page.clock.setFixedTime(now);
const g0 = await page.evaluate(async () => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  GE.tick(); CE.releaseDueCards();
  const g = SM.get().schedule[0];
  if (g && !g._committed && g.status === 'final') await GE.commitGame(0);
  const box = SM.get().schedule[0].boxScore;
  const sp = (side) => box?.[side]?.pitchers?.[0];
  return { committed: !!SM.get().schedule[0]._committed, spring: !!g.isSpring,
           starters: ['away', 'home'].map(s => ({ name: sp(s)?.name, outs: sp(s)?.ipOuts })) };
});
check('the first spring game is played and on the schedule', g0.committed && g0.spring, JSON.stringify(g0));
check(`first spring game: each starter goes two innings, no more (${g0.starters.map(s => `${s.name} ${Math.floor((s.outs || 0) / 3)}.${(s.outs || 0) % 3}`).join(', ')})`,
      g0.starters.every(s => s.outs > 0 && s.outs <= 6), JSON.stringify(g0.starters));
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);

/** A finger on the screen: down at (x, y), moved `dy` down (and `dx` across) in steps, lifted. */
async function swipe(x, y, dy, { dx = 0, steps = 10, ms = 16 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] });
    await page.waitForTimeout(ms);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
}
const top = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + 30, h: r.height } : null; }, sel);
const isOpen = (sel) => page.evaluate((sel) => !!document.querySelector(sel)?.classList.contains('open'), sel);

// ── The game's stats sheet (Schedule → the finished game) ──
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('schedule'); });
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelector('[data-game-idx="0"]')?.click());
await page.waitForTimeout(600);
check('tapping the finished game opens its stats sheet', await isOpen('#sched-result-sheet'));
await page.screenshot({ path: `${out}/swipe-stats-sheet-${theme}.png` });
let t = await top('#sched-result-sheet .modal-sheet');
await swipe(t.x, t.y, 40);
check('a short pull springs back: still open, back in place', await isOpen('#sched-result-sheet')
      && await page.evaluate(() => getComputedStyle(document.querySelector('#sched-result-sheet .modal-sheet')).transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(getComputedStyle(document.querySelector('#sched-result-sheet .modal-sheet')).transform)));
// Sideways across the box score's line: never a close.
const tbl = await page.evaluate(() => { const r = document.querySelector('#sched-result-sheet .modal-sheet table, #sched-result-sheet .modal-sheet [class*="bs"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + 20 } : null; });
if (tbl) { await swipe(tbl.x + 60, tbl.y, 30, { dx: -160 }); check('a sideways drag on the box score leaves the sheet open', await isOpen('#sched-result-sheet')); }
// Scrolled down: a downward drag scrolls the box score back up, it doesn't close the sheet.
const scrolled = await page.evaluate(() => { const sc = [...document.querySelectorAll('#sched-result-sheet .modal-sheet *')].find(el => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY === 'auto');
  if (!sc) return null; sc.scrollTop = 200; const r = sc.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 80, st: sc.scrollTop }; });
if (scrolled?.st > 0) { await swipe(scrolled.x, scrolled.y, 220); check('scrolled down, a pull scrolls the stats instead of closing', await isOpen('#sched-result-sheet')); }
await page.evaluate(() => { const sc = [...document.querySelectorAll('#sched-result-sheet .modal-sheet *')].find(el => el.scrollTop > 0); if (sc) sc.scrollTop = 0; });
t = await top('#sched-result-sheet .modal-sheet');
await swipe(t.x, t.y, 320);
check('a swipe down closes the stats sheet', !(await page.$('#sched-result-sheet')));
// A quick flick closes it too.
await page.evaluate(() => document.querySelector('[data-game-idx="0"]')?.click());
await page.waitForTimeout(600);
t = await top('#sched-result-sheet .modal-sheet');
await swipe(t.x, t.y, 120, { steps: 3, ms: 0 });
check('a quick flick closes it too', !(await page.$('#sched-result-sheet')));
await page.evaluate(() => document.getElementById('sched-result-sheet')?.remove());   // (one left open would cover the rest)

// ── The player card (kept in the page, hidden: it must open fresh again) ──
const pid = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); return SM.get().userTeam.rosterIds[0]; });
const openCard = () => page.evaluate(async (id) => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); const SM = await import('/baseball-gm/store/StateManager.js'); PC.openPlayerCard(id, SM.get()); }, pid);
await openCard(); await page.waitForTimeout(600);
t = await top('#player-card-sheet');
await swipe(t.x, t.y, 300);
check('a swipe down closes the player card', !(await isOpen('#player-card-overlay')));
await openCard(); await page.waitForTimeout(600);
const fresh = await page.evaluate(() => { const r = document.querySelector('#player-card-sheet').getBoundingClientRect(); return { top: r.top, inline: document.querySelector('#player-card-sheet').style.transform }; });
check('…and opens again in place', (await isOpen('#player-card-overlay')) && fresh.inline === '' && fresh.top < 400, JSON.stringify(fresh));
await page.evaluate(async () => { (await import('/baseball-gm/ui/components/PlayerCard.js')).closePlayerCard(); });
await page.waitForTimeout(300);

// ── Settings, and the franchise story ──
await page.evaluate(() => document.getElementById('settings-btn')?.click());
await page.waitForTimeout(600);
t = await top('#settings-modal .modal-sheet');
await swipe(t.x, t.y, 320);
check('a swipe down closes Settings', !(await isOpen('#settings-modal')));
await page.evaluate(async () => (await import('/baseball-gm/ui/screens/HistoryScreen.js')).openHistory());
await page.waitForTimeout(600);
t = await top('.history-sheet');
await swipe(t.x, t.y, 320);
check('a swipe down closes the Franchise Story', !(await isOpen('#history-overlay')));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
