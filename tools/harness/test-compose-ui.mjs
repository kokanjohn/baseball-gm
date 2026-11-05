// §105 In the real app: (1) the radar during our live game; (2) Compose — pick a person, the topics
// are right there (in view, Send under them); the reply waits and arrives later, not at once.
//   node tools/harness/test-compose-ui.mjs outDir [theme] [height]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(execSync('npm root -g').toString().trim() + '/');
const { chromium } = require('playwright');
const [out = '.', theme = 'dark', height = '844'] = process.argv.slice(2);
const MIN = 60_000;
let ok = true;
const check = (name, cond, info = '') => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? ' — ' + info : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: +height }, deviceScaleFactor: 2, serviceWorkers: 'block', timezoneId: 'America/New_York' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8765/baseball-gm/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
// Our game started 20 minutes ago, in fair weather.
await page.evaluate(async ({ theme, MIN }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'lab', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾', primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const now = Date.now();
  SM.mutate(s => {
    s.settings.theme = theme;
    s.push = { ...(s.push || {}), quietStart: '23:59', quietEnd: '00:00' };   // (no quiet hours: the test runs at any hour)
    const g = s.schedule[s.currentGameIndex || 0];
    g.gameTime = now - 20 * MIN;
    const venueId = g.isHome ? 'user' : g.opponentId;
    g.wx = { v: 1, venueId, gameTime: g.gameTime, playMin: 180, outcome: 'played', calledBy: null, reason: null, decidedAt: null,
             startAt: g.gameTime, delays: [], endT: null, stopAtPlayMin: null };
  });
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
}, { theme, MIN });

// 1. The radar during the game.
await page.waitForSelector('#live-game-wrap .lgv-radar-btn', { timeout: 20000 });
const venue = await page.evaluate(async () => { const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get(); const g = s.schedule[s.currentGameIndex || 0]; return g.venueId || (g.isHome ? 'user' : g.opponentId); });
const line = (await page.textContent('#live-game-wrap .lgv-wx-line')).replace(/\s+/g, ' ').trim();
check(`the live game shows its weather with a Radar button (“${line}”)`, /Radar$/.test(line));
await page.screenshot({ path: `${out}/live-radar-btn-${theme}.png` });
await page.click('#live-game-wrap .lgv-radar-btn');
await page.waitForSelector('#radar-sheet.open', { timeout: 5000 });
check(`Radar opens the full radar on the game's ballpark (${await page.$eval('.rs-park', el => el.value)})`, await page.$eval('.rs-park', el => el.value) === venue);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/live-radar-sheet-${theme}.png` });
await page.click('.rs-done'); await page.waitForTimeout(400);
check('Done returns to the game', (await page.$('#radar-sheet')) === null && !!(await page.$('#live-game-wrap')));
// The card redraws on every tick: the button keeps working.
await page.evaluate(async () => { const EB = await import('/baseball-gm/ui/EventBus.js'); EB.emit('roster:changed'); });
await page.waitForTimeout(300);
await page.click('#live-game-wrap .lgv-radar-btn');
await page.waitForSelector('#radar-sheet.open', { timeout: 5000 });
check('…and again after the card redraws', true);
await page.click('.rs-done'); await page.waitForTimeout(400);

// 1b. A league game's viewer: its own Radar button, on that game's ballpark.
const lg = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
  for (const [date, games] of Object.entries(s.leagueSchedule?.dayMap || {})) {
    const g = games.find(x => !x.played && !x.isAllStar && x.homeId);
    if (g) { const LG = await import('/baseball-gm/ui/components/LiveGame.js'); LG.openLeagueGame(date, g.id); return { park: g.venueId || g.homeId }; }
  }
  return null;
});
await page.waitForSelector('#lg-viewer .lg-radar-btn', { timeout: 5000 });
await page.click('#lg-viewer .lg-radar-btn');
await page.waitForSelector('#radar-sheet.open', { timeout: 5000 });
check(`a league game's viewer opens the radar on its ballpark (${lg?.park})`, await page.$eval('.rs-park', el => el.value) === lg?.park);
await page.click('.rs-done'); await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('lg-viewer')?.remove());

