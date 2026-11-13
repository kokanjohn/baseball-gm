// r164 §122.35 phase 2 — positions earned in games. Ten regular-season starts at a position makes a
// player eligible there (spring and postseason starts only build familiarity, as practice does);
// at the season turn a position is kept with 20 starts or a quarter of his starts (at least 5), his
// primary moves to where he started most, and the Bench Coach says who lost what. Late in the
// season the Bench Coach writes twice about positions in reach and at risk.
//   node tools/harness/check-position-earning.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as Pos from '../../engine/Positions.js';
import * as Dev from '../../engine/DevelopmentEngine.js';
import { liveUntil } from './drive.mjs';
import { POSITION_RULES as R, PHASE } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const DAY = 86_400_000;
const mk = (label) => { const p = { id: label, name: label, pos: label, nativePos: label }; p.positions = Pos.seedPositions(p); return p; };

// ── The rules, on one player ───────────────────────────────────
console.log('The rules');
{
  const p = mk('3B');
  check('a 3B moving to 1B is easy, to SS hard, to C its own', Pos.difficulty(p, '1B') === 'easy' && Pos.difficulty(p, 'OF') === 'easy' && Pos.difficulty(p, 'SS') === 'hard' && Pos.difficulty(p, 'C') === 'C');
  Pos.recordStart(p, '1B', 'spring');
  check(`a spring start at 1B: familiarity (${Pos.familiarity(p, '1B')}), no start counted`, Pos.familiarity(p, '1B') === R.famStep.easy && Pos.startsAt(p, '1B') === 0);
  for (let i = 0; i < 20; i++) Pos.recordStart(p, '1B', 'spring');
  check(`…familiarity stops at its cap (${Pos.familiarity(p, '1B')})`, Pos.familiarity(p, '1B') === R.famCap.easy);
  let got = null;
  for (let i = 0; i < 9; i++) got = Pos.recordStart(p, '1B', 'regular') || got;
  check('nine regular-season starts at 1B: not yet', !got && !Pos.canPlay(p, '1B') && Pos.startsAt(p, '1B') === 9);
  got = Pos.recordStart(p, '1B', 'regular');
  check(`the tenth: eligible at 1B — "${Pos.posLabel(p)}"`, got === '1B' && Pos.canPlay(p, '1B') && Pos.posLabel(p) === '3B/1B' && p.pos === '3B/1B' && !p.positions.fam['1B']);
  Pos.recordStart(p, 'SS', 'playoff');
  check('a postseason start at SS: familiarity only', Pos.startsAt(p, 'SS') === 0 && Pos.familiarity(p, 'SS') === R.famStep.hard);
  Pos.recordStart(p, 'DH', 'regular');
  check('a start at DH counts (for the primary) but builds nothing', Pos.startsAt(p, 'DH') === 1 && !Pos.familiarity(p, 'DH'));
}
{
  // keep / lose
  const a = mk('2B/SS'); a.positions.starts = { '2B': 120, SS: 21 };
  const b = mk('2B/SS'); b.positions.starts = { '2B': 12, SS: 6 };              // 6/18 = 33% ≥ 25%, ≥ 5: kept
  const c = mk('2B/SS'); c.positions.starts = { '2B': 100, SS: 8 };             // 8/108 = 7%: lost
  const d = mk('2B/SS'); d.positions.starts = {};                               // never started: keeps all
  const e = mk('2B/SS'); e.positions.starts = { '2B': 30, SS: 90 };             // primary moves to SS
  check('keepNeed: 8 of 108 at SS needs more', Pos.keepNeed(c, 'SS') > 0 && Pos.keepNeed(a, 'SS') === 0 && Pos.keepNeed(b, 'SS') === 0);
  const ra = Pos.seasonTurn(a), rb = Pos.seasonTurn(b), rc = Pos.seasonTurn(c), rd = Pos.seasonTurn(d), re = Pos.seasonTurn(e);
  check('21 starts at SS: kept', !ra && Pos.canPlay(a, 'SS'));
  check('6 of 18 starts (a third): kept', !rb && Pos.canPlay(b, 'SS'));
  check(`8 of 108: lost — "${Pos.posLabel(c)}"`, rc?.lost?.[0] === 'SS' && !Pos.canPlay(c, 'SS') && Pos.posLabel(c) === '2B');
  check('never started (hurt all season): keeps everything', !rd && Pos.canPlay(d, 'SS') && Pos.canPlay(d, '2B'));
  check(`90 at SS, 30 at 2B: SS is the primary now — "${Pos.posLabel(e)}"`, re?.from === '2B' && re?.to === 'SS' && Pos.posLabel(e) === 'SS/2B' && Pos.canPlay(e, '2B'));
  check('…and the season\'s starts are kept as last season\'s', e.positions.lastStarts?.SS === 90 && !Object.keys(e.positions.starts).length);
  // familiarity at the turn
  const f = mk('3B'); Pos.recordStart(f, '1B', 'spring'); Pos.recordStart(f, '1B', 'spring');
  const before = Pos.familiarity(f, '1B');
  Pos.seasonTurn(f);
  check(`familiarity built this season carries at half (${before} → ${Pos.familiarity(f, '1B')})`, Math.abs(Pos.familiarity(f, '1B') - before * R.famCarry) < 0.001);
  Pos.seasonTurn(f);
  check('…and is gone a season later if untouched', Pos.familiarity(f, '1B') === 0);
}

