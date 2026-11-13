// r165 §122.35 phase 3 — playing out of position. MOVE lists a hitter's eligible spots, then every
// fielding spot he isn't eligible at (marked, with how familiar he is). A placement the GM makes stays
// (the roster's tidy-up no longer undoes it), its starts count toward the ten, and the mark goes once
// he's eligible. On the field: each fielder out of position makes ground-ball errors likelier (less so
// with familiarity), and a non-catcher behind the plate draws more steals and allows passed balls.
//   node tools/harness/check-out-of-position.mjs [games]
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, gmMove } from '../../engine/GameEngine.js';
import { moveOptions, reconcileRoster, applyRosterMutation } from '../../engine/RosterEngine.js';
import { generatePlays, leagueNorms } from '../../engine/SimEngine.js';
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import * as Pos from '../../engine/Positions.js';
import * as Dev from '../../engine/DevelopmentEngine.js';
import { POSITION_RULES as R } from '../../data/constants.js';

const N = parseInt(process.argv[2] || '1200', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const DAY = 86_400_000;

seedRandom(97);
clock.set(Date.UTC(2026, 10, 13, 15));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get(), P = (id) => S().players[id];
const U = () => S().userTeam, slots = () => U().lineupSlots;

// ── MOVE ────────────────────────────────────────────────────────
console.log('MOVE: eligible spots first, then out of position');
const i1 = slots().findIndex(s => s.slot === '1B'), i3 = slots().findIndex(s => s.slot === '3B'), iC = slots().findIndex(s => s.slot === 'C');
const firstB = slots()[i1].playerId;
SM.mutate(s => { const p = s.players[firstB]; p.positions.primary = '1B'; p.positions.elig = ['1B']; p.pos = p.nativePos = '1B'; });
const opts = moveOptions(S(), firstB);
const elig = opts.filter(o => !o.oop), oop = opts.filter(o => o.oop);
console.log(`    ${P(firstB).name}: ${elig.map(o => o.label).join(', ')} | out of position: ${oop.map(o => `${o.label} (${o.detail})`).join(' · ')}`);
check('a first baseman: the eligible moves unmarked (DH, the bench)', elig.every(o => o.label === 'DH' || o.label === 'Bench'));
check('…every other fielding spot offered out of position, marked, "unfamiliar"', ['C', '2B', '3B', 'SS', 'OF'].every(x => oop.some(o => o.label === x)) && oop.every(o => /unfamiliar/.test(o.detail)) && !oop.some(o => o.label === 'DH'));
check('…listed after the eligible ones', opts.findIndex(o => o.oop) > opts.findIndex(o => !o.oop));

// ── The placement stays ────────────────────────────────────────
console.log('The GM\'s placement stays');
const third = slots()[i3].playerId;
const key3 = oop.find(o => o.label === '3B').key;
check('the GM moves the first baseman to 3B', gmMove(firstB, key3, clock.get()).ok && slots()[i3].playerId === firstB && slots()[i3].oop === true);
check(`…the third baseman moves to 1B if eligible there, else the bench (${P(third).name} → ${slots()[i1].playerId === third ? '1B' : 'bench'})`,
      Pos.canPlay(P(third), '1B') ? slots()[i1].playerId === third : !slots().some(s => s.playerId === third));
SM.mutate(s => applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: clock.get() })));
check('…the roster\'s tidy-up leaves it alone (a natural 3B on the bench or not)', slots()[i3].playerId === firstB && slots()[i3].oop === true);
let t = clock.get();
for (let k = 0; k < R.gainStarts; k++) { t += DAY; SM.mutate(s => { Dev.countGame(s, 'user', t, { kind: 'regular' }); applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: t })); }); }
check(`ten starts there: eligible at 3B, the mark gone ("${Pos.posLabel(P(firstB))}")`, Pos.canPlay(P(firstB), '3B') && slots()[i3].playerId === firstB && !slots()[i3].oop);
const after = moveOptions(S(), firstB);
check('…and 3B is no longer an out-of-position choice for him', !after.some(o => o.oop && o.label === '3B'));

