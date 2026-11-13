// r157 What the screens don't say any more, and how a message reads:
//   - no hot / cold marks on players (Team rows, the player card, the dashboard), even for a player on a tear;
//   - no notes explaining how the game works (Compose, the empty Inbox and Completed, the Franchise Story, League Moves);
//   - a message's body set tighter (line height 1.4).
//   node tools/harness/test-copy-cleanup-ui.mjs outDir [theme]
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
now = first.gameTime + 15 * 3600_000;
await page.clock.setFixedTime(now);
const who = await page.evaluate(async () => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  GE.tick(); CE.releaseDueCards();
  const g = SM.get().schedule[0];
  if (g && !g._committed && g.status === 'final') await GE.commitGame(0);
  // Two of ours on a tear and one in a slump: the old 🔥 / ❄️ would show for them.
  const ids = SM.get().userTeam.lineupSlots.map(s => s.playerId).filter(Boolean).slice(0, 3);
  SM.mutate(s => { s.impScores = s.impScores || {}; ids.forEach((id, i) => { s.impScores[id] = { ...(s.impScores[id] || {}), imp7: i < 2 ? 6 : -5, impS: i < 2 ? 3 : -2 }; }); });
  return ids;
});
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const nav = async (tab) => { await page.tap(`.nav-item[data-tab="${tab}"]`); await page.waitForTimeout(450); };
const marks = () => page.evaluate(() => /🔥|❄/.test(document.body.innerText));

// ── Hot / cold ──
check('Dashboard: no hot / cold marks', !(await marks()));
check('Dashboard: no "Form" strip', !(await page.$('.hot-cold-strip')));
await nav('roster');
check('Team: no hot / cold marks on the roster', !(await marks()));
await page.evaluate(async (id) => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); const SM = await import('/baseball-gm/store/StateManager.js'); PC.openPlayerCard(id, SM.get()); }, who[0]);
await page.waitForTimeout(600);
check('Player card: no hot / cold mark, for a player on a tear', !(await page.evaluate(() => /🔥|❄/.test(document.getElementById('player-card-sheet')?.innerText || ''))) && !(await page.$('.pc-hot-cold')));
await page.evaluate(async () => (await import('/baseball-gm/ui/components/PlayerCard.js')).closePlayerCard());
await page.waitForTimeout(300);

// ── Explainer notes ──
const NOTES = /the way they would|real staff|answer after the game|arrive as the season moves|Check back after|kept here, with what you chose|will be recorded here|appear here as they happen/i;
await nav('decisions');
await page.tap('#itab-compose'); await page.waitForTimeout(400);
const firstCh = await page.$('[data-channel]:not([data-channel="other_gms"])');
if (firstCh) { await firstCh.tap(); await page.waitForTimeout(400); }
await page.screenshot({ path: `${out}/compose-no-note-${theme}.png` });
check('Compose: no note about how replies come back', !(await page.$('.compose-cooldown-note')) && !NOTES.test(await page.evaluate(() => document.getElementById('tab-decisions').innerText)));
await page.tap('#itab-completed'); await page.waitForTimeout(400);
check('Completed: no explainer when empty', !NOTES.test(await page.evaluate(() => document.getElementById('tab-decisions').innerText)) && !(await page.$('.ml-empty-s')));
await page.evaluate(async () => (await import('/baseball-gm/ui/screens/HistoryScreen.js')).openHistory());
await page.waitForTimeout(500);
check('Franchise Story: no explainer when empty', !(await page.$('.history-empty-sub')) && !NOTES.test(await page.evaluate(() => document.querySelector('.history-sheet')?.innerText || '')));
await page.evaluate(() => document.getElementById('history-close-btn')?.click());
await page.waitForTimeout(400);
await nav('league');
await page.tap('#ltab-moves'); await page.waitForTimeout(400);
check('League Moves: no explainer', !NOTES.test(await page.evaluate(() => document.getElementById('tab-league').innerText)));

// ── A message's body ──
await nav('decisions');
await page.tap('.ml-row[data-open]'); await page.waitForTimeout(500);
const lh = await page.evaluate(() => { const b = document.querySelector('.mr-body'); const cs = getComputedStyle(b); return { lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize), p: parseFloat(getComputedStyle(b.querySelector('p') || b).marginBottom) }; });
check(`Message: the body is set tighter (line height ${lh.lh.toFixed(2)}, ${lh.p}px between paragraphs)`, lh.lh <= 1.45 && lh.p <= 10);
await page.screenshot({ path: `${out}/message-body-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