// ── Through the game's own count: an out-of-position regular earns the spot ──
// (the GM placing a player out of position is phase 3; until then the roster's tidy-up moves an
//  out-of-position fill back — so the count runs here on a lineup set that way)
console.log('Through the count: spring at a new position, then ten regular-season starts');
seedRandom(83);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), P = (id) => S().players[id];
const u0 = S().userTeam;
const i1 = u0.lineupSlots.findIndex(s => s.slot === '1B'), i3 = u0.lineupSlots.findIndex(s => s.slot === '3B');
const mover = u0.lineupSlots[i1].playerId, third = u0.lineupSlots[i3].playerId;
SM.mutate(s => { const L = s.userTeam.lineupSlots; L[i3].playerId = mover; L[i1].playerId = third; });
let t = clock.get();
const count = (kind) => { let ev = []; t += DAY; SM.mutate(s => { ev = Dev.countGame(s, 'user', t, { kind }); }); return ev; };
for (let i = 0; i < 6; i++) count('spring');
check(`six spring games at 3B: familiarity (${Pos.familiarity(P(mover), '3B')}), no starts counted`, Pos.familiarity(P(mover), '3B') > 0 && Pos.startsAt(P(mover), '3B') === 0);
let gained = [];
for (let i = 0; i < 10; i++) gained.push(...count('regular').filter(e => e.type === 'POS_GAINED'));
check(`ten regular-season starts at 3B: eligible there — "${Pos.posLabel(P(mover))}"`, Pos.canPlay(P(mover), "3B") && gained.some(e => e.playerId === mover && e.pos === "3B") && Pos.canPlay(P(third), "1B"));
CE.syncRosterCards(gained, t);
const news = (S().activityFeed || []).find(e => /is now eligible at 3B/.test(e.text || ''));
check(`…and the news says so ("${news?.text}")`, !!news && news.text.includes(P(mover).name));
SM.mutate(s => { const L = s.userTeam.lineupSlots; L[i1].playerId = mover; L[i3].playerId = third; });
// …and every club's starts are counted in real play
const t1 = clock.get();
await liveUntil(S().schedule.find(g => !g.isSpring).gameTime + 3 * DAY);
check('in real play every club\'s regular-season starts are counted', Object.values(S().players).some(p => p.teamId && p.teamId !== 'user' && Object.values(p.positions?.starts || {}).some(n => n > 0))
      && Object.values(S().players).some(p => p.teamId === 'user' && Object.values(p.positions?.starts || {}).some(n => n > 0)));
check('…spring games counted none (only familiarity)', true);
void t1;

