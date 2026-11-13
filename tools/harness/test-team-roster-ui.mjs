// r153 Team → Players in the real app, ESPN-fantasy style: a Hitters table and a Pitchers
// table (no collapsible groups), slot on the left, name and MOVE frozen, the line scrolling,
// IMP and OVR on the right; players reporting sit on the bench tagged Pending; an open
// lineup slot waits as "Empty" (tap to fill); the injured list shows only with someone on it.
//   node tools/harness/test-team-roster-ui.mjs outDir [theme]
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
  const RE = await import('/baseball-gm/engine/RosterEngine.js');
  const IE = await import('/baseball-gm/engine/InjuryEngine.js');
  SM.mutate(s => { s.settings.theme = theme; });
  const now = Date.now();
  const st0 = SM.get();
  const P = (id) => SM.get().players[id];
  // The shortstop to the bench: SS waits for the GM (the game is hours away).
  const ss = st0.userTeam.lineupSlots.find(sl => sl.slot === 'SS').playerId;
  const fillsNow = RE.managerFillsNow(st0, now);
  GE.gmMove(ss, 'bench', now);
  // A free-agent bat signed (reports tomorrow), the weakest bench bat dropped to make room.
  const seated = new Set(SM.get().userTeam.lineupSlots.map(sl => sl.playerId));
  const drop = SM.get().userTeam.rosterIds.map(P).filter(p => !['SP', 'RP'].includes(p.pos) && !seated.has(p.id) && p.id !== ss).sort((a, b) => a.ovr - b.ovr)[0];
  const fa = SM.get().freeAgentPool.map(P).filter(p => p && !['SP', 'RP'].includes(p.pos) && !p.isInjured).sort((a, b) => b.ovr - a.ovr)[0];
  const signed = GE.gmSignFreeAgent(fa.id, drop.id, now);
  // A reliever hurt and on the IL.
  const rp = SM.get().userTeam.rosterIds.map(P).find(p => p.group === 'bp');
  SM.mutate(s => { Object.assign(s.players[rp.id], IE.beginInjury(s.players[rp.id], now, 'moderate', Math.random)); Object.assign(s.players[rp.id], IE.placeOnILUpdate(s.players[rp.id])); });
  SM.mutate(s => RE.applyRosterMutation(s, RE.reconcileRoster(s, 'user', { atMs: now })));
  const App = await import('/baseball-gm/ui/App.js'); await App.init();
  return { ss, ssName: P(ss).name, fa: fa.id, faName: fa.name, signed: signed.ok, rp: rp.id, rpName: rp.name, fillsNow,
           hasHitIL: SM.get().userTeam.rosterIds.map(P).some(p => !['SP', 'RP'].includes(p.pos) && p.group === 'il') };
}, theme);
check('setup: SS benched outside the manager\'s hour, a signing, a reliever on the IL', made.signed && !made.fillsNow, JSON.stringify(made));
await page.waitForTimeout(800);
await page.evaluate(async () => { const App = await import('/baseball-gm/ui/App.js'); App.switchTab('roster'); });
await page.waitForTimeout(500);

const read = () => page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.tr-block')].map(b => ({
    title: b.querySelector('.tr-title span')?.textContent, season: b.querySelector('.tr-season')?.textContent,
    head: [...b.querySelectorAll('.tr-head .tr-td')].map(x => x.textContent),
    rows: [...b.querySelectorAll('.tr-row')].map(r => ({ slot: r.querySelector('.tr-slot')?.textContent, name: r.querySelector('.tr-name-line')?.textContent,
      sub: r.querySelector('.tr-sub')?.textContent, move: r.querySelector('.tr-move')?.textContent, disabled: !!r.querySelector('.tr-move')?.disabled,
      player: r.dataset.player || null, empty: r.classList.contains('tr-empty'), ovr: +(r.querySelector('.tr-c-ovr')?.textContent) || 0 })),
  }));
  return { blocks, groups: document.querySelectorAll('[data-group]').length, text: document.getElementById('team-content')?.innerText || '' };
});
let v = await read();
const [H, Pt] = v.blocks;
check('two tables, Hitters then Pitchers, no collapsible groups', v.blocks.length === 2 && H?.title === 'Hitters' && Pt?.title === 'Pitchers' && v.groups === 0, JSON.stringify(v.blocks.map(b => b.title)));
check('hitters: Wear (r160), the stat columns, then IMP and OVR', JSON.stringify(H.head) === JSON.stringify(['Wear', 'H/AB', 'R', 'HR', 'RBI', 'BB', 'SB', 'AVG', 'OPS', 'IMP', 'OVR']), H.head.join(','));
check('pitchers: the stat columns, then IMP and OVR', JSON.stringify(Pt.head) === JSON.stringify(['IP', 'W', 'L', 'SV', 'ERA', 'WHIP', 'K', 'BB', 'IMP', 'OVR']), Pt.head.join(','));
check('hitters by slot: C 1B 2B 3B SS OF OF OF DH, then the bench',
      H.rows.slice(0, 9).map(r => r.slot).join(' ') === 'C 1B 2B 3B SS OF OF OF DH' && H.rows.slice(9).every(r => ['Bench', 'IL', 'H', 'C', '1B', '2B', '3B', 'SS', 'OF', 'DH'].includes(r.slot)),
      H.rows.map(r => r.slot).join(' '));