// ── The defense summary ─────────────────────────────────────────
console.log('The defense');
const mk = (label, fam = {}) => { const p = { id: label + Math.random(), pos: label, nativePos: label }; p.positions = { ...Pos.seedPositions(p), fam }; return p; };
const ss = mk('SS'), c = mk('C'), of = mk('OF'), ofPracticedC = mk('OF', { C: 0.3 });
const team = (cid, sid) => [{ slot: 'C', playerId: cid }, { slot: 'SS', playerId: sid }];
const pl = Object.fromEntries([ss, c, of, ofPracticedC].map(p => [p.id, p]));
const dOk = Pos.defenseOf(team(c.id, ss.id), pl), dOf = Pos.defenseOf(team(of.id, ss.id), pl), dPr = Pos.defenseOf(team(ofPracticedC.id, ss.id), pl);
check(`everyone in position: no cost (errors ×${dOk.errorMult}, catcher ${dOk.catcher})`, dOk.errorMult === 1 && dOk.catcher === 0);
check(`an outfielder catching: errors ×${dOf.errorMult}, catcher exposure ${dOf.catcher}`, dOf.errorMult === 1 + R.oop.errorPer && dOf.catcher === 1);
check(`…practiced there (0.3): less (×${dPr.errorMult}, ${dPr.catcher})`, dPr.errorMult < dOf.errorMult && Math.abs(dPr.catcher - 0.7) < 1e-9);

// ── On the field ────────────────────────────────────────────────
console.log(`On the field: the same ${N} games, in position and out`);
const st0 = S();
const norms = leagueNorms([st0.userTeam, ...st0.leagueTeams], st0.players);
const T0 = st0.schedule.find(g => !g.isSpring)?.gameTime;
const run = (players, user, label) => {
  const r0 = { err: 0, sbA: 0, sb: 0, pb: 0, pbRuns: 0 };
  for (let i = 0; i < N; i++) {
    const opp = st0.leagueTeams[i % st0.leagueTeams.length];
    const g = { isHome: i % 2 === 0, gameTime: T0 + i * DAY, weather: null, fieldCondition: null };
    const r = generatePlays(g, user, opp, players, { phase: st0.phase, isSpring: false, norms, rand: dice('check-oop', i), injuryYear: baseballYear(st0) });
    for (const p of r.plays) {
      const theirs = (id) => id && players[id]?.teamId !== 'user';
      if (p.type === 'error' && theirs(p.batterId)) r0.err++;
      if ((p.type === 'stolen_base' || p.type === 'caught_stealing') && theirs(Object.keys(p._statDeltas || {})[0])) { r0.sbA++; if (p.type === 'stolen_base') r0.sb++; }
      if (p.type === 'passed_ball' && players[p.pitcherId]?.teamId === 'user') { r0.pb++; r0.pbRuns += p.runs || 0; }
    }
  }
  const f = (x) => (x / N).toFixed(3);
  console.log(`    ${label.padEnd(16)} errors ${f(r0.err)}  steal tries ${f(r0.sbA)}  steals ${f(r0.sb)}  passed balls ${f(r0.pb)} (${r0.pbRuns} runs)`);
  return r0;
};
// in position: the club as built; out: the catcher and the shortstop swapped with outfielders (never played there)
const base = structuredClone(S());
const iSS = base.userTeam.lineupSlots.findIndex(s => s.slot === 'SS');
const iOF = base.userTeam.lineupSlots.findIndex(s => s.slot === 'OF');
const iOF2 = base.userTeam.lineupSlots.findIndex((s, k) => s.slot === 'OF' && k !== iOF);
const outSt = structuredClone(base);
const L = outSt.userTeam.lineupSlots;
[L[iC].playerId, L[iOF].playerId] = [L[iOF].playerId, L[iC].playerId];
[L[iSS].playerId, L[iOF2].playerId] = [L[iOF2].playerId, L[iSS].playerId];
for (const k of [iC, iOF, iSS, iOF2]) { const p = outSt.players[L[k].playerId]; if (p?.positions) p.positions.fam = {}; }
seedRandom(5); const inPos = run(base.players, base.userTeam, 'in position');
seedRandom(5); const outPos = run(outSt.players, outSt.userTeam, 'out of position');
check(`more errors behind our pitchers (${(inPos.err / N).toFixed(2)} → ${(outPos.err / N).toFixed(2)} a game)`, outPos.err > inPos.err * 1.3);
check(`more steal attempts against a non-catcher (${(inPos.sbA / N).toFixed(2)} → ${(outPos.sbA / N).toFixed(2)})`, outPos.sbA > inPos.sbA * 1.2);
check(`…and a better success rate (${(inPos.sb / Math.max(1, inPos.sbA)).toFixed(2)} → ${(outPos.sb / Math.max(1, outPos.sbA)).toFixed(2)})`, outPos.sb / Math.max(1, outPos.sbA) > inPos.sb / Math.max(1, inPos.sbA));
check(`passed balls only with a non-catcher (${inPos.pb} → ${outPos.pb}, ${outPos.pbRuns} runs scored on them)`, inPos.pb === 0 && outPos.pb > N * 0.05);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
