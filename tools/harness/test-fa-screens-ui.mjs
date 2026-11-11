// §122 stage 3 in the real app: the Team screen without a farm (an open spot jumps
// to League → Players), the ESPN-style Players view (Available first, add from the
// row), the player card's career and "why no record" note, the injury decision.
//   node tools/harness/test-fa-screens-ui.mjs outDir [theme]
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
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const IE = await import('/baseball-gm/engine/InjuryEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const now = Date.now();
  // A bench bat leaves: an open spot.
  SM.mutate(s => {
    const u = s.userTeam, lineup = u.lineupSlots.map(sl => sl.playerId);
    const outId = u.rosterIds.find(x => !['SP', 'RP'].includes(s.players[x].pos) && !lineup.includes(x));
    u.rosterIds = u.rosterIds.filter(x => x !== outId);
    Object.assign(s.players[outId], { teamId: null, group: 'freeAgent', tier: 'freeAgent', _faSince: now });
    s.freeAgentPool = [...(s.freeAgentPool || []), outId];
  });
  // A CPU club's reserve put on waivers (r144: the time left shows beside the name).
  SM.mutate(s => {
    const t = s.leagueTeams[0], lineup = new Set((t.lineupSlots || []).map(sl => sl.playerId));
    const id = t.rosterIds.find(x => !['SP', 'RP'].includes(s.players[x].pos) && !lineup.has(x));
    t.rosterIds = t.rosterIds.filter(x => x !== id);
    Object.assign(s.players[id], { group: 'waivers', tier: 'waivers', onWaivers: true, waiverStartTime: now, teamId: null, _waivedBy: t.id });
    s.waiverPool = [...(s.waiverPool || []), id];
  });
  // A starter hurt: the diagnosis.
  const hurt = SM.get().userTeam.lineupSlots.find(sl => sl.slot === 'SS').playerId;
  SM.mutate(s => { Object.assign(s.players[hurt], IE.beginInjury(s.players[hurt], now, 'moderate', Math.random)); });
  CE.deliverInjuryAct2(hurt, now);
  CE.releaseDueCards();
  const st = SM.get();
  const pool = st.freeAgentPool.map(id => st.players[id]);
  const vet = pool.filter(p => (p.seasonLog || []).length >= 5).sort((a, b) => b.ovr - a.ovr)[0];
  const rookie = pool.find(p => p.origin === 'rookie') || pool.find(p => p.origin === 'overseas');
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return { vet: vet?.id, vetName: vet?.name, rookie: rookie?.id, injury: CE.getInbox().find(c => c.cardId === 'injury_act2')?.instanceId };
}, theme);
await page.waitForTimeout(1200);
const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ── Team ─────────────────────────────────────────────────────
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('roster'); });
await page.waitForTimeout(400);
await page.click('[data-group="hitters"]');
await page.waitForTimeout(300);
const team = await page.evaluate(() => document.getElementById('team-content')?.innerText || '');
check('Team: no farm, no keepers', !/farm|keeper/i.test(team), team.slice(0, 200));
check('Team: the open spot points to the free agents', /tap one to see the free agents who fit/i.test(team) && /tap to find a free agent/i.test(team));
check('Team: rows show Impact (last season on opening day)', /IMP [+-]?\d+\.\d last yr/.test(team));
check('Team: no sideways scroll', await noHScroll());
await page.screenshot({ path: `${out}/team-${theme}.png`, fullPage: false });

// ── An open spot → League → Players ──────────────────────────
await page.click('.vacancy-row[data-need]');
await page.waitForTimeout(700);
const lp = await page.evaluate(() => ({ text: document.getElementById('league-content')?.innerText || '',
  view: document.getElementById('lp-view-select')?.value, adds: document.querySelectorAll('.lp-add-btn').length,
  opts: [...document.querySelectorAll('#lp-view-select option')].map(o => o.textContent) }));
check('the open spot opens League → Players on Available, with Add buttons and asking prices, no DAYS column',
      lp.view === 'available' && lp.adds > 0 && /ASK/.test(lp.text) && !/DAYS/.test(lp.text), JSON.stringify({ view: lp.view, adds: lp.adds }));