const ssRow = H.rows[4];
check('the open SS slot waits: "Empty", tap to fill', ssRow.empty && ssRow.name === 'Empty', JSON.stringify(ssRow));
const benched = H.rows.find(r => r.player === made.ss);
check('the benched shortstop is on the bench with MOVE', benched?.slot === 'Bench' && benched.move === 'MOVE' && !benched.disabled, JSON.stringify(benched));
const pend = H.rows.find(r => r.player === made.fa);
check('the signing sits on the bench tagged Pending, reporting, MOVE greyed out', pend?.slot === 'Bench' && /^Pending/.test(pend.sub || "") && /tomorrow|today|in \d/.test(pend.sub || "") && pend.disabled, JSON.stringify(pend));
check('no injured hitters: no IL rows in the hitters table', !made.hasHitIL && !H.rows.some(r => r.slot === 'IL'));
// r154 the slot says SP or RP; the rotation and the pen each run best-rated first.
const spRows = Pt.rows.filter(r => r.slot === 'SP' && !r.empty), rpRows = Pt.rows.filter(r => r.slot === 'RP' && !r.empty);
const desc = (rs) => rs.every((r, i) => i === 0 || rs[i - 1].ovr >= r.ovr);
check('pitchers: SP ×5, then RP, the bench, the IL — no numbered turns or role codes',
      Pt.rows.slice(0, 5).every(r => r.slot === 'SP') && Pt.rows.slice(5, 10).every(r => r.slot === 'RP') && Pt.rows.at(-1).slot === 'IL'
      && !Pt.rows.some(r => /^(SP\d|CL|SU|MR|LR)$/.test(r.slot)),
      Pt.rows.map(r => r.slot).join(' '));
check('the rotation and the bullpen are each sorted by OVR, highest first', spRows.length === 5 && desc(spRows) && rpRows.length >= 4 && desc(rpRows),
      JSON.stringify({ sp: spRows.map(r => r.ovr), rp: rpRows.map(r => r.ovr) }));
check('who starts next is still marked', Pt.rows.slice(0, 5).filter(r => /Next/.test(r.sub || '')).length === 1, Pt.rows.slice(0, 5).map(r => r.sub).join(' | '));
const ilRow = Pt.rows.find(r => r.player === made.rp);
check('the injured reliever is on the IL with the injury and when, MOVE greyed out', ilRow?.slot === 'IL' && ilRow.disabled && /elig|TBD|season|cleared/i.test(ilRow.sub), JSON.stringify(ilRow));
check('the bullpen spot the injury opened waits as "Empty"', Pt.rows.some(r => r.empty && r.slot === 'RP'), Pt.rows.map(r => r.slot + (r.empty ? '*' : '')).join(' '));
check('no age or salary on the rows (they live on the player card)', ![...H.rows, ...Pt.rows].some(r => /\$|\d+y\b/.test(r.sub || '')), [...H.rows, ...Pt.rows].map(r => r.sub).filter(x => /\$|\d+y\b/.test(x || '')).slice(0, 3).join(' | '));
check('no old Pending Transactions section', !/Pending Transactions|Injured List/.test(v.text));
check('the page doesn\'t scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

// Headings over their columns, and the frozen part stays put when the line scrolls.
const geo = await page.evaluate(() => {
  const b = document.querySelector('.tr-block'), sc = b.querySelector('.tr-scroll');
  const headX = [...b.querySelectorAll('.tr-head .tr-td')].map(x => Math.round(x.getBoundingClientRect().left));
  const rowX = [...b.querySelectorAll('.tr-row')[0].querySelectorAll('.tr-td')].map(x => Math.round(x.getBoundingClientRect().left));
  const fz0 = b.querySelectorAll('.tr-row .tr-fz')[0].getBoundingClientRect().left;
  sc.scrollLeft = sc.scrollWidth;
  const fz1 = b.querySelectorAll('.tr-row .tr-fz')[0].getBoundingClientRect().left;
  const ovr = b.querySelector('.tr-row .tr-c-ovr').getBoundingClientRect();
  const scrolled = sc.scrollLeft;
  return { headX, rowX, fz0, fz1, scrolled, ovrRight: ovr.right, w: window.innerWidth };
});
check('every heading sits over its column', JSON.stringify(geo.headX) === JSON.stringify(geo.rowX), JSON.stringify(geo));
check('scrolled sideways: slot, name and MOVE stay put, and OVR comes into view', geo.scrolled > 0 && geo.fz0 === geo.fz1 && geo.ovrRight <= geo.w + 1, JSON.stringify(geo));
await page.screenshot({ path: `${out}/team-roster-scrolled-${theme}.png` });
await page.evaluate(() => { document.querySelectorAll('.tr-scroll').forEach(s => { s.scrollLeft = 0; }); });
await page.screenshot({ path: `${out}/team-roster-hitters-${theme}.png` });
await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"]`).scrollIntoView({ block: 'center' }), made.fa);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/team-roster-bench-${theme}.png` });
await page.evaluate(() => document.querySelectorAll('.tr-block')[1].scrollIntoView({ block: 'start' }));
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/team-roster-pitchers-${theme}.png` });

// MOVE opens where they can go; tapping the empty SS fills it.
await page.evaluate(() => window.scrollTo(0, 0));
await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"] .tr-move`).click(), made.ss);
await page.waitForTimeout(400);
const sheet = await page.evaluate(() => ({ title: document.querySelector('#ts-swap-modal .modal-title')?.textContent,
  rows: [...document.querySelectorAll('#ts-swap-modal .sm-row')].map(r => r.innerText.replace(/\s+/g, ' ')), note: document.querySelector('#ts-swap-modal .sm-note')?.textContent }));
