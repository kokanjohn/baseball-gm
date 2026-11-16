// r175–r177 Sideways: with the phone on its side, Team and League spread to the full width and the
// header and nav slim down; every other screen keeps its upright layout, held in place on the
// phone as if locked (r177). League → Players shows OPS (r177). Upright, the Team
// screen's name column is narrower (the wear bar sits right after the name), and the card's
// Wear note states the status only (no age line).
//   node tools/harness/test-landscape-ui.mjs outDir [theme]
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
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, theme);
await page.waitForTimeout(800);

// ── Upright: Team ──
await page.tap('.nav-item[data-tab="roster"]'); await page.waitForTimeout(600);
const up = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.tr-row[data-player]')];
  const gaps = rows.map(r => {
    const line = r.querySelector('.tr-name-line'), bar = r.querySelector('.tr-wearc');
    const rg = document.createRange(); rg.selectNodeContents(line);
    return Math.round(bar.getBoundingClientRect().left - Math.min(rg.getBoundingClientRect().right, line.getBoundingClientRect().right));
  });
  const cut = rows.filter(r => { const l = r.querySelector('.tr-name-line'); return l.scrollWidth > l.clientWidth + 1; }).length;
  return { fz: document.querySelector('.tr-row .tr-fz').getBoundingClientRect().width, nm: document.querySelector('.tr-row .tr-name').getBoundingClientRect().width, gaps, cut, rows: rows.length,
           body: document.body.getBoundingClientRect().width };
});
const minGap = Math.min(...up.gaps);   // after the longest name
check(`upright: the name column is ${up.nm}px (was 98), the frozen part ${up.fz}px (was 262); after the longest name the wear bar is ${minGap}px away`, up.nm <= 78 && up.fz <= 242);
check(`upright: ${up.cut} of ${up.rows} names cut short`, up.cut <= Math.ceil(up.rows * 0.25));
await page.screenshot({ path: `${out}/landscape-team-upright-${theme}.png` });

// ── Card: Wear note without the age line ──
await page.tap('.tr-row[data-player] .tr-name'); await page.waitForTimeout(600);
const note = await page.evaluate(() => {
  const lab = [...document.querySelectorAll('.pc-section-label')].find(l => l.textContent.trim() === 'Wear');
  return lab?.parentElement.querySelector('.pc-ask-note')?.textContent.trim() || '';
});
check(`card Wear note states the status only: "${note}"`, note.length > 0 && !/\bAt \d+/.test(note) && !/builds (slower|faster)/.test(note));
await page.evaluate(() => document.querySelector('.modal-overlay.open')?.click());
await page.keyboard.press('Escape').catch(() => {});
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('dashboard'); });
await page.waitForTimeout(300);

// ── Sideways ──
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(400);
// The upright layout held on a sideways phone: body[data-turn], the body the phone's upright
// size (390 × 844) turned a quarter, so on screen the header runs down one side.
const chrome = () => page.evaluate(() => {
  const b = document.body, r = b.getBoundingClientRect(), h = document.querySelector('.app-header').getBoundingClientRect();
  return { turn: b.dataset.turn || '', wide: !!b.dataset.wide, w: Math.round(r.width), h: Math.round(r.height),
           box: [b.offsetWidth, b.offsetHeight], headW: Math.round(h.width), headH: Math.round(h.height),
           tab: document.querySelector('.nav-item.active')?.dataset.tab };
});
const held = (c) => c.turn && c.box[0] === 390 && c.box[1] === 844 && c.w === 844 && c.h === 390 && c.headW < 90 && c.headH >= 380;
const dash = await chrome();
check(`sideways, Dashboard: held upright on the phone (turn ${dash.turn}, body ${dash.box.join('×')} turned to fill ${dash.w}×${dash.h}, header down the side ${dash.headW}×${dash.headH})`, held(dash), JSON.stringify(dash));
await page.screenshot({ path: `${out}/landscape-dashboard-${theme}.png` });
// Gestures read points in upright terms: a turned element's screen box maps back to its upright box.
for (const turn of ['ccw', 'cw']) {
  const m = await page.evaluate(async (turn) => {
    const U = await import('/baseball-gm/ui/Upright.js');
    document.body.dataset.turn = turn;
    const el = document.querySelector('.bottom-nav .nav-item:nth-child(2)');
    const r = U.uprightRect(el);
    // the element's upright box from the layout itself (offset chain inside the body)
    let x = 0, y = 0, n = el; while (n && n !== document.body) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { got: [r.left, r.top, r.width, r.height].map(Math.round), want: [x, y, el.offsetWidth, el.offsetHeight] };
  }, turn);
  check(`upright terms (${turn}): the nav's 2nd item ${m.got.join(',')} = ${m.want.join(',')}`, m.got.every((v, i) => Math.abs(v - m.want[i]) <= 1));
}
await page.evaluate(() => { document.body.dataset.turn = 'ccw'; });
// A tap on the turned nav lands where it shows.
await page.tap('.nav-item[data-tab="decisions"]'); await page.waitForTimeout(400);
let c = await chrome();
check(`sideways, a tap on Messages in the turned nav opens it, still held (${c.tab})`, c.tab === 'decisions' && held(c), JSON.stringify(c));
await page.tap('.nav-item[data-tab="schedule"]'); await page.waitForTimeout(400);
c = await chrome();
check(`sideways, Schedule: held (${c.tab})`, c.tab === 'schedule' && held(c), JSON.stringify(c));
// The phone turned the other way: the layout turns the other way.
await page.evaluate(() => { Object.defineProperty(window, 'orientation', { value: -90, configurable: true }); window.dispatchEvent(new Event('orientationchange')); });
await page.waitForTimeout(200);
c = await chrome();
check(`sideways the other way: turn ${c.turn}`, c.turn === 'cw' && held(c), JSON.stringify(c));
await page.evaluate(() => { Object.defineProperty(window, 'orientation', { value: 90, configurable: true }); window.dispatchEvent(new Event('orientationchange')); });
await page.waitForTimeout(200);

