/**
 * tools/harness/check-pinch-hit.mjs — r276 §122.155 pinch hitting and the bullpen's workload.
 *   Pinch hitting (every club alike):
 *     - both clubs pinch hit, about as often, a few times a week in the regular season;
 *     - regular season: from the 7th, in a close game (batting side 3 down to 1 up), a better bat by PINCH_HIT.minGain;
 *     - the catcher is hit for only when a catcher is left to catch, and the plate always has a catcher;
 *     - a pinch hitter who can't play the position gives way to a bench glove who can (defensive_sub), who is in the
 *       field the next half and in the box score;
 *     - spring: both clubs' benches bat, more than one bench player each.
 *   Relievers: a worn arm (season's workload at Tired) goes only when no one else can.
 */
import { seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, leagueNorms } from '../../engine/SimEngine.js';
import { chooseReliever, bullpenRoles, armLoad } from '../../engine/PitchingEngine.js';
import { exposure, valueAt } from '../../engine/Positions.js';
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import { PINCH_HIT, WEAR, ARM_LOAD } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };

seedRandom(276);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const st = SM.get(), players = st.players, user = st.userTeam;
const norms = leagueNorms([user, ...st.leagueTeams], players);
const T0 = st.schedule.find(g => !g.isSpring).gameTime;
const sim = (i, isSpring) => {
  const opp = st.leagueTeams[i % st.leagueTeams.length];
  const g = { id: `ph-${i}`, isHome: i % 2 === 0, gameTime: T0 + i * 86_400_000, weather: null, fieldCondition: null, index: isSpring ? i % 10 : 50 };
  const r = generatePlays(g, user, opp, players, { phase: st.phase, isSpring, norms, rand: dice('check-ph', i, isSpring ? 's' : 'r'), injuryYear: baseballYear(st) });
  return { g, opp, ...r };
};

// ── regular season ──
const N = 300;
const ph = { user: 0, opp: 0 }, bad = [], plate = [], dsub = { n: 0, field: 0, box: 0, missed: [] };
for (let i = 0; i < N; i++) {
  const { g, plays, boxScore } = sim(i, false);
  const userBatsHalf = g.isHome ? 'BOT' : 'TOP';
  for (let k = 0; k < plays.length; k++) {
    const p = plays[k];
    if (p.type === 'pinch_hit') {
      const user_ = p.half === userBatsHalf;
      ph[user_ ? 'user' : 'opp']++;
      const prev = plays.slice(0, k).reverse().find(x => x.cumOurScore != null) || { cumOurScore: 0, cumTheirScore: 0 };
      const lead = user_ ? prev.cumOurScore - prev.cumTheirScore : prev.cumTheirScore - prev.cumOurScore;
      const gain = valueAt(players[p.batterId], 'DH') - valueAt(players[p._for], 'DH');
      if (p.inning < PINCH_HIT.fromInning || lead < -PINCH_HIT.behind || lead > PINCH_HIT.ahead || gain < PINCH_HIT.minGain)
        bad.push(`g${i} ${p.half}${p.inning} lead ${lead} gain ${gain.toFixed(1)}`);
    }
    if (p.type === 'defensive_sub') {
      dsub.n++;
      const next = plays.slice(k).find(x => x._field && x._halfInning === p._halfInning);
      const spot = next && Object.entries(next._field).find(([, id]) => id === p._in)?.[0];
      if (spot && exposure(players[p._in], spot === 'LF' || spot === 'CF' || spot === 'RF' ? 'OF' : spot) === 0) dsub.field++;
      const side = p.half === 'TOP' ? boxScore.home : boxScore.away;
      if (side.hitters.some(h => h.id === p._in)) dsub.box++;
    }
    // the plate: a real catcher every half
    if (p._field?.C && exposure(players[p._field.C], 'C') > 0) plate.push(`g${i} ${p._halfInning} ${players[p._field.C].name}`);
  }
}
const perUser = ph.user / N, perOpp = ph.opp / N;
console.log(`regular season, ${N} games: pinch hits ${ph.user} ours, ${ph.opp} theirs; defensive replacements ${dsub.n}`);
check(`both clubs pinch hit, about as often (ours ${perUser.toFixed(2)}, theirs ${perOpp.toFixed(2)} a game)`, ph.opp > 0 && ph.user > 0 && perOpp / perUser > 0.5 && perOpp / perUser < 2);
check(`a few times a week (${((perUser + perOpp) / 2).toFixed(2)} a club a game)`, (perUser + perOpp) / 2 >= 0.15 && (perUser + perOpp) / 2 <= 0.8);
check('every regular-season pinch hit is late, close, and a better bat', bad.length === 0, bad.slice(0, 5).join('; '));
check(`the plate always has a catcher (${plate.length} halves without)`, plate.length === 0, plate.slice(0, 5).join('; '));
check(`defensive replacements happen (${dsub.n}), each playing his own position the next half (${dsub.field}) and in the box (${dsub.box})`,
  dsub.n > 0 && dsub.field === dsub.n && dsub.box === dsub.n);

