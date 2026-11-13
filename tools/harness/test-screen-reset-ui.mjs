// r155 Leaving a screen and coming back lands on its first view (Team → Players, League → Players with
// the default filters, Inbox → To Do, the dashboard's Recent closed), at the top; tapping the tab
// you're on, or a jump to a chosen view, keeps it. And inbox messages carry no tags ("Good news",
// "Urgent", "Trade" …): the only chip left is a decision's deadline.
//   node tools/harness/test-screen-reset-ui.mjs outDir [theme]
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
// A day in (the first spring game played), so the inbox has mail.
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

const nav = async (tab) => { await page.tap(`.nav-item[data-tab="${tab}"]`); await page.waitForTimeout(450); };
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };
const active = (sel) => page.evaluate((sel) => document.querySelector(sel)?.classList.contains('active') ?? null, sel);
const scrollPanel = (tab) => page.evaluate((tab) => { const p = document.getElementById(`tab-${tab}`); p.scrollTop = 400; return p.scrollTop; }, tab);
const panelTop = (tab) => page.evaluate((tab) => document.getElementById(`tab-${tab}`).scrollTop, tab);

// ── Team ──
await nav('roster');
await tap('#tsubtab-staff');
check('Team: the Staff tab opens', await active('#tsubtab-staff'));
const scrolled = await scrollPanel('roster');
await nav('roster');                                        // the tab you're on: not leaving
check('Team: tapping Team again keeps Staff', await active('#tsubtab-staff'));
await nav('decisions');
await nav('roster');
check('Team: Staff → Inbox → Team lands back on Players', await active('#tsubtab-players') && !(await active('#tsubtab-staff')));
check('Team: …at the top', scrolled === 0 || (await panelTop('roster')) === 0);
await tap('#tsubtab-finances');
await nav('league'); await nav('roster');
check('Team: Finances → League → Team lands back on Players', await active('#tsubtab-players'));
// A jump to a chosen view is not a reset: the funds pill opens Finances, from any screen.
await nav('dashboard');
await page.evaluate(async () => (await import('/baseball-gm/ui/screens/TeamScreen.js')).showFinances());
await page.waitForTimeout(400);
check('Team: the funds pill still opens Finances', await active('#tsubtab-finances'));
await nav('dashboard'); await nav('roster');
check('Team: …and leaving from there resets to Players', await active('#tsubtab-players'));

// ── League ──
await nav('league');
await tap('#ltab-standings');
check('League: the Standings tab opens', await active('#ltab-standings'));
await nav('schedule'); await nav('league');
check('League: Standings → Schedule → League lands back on Players', await active('#ltab-players'));
const defaults = await page.evaluate(() => ({ pos: document.querySelector('.lp-pos-btn.active')?.dataset.pos, q: document.getElementById('lp-search')?.value }));
await page.tap('.lp-pos-btn[data-pos="SP"]'); await page.waitForTimeout(300);
await page.fill('#lp-search', 'a'); await page.waitForTimeout(500);
const changed = await page.evaluate(() => ({ pos: document.querySelector('.lp-pos-btn.active')?.dataset.pos, q: document.getElementById('lp-search')?.value }));
check(`League: the filters change (${JSON.stringify(defaults)} → ${JSON.stringify(changed)})`, changed.pos === 'SP' && changed.q === 'a');
await nav('dashboard'); await nav('league');
const back = await page.evaluate(() => ({ pos: document.querySelector('.lp-pos-btn.active')?.dataset.pos, q: document.getElementById('lp-search')?.value }));
check('League: …and come back to the defaults (position, search)', back.pos === defaults.pos && back.q === defaults.q, JSON.stringify(back));
// An open spot on the Team screen jumps to League's available players for it: kept.
await nav('roster');
await page.evaluate(async () => (await import('/baseball-gm/ui/screens/LeagueScreen.js')).showAvailable({ side: 'pitcher', pos: 'RP' }));
await page.waitForTimeout(400);
check('League: a jump from an open spot keeps its filter (RP)', await page.evaluate(() => document.querySelector('.lp-pos-btn.active')?.dataset.pos) === 'RP');

// ── Inbox ──
await nav('decisions');
await tap('#itab-completed');
check('Inbox: the Completed folder opens', await active('#itab-completed'));
await nav('roster'); await nav('decisions');
check('Inbox: Completed → Team → Inbox lands back on To Do', await active('#itab-todo'));
const rows = await page.$$eval('.ml-row', r => r.length);
check(`Inbox: there is mail to look at (${rows})`, rows > 0);
await page.screenshot({ path: `${out}/inbox-no-tags-${theme}.png` });
const chips = await page.$$eval('.ml-label', els => els.map(e => e.textContent.trim()));
check(`Inbox: no tags on the list — only deadlines (${chips.length ? chips.join(', ') : 'none'})`, chips.every(t => /^Due /.test(t)));
await tap('.ml-row[data-open]');
const reader = await page.evaluate(() => ({ open: !!document.querySelector('.mr-subject'), labels: !!document.querySelector('.mr-labels'),
  chips: [...document.querySelectorAll('.mr .ml-label')].map(e => e.textContent.trim()) }));
check('Inbox: an open message has no tags either', reader.open && !reader.labels && reader.chips.every(t => /^Due /.test(t)), JSON.stringify(reader));
await nav('league'); await nav('decisions');
check('Inbox: a message left open → League → Inbox lands back on the list', !(await page.$('.mr-subject')) && await active('#itab-todo'));

// ── Dashboard: Recent ──
await nav('dashboard');
if (await page.$('#recent-toggle')) {
  await tap('#recent-toggle');
  check('Dashboard: Recent opens', await page.evaluate(() => document.getElementById('recent-wrap')?.classList.contains('open')));
  await nav('schedule'); await nav('dashboard');
  check('Dashboard: …and is closed again after leaving', !(await page.evaluate(() => document.getElementById('recent-wrap')?.classList.contains('open'))));
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
