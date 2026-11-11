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
await page.selectOption('#lp-sort-select', 'price');
await page.waitForTimeout(300);

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
check('Staff: the scouting director, rated, with a specialty', /Scouting Director/.test(staffText) && /\((\d+)\) · (pro scouting|international|rookies and indie ball)/.test(staffText), staffText.slice(-300));
check('Staff: no sideways scroll', await noHScroll());
await page.screenshot({ path: `${out}/staff-${theme}.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