// Into Team from the turned nav: Team goes wide.
await page.tap('.nav-item[data-tab="roster"]'); await page.waitForTimeout(600);
const team = await page.evaluate(() => {
  const sc = document.querySelector('.tr-scroll');
  return { turn: document.body.dataset.turn || '', body: Math.round(document.body.getBoundingClientRect().width), sc: Math.round(sc.getBoundingClientRect().width),
           hidden: sc.scrollWidth - sc.clientWidth };
});
check(`sideways, Team: full width (${team.body}px), the table ${team.sc}px wide, ${team.hidden}px left to scroll`, team.body >= 840 && team.sc >= 800 && !team.turn);
const fold = await page.evaluate(() => {
  const top = document.querySelector('.team-top'), nav = document.querySelector('.bottom-nav').getBoundingClientRect();
  const t = top.querySelector('.section-title').getBoundingClientRect(), h = top.querySelectorAll('.ropt-row');
  const rows = [...document.querySelectorAll('.tr-row[data-player]')].filter(r => r.getBoundingClientRect().bottom <= nav.top).length;
  const imp = document.querySelector('.tr-head .tr-c-imp').getBoundingClientRect().right;
  return { oneLine: [...h].every(r => Math.abs(r.getBoundingClientRect().top - t.top) < 16), top: Math.round(top.getBoundingClientRect().height), rows, imp: Math.round(imp) };
});
check(`sideways, Team: the title, payroll, OVR and both bars on one line, ${fold.top}px with the sub-tabs`, fold.oneLine && fold.top <= 90);
check(`sideways, Team: ${fold.rows} whole player rows show (was 2)`, fold.rows >= 5);
check(`sideways, Team: the season line spreads to the right edge (IMP ends at ${fold.imp}px)`, fold.imp >= 830);
await page.screenshot({ path: `${out}/landscape-team-${theme}.png` });

await page.tap('.nav-item[data-tab="league"]'); await page.waitForTimeout(400);
const tab = await page.$('#ltab-players'); if (tab) { await tab.tap(); await page.waitForTimeout(500); }
const league = await page.evaluate(() => {
  const sc = document.querySelector('.lp-scroll-wrap');
  const heads = [...document.querySelectorAll('.lp-header > .lp-th')].map(h => h.textContent.trim());
  const opsAt = heads.indexOf('OPS');
  const ops = opsAt < 0 ? [] : [...document.querySelectorAll('.lp-row')].slice(0, 30)
    .map(r => r.querySelectorAll('.lp-td:not(.lp-td-name)')[opsAt]?.textContent.trim());
  return { turn: document.body.dataset.turn || '', heads, ops,
           head: Math.round(document.querySelector('.app-header').getBoundingClientRect().height), body: Math.round(document.body.getBoundingClientRect().width), sc: Math.round(sc.getBoundingClientRect().width),
           hidden: sc.scrollWidth - sc.clientWidth };
});
check(`sideways, League players: full width (${league.body}px), the table ${league.sc}px wide, ${league.hidden}px left to scroll`, league.body >= 840 && league.sc >= 800 && !league.turn && league.head <= 46);
check(`League players: OPS after AVG (${league.heads.join(' ')})`, league.heads.indexOf('OPS') === league.heads.indexOf('AVG') + 1);
const good = league.ops.filter(v => /^(\d)?\.\d{3}$/.test(v) || v === '.---');
check(`League players: OPS values read like ".742" (${league.ops.slice(0, 6).join(' ')})`, league.ops.length > 5 && good.length === league.ops.length, league.ops.join(' '));
await page.screenshot({ path: `${out}/landscape-league-${theme}.png` });

// Back upright: the column comes back, nothing turned.
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
const back = await chrome();
check(`upright again: ${back.w}px wide, header ${back.headH}px, nothing turned`, back.w <= 390 && back.headH >= 50 && !back.turn);
// Sideways on League, then the Dashboard: held upright again.
await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(300);
await page.tap('.nav-item[data-tab="dashboard"]'); await page.waitForTimeout(400);
c = await chrome();
check('sideways, League → Dashboard: held upright again', c.tab === 'dashboard' && held(c), JSON.stringify(c));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