check(`the filter shows no counts (${lp.opts.join(' / ')})`, lp.opts.length >= 5 && lp.opts.every(o => !/\(\d+\)/.test(o)));
await page.selectOption('#lp-view-select', 'waivers');
await page.waitForTimeout(400);
const wv = await page.evaluate(() => [...document.querySelectorAll('.lp-wv-left')].map(e => e.textContent));
check(`a player on waivers shows the time left beside the name (${wv.join(', ')})`, wv.length >= 1 && wv.every(x => /^\d+[dh]$/.test(x)));
await page.screenshot({ path: `${out}/players-waivers-${theme}.png` });
await page.selectOption('#lp-view-select', 'available');
await page.waitForTimeout(400);
check('League: no sideways page scroll', await noHScroll());
await page.screenshot({ path: `${out}/players-available-${theme}.png` });

// Add from the row → the sign sheet.
await page.click('.lp-add-btn[data-kind="sign"]');
await page.waitForTimeout(500);
const sheet = await page.evaluate(() => document.getElementById('ss-body')?.innerText || '');
check('Add opens the sign sheet (price, payroll after)', /Sign /.test(sheet) && /Payroll after/.test(sheet) && !/farm/i.test(sheet), sheet.slice(0, 200));
await page.screenshot({ path: `${out}/sign-sheet-${theme}.png` });
await page.click('#ss-cancel');
await page.waitForTimeout(300);

// On Rosters: the Impact leaders (none yet on opening day — the card stays out).
await page.selectOption('#lp-view-select', 'rosters');
await page.waitForTimeout(400);
const ros = await page.evaluate(() => ({ team: !!document.getElementById('lp-team-select'), rows: document.querySelectorAll('.lp-row').length }));
check('On Rosters: the Team filter appears and rostered players are listed', ros.team && ros.rows > 20, JSON.stringify(ros));
await page.selectOption('#lp-view-select', 'available');
await page.waitForTimeout(300);
check('no Sort dropdown (the column headers sort)', (await page.$('#lp-sort-select')) === null);
// r145 a header sorts by the line the row shows (last season's in spring): HR, best first, then flipped.
const hrs = async () => page.evaluate(() => {
  const heads = [...document.querySelectorAll('.lp-th')].map(h => h.dataset.sort);
  const i = heads.indexOf('hr'), j = heads.indexOf('hab');
  const rows = [...document.querySelectorAll('.lp-row')].map(r => r.querySelectorAll('.lp-td'));
  const n = rows.findIndex(c => c[j]?.textContent === '0/0');   // no record: last, either way
  return { hr: rows.slice(0, n < 0 ? rows.length : n).map(c => +c[i]?.textContent || 0),
           tailEmpty: n < 0 || rows.slice(n).every(c => c[j]?.textContent === '0/0') };
});
await page.click('.lp-th[data-sort="hr"]'); await page.waitForTimeout(300);
const hrDown = await hrs();
await page.click('.lp-th[data-sort="hr"]'); await page.waitForTimeout(300);
const hrUp = await hrs();
const sortedBy = (a, f) => a.every((x, i) => !i || f(a[i - 1], x));
check(`tapping HR sorts by it, most first (${hrDown.hr.slice(0, 5).join(', ')}…), and again flips it (${hrUp.hr.slice(0, 3).join(', ')}…); no record sorts last`,
      hrDown.hr.length > 5 && hrDown.hr[0] > 0 && sortedBy(hrDown.hr, (a, b) => a >= b) && sortedBy(hrUp.hr, (a, b) => a <= b) && hrDown.tailEmpty && hrUp.tailEmpty,
      JSON.stringify({ down: hrDown.hr.slice(0, 12), up: hrUp.hr.slice(0, 12) }));
await page.click('.lp-th[data-sort="price"]'); await page.waitForTimeout(300);

