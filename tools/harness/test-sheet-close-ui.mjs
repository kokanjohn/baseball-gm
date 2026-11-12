// r155 Every sheet has the same × close button: one you can see, that nothing covers or crowds, and
// a tap on it closes the sheet. (Swipe-down closing is tested in test-swipe-close-ui.mjs.)
//   node tools/harness/test-sheet-close-ui.mjs outDir [theme]
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
// The first spring game, played out, so the Schedule has a finished game to open.
now = first.gameTime + 15 * 3600_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  GE.tick(); CE.releaseDueCards();
  const g = SM.get().schedule[0];
  if (g && !g._committed && g.status === 'final') await GE.commitGame(0);
});
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);

/** The open sheet's ×: on screen, on top (nothing covers it), clear of every bit of text, a finger's size. */
const closeInfo = (overlaySel) => page.evaluate((overlaySel) => {
  const ov = overlaySel ? document.querySelector(overlaySel) : [...document.querySelectorAll('.modal-overlay.open')].pop();
  if (!ov) return { err: 'no overlay' };
  const xs = [...ov.querySelectorAll('.modal-close, .history-close')].filter(b => b.offsetParent !== null && b.getBoundingClientRect().width > 0);
  if (xs.length !== 1) return { err: `${xs.length} visible ×` };
  const b = xs[0], r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const crowded = [];
  for (const el of ov.querySelectorAll('*')) {
    if (el === b || b.contains(el) || el.offsetParent === null) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const range = document.createRange(); range.selectNodeContents(el);
    for (const t of range.getClientRects()) {
      if (t.width && t.right > r.left && t.left < r.right && t.bottom > r.top && t.top < r.bottom) { crowded.push(el.textContent.trim().slice(0, 30)); break; }
    }
  }
  // The same corner on every sheet: its top right, near the handle.
  const sh = b.closest('.modal-sheet, .history-sheet, .ts-confirm-sheet')?.getBoundingClientRect();
  const corner = sh ? { top: Math.round(r.top - sh.top), right: Math.round(sh.right - r.right) } : null;
  return { x: cx, y: cy, w: r.width, h: r.height, text: b.textContent.trim(), onTop: hit === b || b.contains(hit),
           onScreen: !!corner && r.top >= 0 && r.right <= innerWidth && corner.top <= 64 && corner.right <= 28, corner, crowded };
}, overlaySel);
const isOpen = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); return !!el && el.classList.contains('open') && getComputedStyle(el).display !== 'none'; }, sel);

/** Open a sheet, check its ×, tap it, check it closed. */
async function sheet(name, open, overlaySel, shot = null) {
  await open();
  await page.waitForTimeout(700);
  const ovSel = overlaySel || await page.evaluate(() => { const ov = [...document.querySelectorAll('.modal-overlay.open')].pop(); return ov?.id ? `#${ov.id}` : null; });
  if (!ovSel || !(await isOpen(ovSel))) { check(`${name}: opens`, false, String(ovSel)); return; }
  if (shot) await page.screenshot({ path: `${out}/${shot}-${theme}.png` });
  const c = await closeInfo(ovSel);
  check(`${name}: one × in the corner, on top, clear of the text`, !c.err && c.text === '×' && c.onTop && c.onScreen && c.crowded.length === 0 && c.w >= 28 && c.h >= 28, JSON.stringify(c));
  if (c.err) return;
  // Scrolled to the bottom of a long sheet, the × is still right there.
  const long = await page.evaluate((sel) => { let n = 0; for (const el of document.querySelectorAll(`${sel} *`)) if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { el.scrollTop = el.scrollHeight; n++; } return n; }, ovSel);
  if (long) {
    await page.waitForTimeout(150);
    const d = await closeInfo(ovSel);
    check(`${name}: scrolled to the bottom, the × stays in its corner`, !d.err && d.onTop && d.onScreen && Math.abs(d.y - c.y) < 2, JSON.stringify(d));
  }
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(500);
  check(`${name}: a tap on the × closes it`, !(await isOpen(ovSel)));
}
const imp = (path, fn, arg) => () => page.evaluate(async ([path, fn, arg]) => {
  const M = await import(path); const SM = await import('/baseball-gm/store/StateManager.js');
  M[fn](...(arg === 'state' ? [SM.get()] : arg === 'stateObj' ? [{ state: SM.get() }] : arg ?? []));
}, [path, fn, arg]);
const S = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
  const date = s.schedule[1]?.date || s.schedule[0].date;
  const lg = (s.leagueSchedule?.dayMap?.[date] || [])[0];
  return { pid: s.userTeam.rosterIds[0], fa: (s.freeAgentPool || [])[0], lgDate: date, lgId: lg?.id };
});

await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('schedule'); });
await page.waitForTimeout(500);
await sheet("Schedule: the game's stats", () => page.evaluate(() => document.querySelector('[data-game-idx="0"]')?.click()), '#sched-result-sheet', 'sheet-x-stats');
await sheet('Schedule: scores', () => page.evaluate(() => document.getElementById('sched-scores-btn')?.click()), '#sched-scores-overlay');
await sheet('Player card', () => page.evaluate(async (id) => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); const SM = await import('/baseball-gm/store/StateManager.js'); PC.openPlayerCard(id, SM.get()); }, S.pid), '#player-card-overlay');
await sheet('Team rating history', imp('/baseball-gm/ui/components/RatingHistory.js', 'openRatingHistory', 'state'));
await sheet('Forecast', imp('/baseball-gm/ui/components/ForecastSheet.js', 'openForecastSheet', 'stateObj'));
if (S.fa) await sheet('Sign a free agent', imp('/baseball-gm/ui/components/SignSheet.js', 'openSignSheet', [S.fa, 'sign']), '#sign-sheet-overlay', 'sheet-x-sign');
await sheet('Trade composer', imp('/baseball-gm/ui/components/TradeComposer.js', 'openTradeComposer', [{}]));
if (S.lgId) await sheet('Another game, live', imp('/baseball-gm/ui/components/LiveGame.js', 'openLeagueGame', [S.lgDate, S.lgId]));
await sheet('Settings', () => page.evaluate(() => document.getElementById('settings-btn')?.click()), '#settings-modal');
await sheet('Settings: league team names', () => page.evaluate(async () => {
  document.getElementById('settings-btn')?.click(); await new Promise(r => setTimeout(r, 300));
  document.getElementById('settings-league-teams-btn')?.click();
}), '#settings-modal', 'sheet-x-team-names');
await sheet('Franchise story', imp('/baseball-gm/ui/screens/HistoryScreen.js', 'openHistory'), '#history-overlay');
// The team picker's delete confirm (Settings → New / Switch Team → Delete).
await page.evaluate(async () => { document.getElementById('settings-reset-row')?.click(); });
await page.waitForTimeout(1200);
await sheet('Team picker: delete a team', () => page.evaluate(() => document.querySelector('.ts-delete-btn')?.click()), '#ts-confirm-overlay', 'sheet-x-delete');
check('…and closing it deletes nothing', await page.evaluate(() => document.querySelectorAll('.ts-delete-btn').length > 0));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
