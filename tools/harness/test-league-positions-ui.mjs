// r168 §122.35 phase 6 — positions around the league on screen: the League → Moves wire lists a
// club's position change as "Position"; Recent has the line; a free agent working out at a spot we
// need is a Pro Scouting message with Sign / Pass.
//   node tools/harness/test-league-positions-ui.mjs outDir [theme]
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
const S = await page.evaluate(async ({ theme, now }) => {
  const GE = await import('/baseball-gm/engine/GameEngine.js');
  await GE.startNewGame({ archetypeId: 'contender', gmName: 'GM', city: 'Riverton', nickname: 'Rails', icon: '⚾',
                          primaryColor: '#1B2A4A', secondaryColor: '#3A1F1F', region: 'east', gameMode: 'live' });
  const SM = await import('/baseball-gm/store/StateManager.js');
  const Pos = await import('/baseball-gm/engine/Positions.js');
  const FA = await import('/baseball-gm/engine/FreeAgency.js');
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const SE = await import('/baseball-gm/engine/SeasonEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const st = SM.get(), u = st.userTeam;
  // a club's move on the wire and in Recent
  const club = st.leagueTeams[0];
  const theirs = club.rosterIds.map(id => st.players[id]).find(p => !Pos.isPitcher(p) && !Pos.canPlay(p, '2B'));
  SM.mutate(s => {
    Pos.grantPosition(s.players[theirs.id], '2B');
    const line = `${club.name} have ${theirs.name} (OVR ${theirs.ovr}) playing 2B too (${Pos.posLabel(s.players[theirs.id])})`;
    s.leagueWire = [...(s.leagueWire || []), { id: 'w-test', season: s.seasonNum || 1, atMs: now - 3600_000, kind: 'position', teamIds: [club.id], text: line }];
    s.activityFeed = [...(s.activityFeed || []), SE.buildActivityFeedEntry('position', club.abbr, `${club.abbr} have ${theirs.name} playing 2B too (${Pos.posLabel(s.players[theirs.id])})`, now + 1000)];
  });
  // a free agent at a spot we need
  const ss = st.players[u.lineupSlots.find(x => x.slot === 'SS').playerId];
  let fa = null;
  for (const c of Object.values(SM.get().players).filter(p => p.group === 'freeAgent' && !Pos.isPitcher(p) && !Pos.canPlay(p, 'SS'))) {
    SM.mutate(s => { s.players[c.id].ovr = ss.ovr + 6; });
    const r = FA.roomFor(SM.get(), SM.get().players[c.id]), d = r.candidates.find(x => !x.starter);
    if (!FA.signBlocker(SM.get(), c.id, r.needsDrop ? d?.player.id : null)) { fa = c; break; }
  }
  SM.mutate(s => { Pos.grantPosition(s.players[fa.id], 'SS'); s.leaguePos = { lastMsgAt: -Infinity }; });
  CE.leaguePositionNews([{ type: 'LEAGUE_POS', kind: 'fa', playerId: fa.id, teamId: null, pos: 'SS', atMs: now, text: 'x' }], now);
  const card = [...SM.get().inbox, ...(SM.get().scheduledCards || [])].find(c => c.cardId === 'fa_pos');
  return { club: club.name, theirs: theirs.name, fa: fa.name, deliverAt: card?.deliverAtMs, id: card?.instanceId };
}, { theme, now });
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); await App.init(); });
await page.waitForTimeout(800);
const tap = async (sel) => { await page.tap(sel); await page.waitForTimeout(400); };

// Recent
const recent = await page.evaluate(() => document.querySelector('.recent-latest')?.textContent || '');
check(`Recent: "${recent}"`, recent.includes(S.theirs) && /playing 2B too/.test(recent));
// League → Moves
await tap('.nav-item[data-tab="league"]');
await tap('#ltab-moves');
const row = await page.evaluate((name) => [...document.querySelectorAll('.lw-row, .lw-item, [class^="lw-"]')].map(r => r.innerText.replace(/\s+/g, ' ')).find(t => t.includes(name)) || '', S.theirs);
check(`the wire: ${row.slice(0, 120)}`, /Position/i.test(row) && row.includes(S.club));
await page.screenshot({ path: `${out}/league-pos-wire-${theme}.png` });
// the message
now = S.deliverAt + 60_000;
await page.clock.setFixedTime(now);
await page.evaluate(async () => { (await import('/baseball-gm/engine/CardEngine.js')).releaseDueCards(); });
await tap('.nav-item[data-tab="dashboard"]');
await tap('.nav-item[data-tab="decisions"]');
await tap(`[data-open="${S.id}"]`);
await page.waitForTimeout(2600);
const read = await page.evaluate(() => ({ body: document.querySelector('.mr-body')?.innerText || '', btn: [...document.querySelectorAll('[data-resolve]')].map(b => b.textContent.trim()) }));
check(`the message: ${read.btn.join(' / ')}`, /would start over/.test(read.body) && read.btn.includes(`Sign ${S.fa}`) && read.btn.includes('Pass'), read.body);
await page.screenshot({ path: `${out}/league-pos-message-${theme}.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
