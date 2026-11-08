// r135 §117 In the real app: the manager's deadline call-up as a message with
// a real choice, and our club's news in Recent on the dashboard.
//   node tools/harness/test-notices-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark'] = process.argv.slice(2);
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const made = await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const TE = await import('/baseball-gm/engine/TransactionEngine.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const RE = await import('/baseball-gm/engine/RosterEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const now = Date.now();
  // A bench bat leaves; the deadline passed; the manager called up a farm hitter.
  let picked = null;
  SM.mutate(s => {
    const u = s.userTeam, lineup = u.lineupSlots.map(sl => sl.playerId);
    const out = u.rosterIds.find(x => !['SP', 'RP'].includes(s.players[x].pos) && !lineup.includes(x));
    u.rosterIds = u.rosterIds.filter(x => x !== out);
    s.players[out].teamId = null; s.players[out].group = 'free_agent';
    picked = u.farmIds.find(x => !['SP', 'RP'].includes(s.players[x].pos));
    TE.callUp(s, picked, 'user', now, 'manager');
  });
  CE.syncRosterCards([
    { type: 'MANAGER_FILL', playerIds: [picked], atMs: now, penalty: { ownerTrust: -2, atmosphere: -1 } },
    { type: 'FARM_SIGNING', teamId: 'user', playerId: SM.get().userTeam.farmIds[0], atMs: now - 40 * 60_000 },
    { type: 'DEV_DONE', teamId: 'user', playerId: SM.get().userTeam.rosterIds[0], planId: 'p1', realized: 3, planned: 2, profile: 'steady', atMs: now - 15 * 60_000 },
  ], now);
  await CE.deliverAllStarMvpCard(SM.get().userTeam.rosterIds[1], now - 5 * 60_000);
  CE.releaseDueCards();
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return { picked: SM.get().players[picked].name, card: CE.getInbox().find(c => c.cardId === 'manager_fill')?.instanceId };
}, theme);
await page.waitForTimeout(1200);
check('the manager\'s call-up is a message', !!made.card);

// Recent on the dashboard.
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('dashboard'); });
await page.waitForTimeout(500);
await page.click('#recent-toggle').catch(() => {});
await page.waitForTimeout(300);
const recent = await page.evaluate(() => document.getElementById('recent-wrap')?.innerText || '');
check('Recent carries the minor-league signing, the development result and the MVP',
      /minor-league deal/.test(recent) && /development plan/.test(recent) && /All-Star Game MVP/.test(recent), recent);
const rw = await page.$('#recent-wrap');
if (rw) await rw.screenshot({ path: `${out}/notices-recent-${theme}.png` });

// Messages: the call-up, opened.
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('decisions'); });
await page.waitForTimeout(500);
const list = await page.evaluate(() => [...document.querySelectorAll('.ml-row')].map(r => r.innerText.replace(/\s+/g, ' ')).join(' || '));
check('the inbox lists the call-up, not the news', /called up/.test(list) && !/minor-league deal|development plan|All-Star Game MVP/.test(list), list);
await page.screenshot({ path: `${out}/notices-inbox-${theme}.png` });
await page.click(`[data-open="${made.card}"]`);
await page.waitForTimeout(500);
const body = await page.evaluate(() => document.body.innerText);
check('the message offers Keep and Send back', body.includes(`Keep ${made.picked}`) && body.includes(`Send ${made.picked} back`), body.slice(0, 300));
await page.screenshot({ path: `${out}/notices-callup-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