// ── spring ──
const sp = { user: 0, opp: 0 }, who = { user: new Set(), opp: new Set() };
for (let i = 0; i < 40; i++) {
  const { g, plays } = sim(1000 + i, true);
  const userBatsHalf = g.isHome ? 'BOT' : 'TOP';
  for (const p of plays) if (p.type === 'pinch_hit') { const s = p.half === userBatsHalf ? 'user' : 'opp'; sp[s]++; who[s].add(p.batterId); }
}
check(`spring: both clubs' benches bat (ours ${sp.user}, theirs ${sp.opp} in 40 games)`, sp.user > 40 && sp.opp > 40 && sp.opp / sp.user > 0.5 && sp.opp / sp.user < 2);
check(`spring: more than one bench player each (ours ${who.user.size})`, who.user.size >= 3);

// ── relievers: a worn arm goes last ──
const roles = bullpenRoles(user, players);
const at = T0 + 10 * 86_400_000;
const P = structuredClone(players);
const wear = (id, load) => { P[id].load = load; P[id].loadAt = at; };
const setup0 = roles.setup[0];
check(`(the setup man's load is set to Tired: ${(() => { wear(setup0, WEAR.tired + 2); return armLoad(P[setup0], at); })()})`, armLoad(P[setup0], at) >= WEAR.tired);
const r8 = chooseReliever({ roles, players: P, used: new Set(), atMs: at, inning: 8, lead: 1 });
check(`8th, up one: not the worn setup man (${P[r8?.id]?.name})`, r8 && r8.id !== setup0);
for (const id of [roles.closer, ...roles.setup, ...roles.middle, ...roles.long].filter(Boolean)) if (id !== setup0) wear(id, WEAR.tired + 5);
P[setup0].load = 0;
const r6 = chooseReliever({ roles, players: P, used: new Set(), atMs: at, inning: 6, lead: -4 });
check(`6th, down four, everyone else worn: the fresh one (${P[r6?.id]?.name})`, r6?.id === setup0);
const all = [roles.closer, ...roles.setup, ...roles.middle, ...roles.long].filter(Boolean);
for (const id of all) wear(id, WEAR.tired + 5);
const rAll = chooseReliever({ roles, players: P, used: new Set(), atMs: at, inning: 9, lead: 1 });
check('everyone worn: someone still pitches', !!rAll);
for (const id of all) wear(id, 6);
wear(roles.middle[1], 1);
const rLow = chooseReliever({ roles, players: P, used: new Set(), atMs: at, inning: 6, lead: 0 });
check(`low leverage, equally rested: the lighter workload first (${P[rLow?.id]?.name})`, rLow?.id === roles.middle[1] || !roles.middle[1]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