// ── Player cards ─────────────────────────────────────────────
await page.evaluate(async (id) => {
  const PC = await import('/baseball-gm/ui/components/PlayerCard.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  PC.openPlayerCard(id, SM.get());
}, made.vet);
await page.waitForTimeout(500);
const vetCard = await page.evaluate(() => document.body.innerText);
check(`a veteran free agent's card: career table, asking price, unsigned days (${made.vetName})`,
      /Career · \d+ seasons/i.test(vetCard) && /Total/i.test(vetCard) && /Asking/i.test(vetCard) && /Unsigned for/i.test(vetCard), vetCard.slice(0, 300));
check("the card shows last season's Impact", /Last season/i.test(vetCard));
await page.screenshot({ path: `${out}/card-veteran-${theme}.png` });
await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); });
await page.waitForTimeout(300);
if (made.rookie) {
  await page.evaluate(async (id) => {
    const PC = await import('/baseball-gm/ui/components/PlayerCard.js');
    const SM = await import('/baseball-gm/store/StateManager.js');
    PC.openPlayerCard(id, SM.get());
  }, made.rookie);
  await page.waitForTimeout(500);
  const rc = await page.evaluate(() => document.body.innerText);
  check('a player with no league record says why', /no league record/i.test(rc), rc.slice(0, 300));
  await page.screenshot({ path: `${out}/card-rookie-${theme}.png` });
  await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); });
}

// ── The injury decision in Messages ──────────────────────────
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('decisions'); });
await page.waitForTimeout(500);
await page.click(`[data-open="${made.injury}"]`).catch(() => {});
await page.waitForTimeout(500);
const inj = await page.evaluate(() => document.body.innerText);
check('the injury decision: IL + sign, IL and pick, cut', /IL .* — sign /.test(inj) && /I'll pick the replacement/.test(inj) && /Cut /.test(inj), inj.slice(0, 300));
await page.screenshot({ path: `${out}/injury-decision-${theme}.png` });

// §122.15 the Staff tab: the scouting director with the coaches.
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('roster'); });
await page.waitForTimeout(400);
await page.click('#tsubtab-staff');
await page.waitForTimeout(300);
const staffText = await page.evaluate(() => document.getElementById('team-content')?.innerText || '');
check('Staff: the cards show name, job, salary and contract only (no rating on the card)',
      /Scouting Director/.test(staffText) && /\/yr/.test(staffText) && /(yrs? left|Final Year)/.test(staffText) && !/\(\d+\) ·/.test(staffText), staffText.slice(-300));
check('Staff: no sideways scroll', await noHScroll());
await page.screenshot({ path: `${out}/staff-${theme}.png`, fullPage: true });
await page.click('.staff-card-tap[data-staff="scoutingDirector"]'); await page.waitForTimeout(500);
const sheet2 = await page.evaluate(() => document.getElementById('ts-swap-modal')?.innerText || '');
check('tapping one opens the sheet: rating, specialty and what it means, contract, relationship',
      /Rating/.test(sheet2) && /\(\d+\)/.test(sheet2) && /Specialty/.test(sheet2) && /Contract/.test(sheet2) && /Relationship with you/.test(sheet2), sheet2.slice(0, 300));
await page.screenshot({ path: `${out}/staff-sheet-${theme}.png` });
await page.click('#ts-swap-close'); await page.waitForTimeout(300);
await page.click('.staff-card-tap[data-staff="manager"]'); await page.waitForTimeout(500);
const mgr = await page.evaluate(() => document.getElementById('ts-swap-modal')?.innerText || '');
check('the manager\'s sheet: contract and relationship', /Manager/.test(mgr) && /Contract/.test(mgr) && /Relationship with you/.test(mgr), mgr.slice(0, 200));
await page.click('#ts-swap-close'); await page.waitForTimeout(300);
// r145 the club funds pill in the header opens Team → Finances (from another tab).
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('league'); });
await page.waitForTimeout(300);
await page.click('#head-budget'); await page.waitForTimeout(600);
const fin = await page.evaluate(() => ({ tab: document.querySelector('.tab-content.active')?.id, sub: document.querySelector('#tsubtab-finances')?.classList.contains('active') }));
check('the club funds pill opens Team → Finances', fin.tab === 'tab-roster' && fin.sub, JSON.stringify(fin));