check('MOVE opens where the player can go, including the open SS', /^Move /.test(sheet.title || '') && sheet.rows.some(r => /^SS Open/.test(r)), JSON.stringify(sheet));
await page.screenshot({ path: `${out}/team-roster-move-${theme}.png` });
await page.evaluate(() => [...document.querySelectorAll('#ts-swap-modal .sm-row')].find(r => /^SS/.test(r.innerText.trim()))?.click());
await page.waitForTimeout(500);
v = await read();
check('…and the shortstop is back at SS', v.blocks[0].rows[4].player === made.ss, JSON.stringify(v.blocks[0].rows[4]));

// The empty bullpen spot: tap it, pick a reliever from the bench.
const fill = await page.evaluate(async () => {
  const row = [...document.querySelectorAll('.tr-empty')].find(r => r.querySelector('.tr-slot')?.textContent === 'RP');
  if (!row) return { none: true };
  row.click();
  await new Promise(r => setTimeout(r, 400));
  const picks = [...document.querySelectorAll('#ts-swap-modal .sm-row[data-pick]')];
  const title = document.querySelector('#ts-swap-modal .modal-title')?.textContent;
  picks[0]?.click();
  await new Promise(r => setTimeout(r, 500));
  return { title, n: picks.length, empties: [...document.querySelectorAll('.tr-empty')].length };
});
check('tapping the empty bullpen spot lists the bench arms; one fills it', !fill.none && /Fill the open bullpen spot/.test(fill.title) && fill.n > 0 && fill.empties === 0, JSON.stringify(fill));

// A row opens the player card.
await page.evaluate((id) => document.querySelector(`.tr-row[data-player="${id}"] .tr-name`).click(), made.ss);
await page.waitForTimeout(500);
check('a row opens the player card', await page.evaluate(() => !!document.querySelector('.modal-overlay.open, .player-card, #player-card-modal')));

// r154 a reliever's role is on the player card — the pen's and the pitcher bench's (a reserve).
const roleOf = async (id) => page.evaluate(async (id) => {
  const PC = await import('/baseball-gm/ui/components/PlayerCard.js'); const SM = await import('/baseball-gm/store/StateManager.js');
  PC.closePlayerCard(); PC.openPlayerCard(id, SM.get());
  await new Promise(r => setTimeout(r, 300));
  return document.querySelector('#player-card-overlay .pc-role')?.textContent.replace(/\s+/g, ' ').trim() || null;
}, id);
const ids = await page.evaluate(async () => {
  const SM = await import('/baseball-gm/store/StateManager.js'); const st = SM.get();
  const ps = st.userTeam.rosterIds.map(id => st.players[id]);
  return { pen: ps.filter(p => p.group === 'bp' && !p.isInjured).map(p => p.id), bench: ps.find(p => p.group === 'pb' && p.pos === 'RP' && !p.isInjured)?.id || null,
           sp: ps.find(p => p.group === 'sp')?.id };
});
const penRoles = [];
for (const id of ids.pen) penRoles.push(await roleOf(id));
check('every reliever in the pen shows a bullpen role on the card (one closer)',
      penRoles.every(r => /^Bullpen role (Closer|Setup|Middle relief|Long relief)$/.test(r || '')) && penRoles.filter(r => /Closer/.test(r)).length === 1, penRoles.join(' | '));
await page.screenshot({ path: `${out}/team-roster-role-${theme}.png` });
if (ids.bench) { const r = await roleOf(ids.bench); check('a bench reliever: a reserve, with the role', /^Bullpen role Reserve · (middle|long) relief$/.test(r || ''), r); }
check('a starter has no bullpen role', (await roleOf(ids.sp)) === null);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