// 2. Compose.
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('decisions'); });
await page.click('#itab-compose');
await page.waitForSelector('.compose-person', { timeout: 5000 });
await page.screenshot({ path: `${out}/compose-list-${theme}.png` });
await page.click('.compose-person[data-channel="groundskeeper"]');
await page.waitForSelector('.compose-to', { timeout: 5000 });
const vis = await page.evaluate(() => {
  const vh = window.innerHeight, inView = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh - 60; };   // (above the tab bar)
  return { topics: [...document.querySelectorAll('.compose-topic-btn')].map(inView), send: inView(document.getElementById('compose-send-btn')),
           to: document.querySelector('.compose-to').textContent.replace(/\s+/g, ' ').trim() };
});
check(`after picking the groundskeeper, the topics and Send are on screen, no scrolling (“${vis.to}”; ${vis.topics.length} topics)`, vis.topics.length >= 2 && vis.topics.every(Boolean) && vis.send);
await page.screenshot({ path: `${out}/compose-topics-${theme}.png` });
await page.click('.compose-topic-btn[data-topic="gk_field"]');
const t0 = Date.now();
await page.click('#compose-send-btn');
await page.waitForTimeout(400);
const after = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js'); const s = SM.get();
  const sch = (s.scheduledCards || []).find(c => c.isCompose && c._composeTopic === 'gk_field');
  return { inInbox: (s.inbox || []).some(c => c.isCompose), at: sch?.deliverAtMs, busy: s.schedule[s.currentGameIndex || 0].plays?.length,
           waitText: document.querySelector('.compose-waiting')?.textContent.replace(/\s+/g, ' ').trim() };
});
check(`sent: no reply in the inbox yet; it's due in ${((after.at - t0) / MIN).toFixed(0)} min`, !after.inInbox && after.at - t0 >= 15 * MIN);
check(`the groundskeeper works the game: the reply comes after it (${new Date(after.at).toLocaleTimeString()})`, after.at > t0 + 2 * 60 * MIN);
check(`Compose shows it waiting (“${after.waitText}”)`, /Head Groundskeeper.*Field conditions.*sent/.test(after.waitText || ''));
await page.screenshot({ path: `${out}/compose-waiting-${theme}.png` });
await page.click('.compose-person[data-channel="groundskeeper"]');
const topicNote = await page.$eval('.compose-topic-btn.disabled', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
check(`the topic says it's awaiting a reply (“${topicNote}”)`, /awaiting reply/.test(topicNote));
await page.click('#compose-back');
// When its time comes, it arrives.
const arrived = await page.evaluate(async (at) => {
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  CE.releaseDueCards(at - 1000);
  const SM = await import('/baseball-gm/store/StateManager.js');
  const early = (SM.get().inbox || []).some(c => c.isCompose);
  CE.releaseDueCards(at);
  const c = (SM.get().inbox || []).find(c => c.isCompose);
  return { early, subject: c?.subject, sender: c?.sender, body: c?.body, arrivedAtMs: c?.arrivedAtMs, logged: (SM.get().composeLog || []).length };
}, after.at);
check(`a second early it isn't there; at its time it arrives (“${arrived.subject}” from ${arrived.sender})`, !arrived.early && arrived.subject === 'Re: Field conditions' && arrived.arrivedAtMs === after.at);
check(`…written by the groundskeeper from the club as it stands, and remembered (${arrived.logged} in the log)`,
      /— Head Groundskeeper$/.test(arrived.body || '') && /field/i.test(arrived.body || '') && arrived.logged === 1, arrived.body);
console.log('\n' + arrived.body + '\n');
// The inbox shows it.
await page.click('#itab-todo'); await page.waitForTimeout(300);
const shown = await page.evaluate(() => [...document.querySelectorAll('#inbox-content *')].some(e => e.children.length === 0 && /Re: Field conditions/.test(e.textContent)));
check('the reply is in the inbox', shown);
await page.screenshot({ path: `${out}/compose-reply-${theme}.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
