// §118 step 2 In the real app: one of our players hurt during a game — the
// play-by-play line, and the trainer's first message in Messages.
//   node tools/harness/test-game-injury-ui.mjs outDir [theme]
// Needs a static server on :8765 serving the repo's parent (…/baseball-gm/).
// The page's clock is fixed (Playwright clock.setFixedTime) and moved day by
// day; the look-ahead finds the first game where one of ours gets hurt; the
// app is then opened 3 minutes after that play (still in the game, even in the
// 9th), and the clock moved on 25 minutes for the trainer's message.
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
let now = Date.now();
await page.clock.setFixedTime(now);
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.evaluate(async (theme) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.settings.theme = theme; });
}, theme);

// Day by day: look ahead; no injury of ours → play the day (app closed: catch up the next morning).
let found = null;
for (let d = 0; d < 60 && !found; d++) {
  const r = await page.evaluate(async () => {
    const SM = await import('/baseball-gm/store/StateManager.js');
    const LA = await import('/baseball-gm/engine/LookAhead.js');
    const st = SM.get(), g0 = st.schedule[st.currentGameIndex];
    if (!g0) return { end: true };
    const L = LA.lookAhead(Date.now());
    const p = (L?.plays || []).find(x => x._injury && st.players[x._injury.playerId]?.teamId === 'user');
    return { gameTime: g0.gameTime, index: g0.index, hurt: p ? { at: p._timestamp, id: p._injury.playerId, text: p.description, inning: p.inning } : null };
  });
  if (r.end) break;
  if (r.hurt) { found = r; break; }
  now = r.gameTime + 15 * 3600_000;
  await page.clock.setFixedTime(now);
  await page.evaluate(async (i) => {
    const GE = await import('/baseball-gm/engine/GameEngine.js');
    const CE = await import('/baseball-gm/engine/CardEngine.js');
    const SM = await import('/baseball-gm/store/StateManager.js');
    GE.tick(); CE.releaseDueCards();
    const g = SM.get().schedule[i];
    if (g && !g._committed && (g.status === 'final' || g.status === 'postponed' || g.cancelled)) await GE.commitGame(i);
  }, r.index);
}
check('the look-ahead finds a game where one of ours gets hurt', !!found);
if (found) {
  console.log(`    ${found.hurt.text} (inning ${found.hurt.inning})`);
  // Open the app 3 minutes after the play (a hurt player in the 9th: the game may end soon after).
  now = found.hurt.at + 3 * 60_000;
  await page.clock.setFixedTime(now);
  await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
  await page.waitForTimeout(1500);
  const feed = await page.evaluate(() => document.getElementById('lgv-pbp-feed')?.innerText || '');
  check('the play-by-play shows the player leaving the game', feed.includes(found.hurt.text.split('.')[0]), feed.slice(0, 200));
  const hurtRow = await page.$('.pbp-play.pbp-hurt');
  check('…styled as an injury', !!hurtRow);
  if (hurtRow) {
    await hurtRow.scrollIntoViewIfNeeded();
    const wrap = await page.$('#lgv-pbp-feed');
    await (wrap || hurtRow).screenshot({ path: `${out}/injury-pbp-${theme}.png` });
  }
  await page.screenshot({ path: `${out}/injury-live-${theme}.png` });
  // Messages: the trainer's first message, within 25 minutes of the play.
  now = found.hurt.at + 25 * 60_000;
  await page.clock.setFixedTime(now);
  await page.waitForTimeout(6000);   // the app's next tick releases what's due
  const card = await page.evaluate(async (id) => {
    const CE = await import('/baseball-gm/engine/CardEngine.js');
    const SM = await import('/baseball-gm/store/StateManager.js');
    const c = CE.getInbox().find(x => x.cardId === 'injury_act1' && x._targetPlayerId === id);
    const sched = (SM.get().scheduledCards || []).find(x => x.cardId === 'injury_act1' && x._targetPlayerId === id);
    return c ? { iid: c.instanceId, subject: c.subject, body: c.body } : sched ? { pending: sched.deliverAtMs, now: Date.now() } : null;
  }, found.hurt.id);
  if (card?.pending) console.log(`    still scheduled: due ${Math.round((card.pending - card.now) / 60000)} min from now`);
  check('the trainer\'s message is in Messages, during the game', !!card?.iid, card ? 'scheduled, not yet delivered' : 'none');
  if (card?.iid) {
    check('…naming the inning', card.body.includes(`in the ${found.hurt.inning}`), card.body.slice(0, 160));
    await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('decisions'); });
    await page.waitForTimeout(500);
    await page.click(`[data-open="${card.iid}"]`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/injury-act1-${theme}.png` });
  }
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