// r146 League → Teams: a tap opens the club's sheet (standing, the roster as a lineup card reads).
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('league'); });
await page.waitForTimeout(300);
await page.click('#ltab-teams'); await page.waitForTimeout(400);
await page.click('.lgt-card[data-team]:not([data-team="user"])'); await page.waitForTimeout(600);
const tm = await page.evaluate(() => ({ text: document.getElementById('league-team-modal')?.innerText || '', rows: document.querySelectorAll('#league-team-modal .ltm-row').length }));
check('Teams: tapping a club opens its sheet — standing, rating, payroll, lineup, rotation, bullpen, bench',
      /Division/.test(tm.text) && /Team rating/i.test(tm.text) && /Payroll/i.test(tm.text) && /Lineup/i.test(tm.text) && /Rotation/i.test(tm.text) && /Bullpen/i.test(tm.text) && tm.rows >= 20, tm.text.slice(0, 300));
await page.screenshot({ path: `${out}/team-sheet-${theme}.png` });
await page.click('#league-team-modal .ltm-row'); await page.waitForTimeout(500);
check('a row on the sheet opens the player card', await page.evaluate(() => /Career|Season|OVR|Contract/i.test(document.querySelector('.pc-overlay, #player-card-overlay, .player-card')?.innerText || document.body.innerText)));
await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); document.getElementById('league-team-modal')?.remove(); });
await page.click('#ltab-standings'); await page.waitForTimeout(400);
await page.click('.standing-row[data-team-id]'); await page.waitForTimeout(500);
check('Standings: tapping a club opens the same sheet', !!(await page.$('#league-team-modal')));
await page.evaluate(() => document.getElementById('league-team-modal')?.remove());

// r146 a scouts' report: each player it names is a link to the player's card.
const rep = await page.evaluate(async () => {
  const CE = await import('/baseball-gm/engine/CardEngine.js');
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { s.composeCooldowns = {}; });
  const inst = CE.deliverComposeCard('sc_free_agents', 'scouting', { topicLabel: 'Free agents worth a look', nowMs: Date.now() - 6 * 3600_000 });
  CE.releaseDueCards(Math.max(Date.now(), inst?.deliverAtMs || 0));
  const c = CE.getInbox().find(x => x._composeTopic === 'sc_free_agents');
  return { id: c?.instanceId, named: (c?._playerIds || []).length };
});
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('decisions'); });
await page.waitForTimeout(400);
await page.click(`[data-open="${rep.id}"]`).catch(() => {});
await page.waitForTimeout(500);
const links = await page.evaluate(() => [...document.querySelectorAll('.msg-player')].map(b => b.textContent));
check(`a scouts' report links every player it names (${links.join(', ')})`, rep.named >= 1 && links.length >= rep.named, JSON.stringify(rep));
await page.screenshot({ path: `${out}/report-links-${theme}.png` });
// r148 times in Messages are relative ("Today at 8:40 PM", "Yesterday", "3 days ago"), never a calendar date.
const stamp = await page.evaluate(() => document.querySelector('.mr-to')?.textContent || '');
check(`the open message says when relatively (${stamp.trim()})`, /to me · (Today|Yesterday|\d+ days ago) at \d{1,2}:\d\d [AP]M/.test(stamp));
await page.evaluate(async () => {   // an older message, two days back
  const SM = await import('/baseball-gm/store/StateManager.js');
  SM.mutate(s => { const c = s.inbox.find(x => !x.resolved && x._composeTopic !== 'sc_free_agents'); if (c) c.arrivedAtMs = Date.now() - 2 * 86_400_000 - 3600_000; });
  const App = await import('/baseball-gm/ui/App.js'); App.switchTab('dashboard'); App.switchTab('decisions');
});
await page.waitForTimeout(500);
const list = await page.evaluate(() => document.getElementById('decisions-content')?.innerText || document.body.innerText);
check('the list says "2 days ago" and shows no calendar dates', /2 days ago/.test(list) && !/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/.test(list), list.slice(0, 300));
await page.screenshot({ path: `${out}/inbox-relative-${theme}.png` });
if (links.length) {
  await page.click('.msg-player'); await page.waitForTimeout(500);
  check('a name opens that player\'s card', await page.evaluate((n) => document.body.innerText.includes(n) && /Asking|Career|no league record/i.test(document.body.innerText), links[0]));
  await page.evaluate(async () => { const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); PC.closePlayerCard(); });
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