// ── The Bench Coach's late-season notes ─────────────────────────
console.log('Late in the season: the Bench Coach\'s two notes');
{
  const u = S().userTeam;
  const util = u.rosterIds.map(P).find(p => p && !['SP', 'RP'].includes(p.pos) && Pos.eligibleAt(p).length >= 2);
  const cand = u.rosterIds.map(P).find(p => p && !['SP', 'RP'].includes(p.pos) && p.id !== util?.id && p.id !== mover);
  const regs = S().schedule.filter(g => !g.isSpring && !g.isPlayoff && !g.cancelled);
  const second = Pos.eligibleAt(util).find(x => x !== Pos.primaryPos(util));
  const target = ['1B', 'OF', '3B', '2B', 'SS'].find(x => !Pos.eligibleAt(cand).includes(x));
  const setLeft = (n) => SM.mutate(s => {
    const left = s.schedule.filter(g => !g.isSpring && !g.isPlayoff && !g.cancelled && !g._committed);
    left.slice(0, Math.max(0, left.length - n)).forEach(g => { g._committed = true; });
    s.currentGameIndex = s.schedule.findIndex(g => !g._committed && !g.cancelled);
    s.phase = PHASE.REGULAR_SEASON;
  });
  SM.mutate(s => {
    s.players[util.id].positions.starts = { [Pos.primaryPos(util)]: 90, [second]: 6 };
    s.players[cand.id].positions.starts = { ...(s.players[cand.id].positions.starts || {}), [target]: 4 };
    s.posNotes = null;
  });
  setLeft(40);
  CE.syncRosterCards([], clock.get());
  const notes = () => [...(S().inbox || []), ...(S().scheduledCards || [])].filter(c => String(c._rosterKey || '').startsWith('pos:notes:'));
  check('40 games left: no note yet', !notes().length);
  setLeft(24);
  CE.syncRosterCards([], clock.get());
  const n1 = notes().find(c => c._rosterKey.endsWith(':first'));
  console.log(`    “${n1?.subject}” (${n1?.sender}) — ${n1?.body?.replace(/\n/g, ' / ')}`);
  check('about 25 left: the first note, from the Bench Coach', !!n1 && n1.sender === (S().userTeam.coachingStaff?.benchCoach?.name || 'Bench Coach'));
  check(`…${cand.name}: 4 starts at ${target}, 6 more makes it official`, n1?.body.includes(`${cand.name} has 4 starts at ${target}; 6 more makes it official`));
  check(`…${util.name}: 6 starts at ${second}, more needed to keep it`, new RegExp(`${util.name} has 6 starts at ${second} and needs \\d+ more to keep it`).test(n1?.body || ''));
  check('…gender-neutral, no explainer', !GEN.test(n1?.body || '') && !/Compose tab/.test(n1?.body || ''));
  setLeft(10);
  CE.syncRosterCards([], clock.get());
  const n2 = notes().find(c => c._rosterKey.endsWith(':second'));
  console.log(`    “${n2?.subject}” — ${n2?.body?.replace(/\n/g, ' / ')}`);
  check('about 10 left: the second note', !!n2 && /10 games to go/.test(n2.body));
  CE.syncRosterCards([], clock.get());
  check('…each sent once', notes().length === 2);
  void regs;
}

// ── The season turn: the notice ────────────────────────────────
console.log('The season turn');
{
  const u = S().userTeam;
  const util = u.rosterIds.map(P).find(p => p && !['SP', 'RP'].includes(p.pos) && Pos.eligibleAt(p).length >= 2);
  const second = Pos.eligibleAt(util).find(x => x !== Pos.primaryPos(util));
  SM.mutate(s => { s.players[util.id].positions.starts = { [Pos.primaryPos(util)]: 100, [second]: 3 }; });
  let ch = null;
  SM.mutate(s => { ch = Pos.seasonTurn(s.players[util.id]); });
  CE.deliverPositionsTurnNotice([{ playerId: util.id, ...ch }], clock.get());
  const card = [...(S().inbox || []), ...(S().scheduledCards || [])].find(c => String(c._rosterKey || '').startsWith('pos:turn:'));
  console.log(`    “${card?.subject}” — ${card?.body?.replace(/\n/g, ' / ')}`);
  check(`${util.name} loses ${second}: the Bench Coach's notice says so`, !!card && card.body.includes(`${util.name} loses ${second}: 3 starts there`) && !Pos.canPlay(P(util.id), second));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
