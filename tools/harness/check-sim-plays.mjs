/**
 * tools/harness/check-sim-plays.mjs — r228 §122.107 groundouts, wild pitches, intentional walks (our games and the
 * league's, the same sim), against MLB:
 *   - a runner on third, not forced, fewer than two outs, a groundout: scores about half to two-thirds of the time,
 *     the right side easiest, the third baseman and the pitcher hardest; never left standing on third after scoring;
 *   - a runner on second alone takes third on a groundout mostly on the right side;
 *   - wild pitches about 0.3 a team-game, by the pitcher's control; runs on them;
 *   - intentional walks about one every six team-games, mostly late; mostly with first base open and a runner in
 *     scoring position (r229: the other base states allowed, rare); in the words.
 */
import { seedRandom } from '../../tools/harness/shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, leagueNorms, accumulateBox } from '../../engine/SimEngine.js';
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
seedRandom(228);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const st = SM.get(); const norms = leagueNorms([st.userTeam, ...st.leagueTeams], st.players);
const T0 = st.schedule.find(g => !g.isSpring).gameTime;
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const N = 600;
const c = { phantom: 0, ibbBy: {}, wpCtl: [[0, 0], [0, 0]], wp: 0, wpRuns: 0, ibb: 0, ibbLate: 0, go3: 0, go3s: 0, go2: 0, go2a: 0, goBy: {}, runs: 0, bb: 0, k: 0, h: 0 };
for (let i = 0; i < N; i++) {
  const lg = i % 2 === 1;
  const home = lg ? st.leagueTeams[i % st.leagueTeams.length] : st.userTeam, away = st.leagueTeams[(i + 3) % st.leagueTeams.length];
  const g = { id: `r-${i}`, isHome: true, gameTime: T0 + i * 864e5, weather: null, fieldCondition: null };
  const plays = generatePlays(g, home, away, st.players, { phase: st.phase, isSpring: false, norms, rand: dice('r228', i), injuryYear: baseballYear(st) }).plays;
  let pb = { first: null, second: null, third: null }, po = 0, ph = null;
  for (const p of plays) {
    if (p._halfInning !== ph) { pb = { first: null, second: null, third: null }; po = 0; ph = p._halfInning; }
    if (p.type === 'wild_pitch') { c.wp++; c.wpRuns += p.runs; }
    if (p.type === 'walk' && /intentionally/.test(p.description)) { c.ibb++; if (p.inning >= 7) c.ibbLate++; const k = pb.first && pb.second && pb.third ? 'loaded' : !pb.first && !pb.second && !pb.third ? 'empty' : pb.first ? 'firstTaken' : 'usual'; c.ibbBy[k] = (c.ibbBy[k] || 0) + 1; }
    // (a runner who scored isn't still on a base)
    if (p.runs > 0 && p._basesAfter && Object.values(p._basesAfter).some(id => id && Object.values(p._statDeltas || {}).flat().length && (p._statDeltas[id] || []).some(d => d.stat === 'r'))) c.phantom++;
    // wild pitches by control: each plate appearance with someone on, the pitcher's control
    if (p.batterId && (pb.first || pb.second || pb.third) && p.pitcherId) { const ctl = st.players[p.pitcherId]?.subRatings?.control ?? 50; c.wpCtl[ctl >= 55 ? 1 : 0][0]++; }
    if (p.type === 'wild_pitch') { const ctl = st.players[p.pitcherId]?.subRatings?.control ?? 50; c.wpCtl[ctl >= 55 ? 1 : 0][1]++; }
    if (p.type === 'walk') c.bb++; if (p.type === 'strikeout') c.k++; if (['single','double','triple','hr'].includes(p.type)) c.h++;
    if (p.type === 'groundout' && po < 2) {
      const at = p._ball?.at || '?';
      if (pb.third && !(pb.first && pb.second)) {   // not forced home
        c.go3++; const s = !Object.values(p._basesAfter || {}).includes(pb.third) && p.runs > 0; if (s) c.go3s++;
        (c.goBy[at] ||= [0, 0])[0]++; if (s) c.goBy[at][1]++;
      }
      if (pb.second && !pb.first && !pb.third) { c.go2++; if (p._basesAfter?.third === pb.second) c.go2a++; }
    }
    if (p._basesAfter) pb = p._basesAfter; if (p.outsAfter != null) po = p.outsAfter;
  }
  const end = plays.filter(p => p.cumOurScore != null).pop(); c.runs += end.cumOurScore + end.cumTheirScore;
}
const tg = N * 2, r = (a, b) => (b ? a / b : 0), pc = (a, b) => b ? `${Math.round(a / b * 100)}%` : '—';
console.log(`    ${N} games (half ours, half the league's): runs a team-game ${(c.runs / tg).toFixed(2)}, walks ${(c.bb / tg).toFixed(2)}, strikeouts ${(c.k / tg).toFixed(2)}, hits ${(c.h / tg).toFixed(2)}`);
check(`no runner scores and stays on base (${c.phantom})`, c.phantom === 0);
check(`groundout, a runner on third not forced, fewer than two outs: scores ${pc(c.go3s, c.go3)} (about half to two-thirds)`, c.go3 > 150 && r(c.go3s, c.go3) > 0.45 && r(c.go3s, c.go3) < 0.68);
const side = (k) => r(c.goBy[k]?.[1] || 0, c.goBy[k]?.[0] || 0);
check(`…the right side easiest, third and the pitcher hardest (1B/2B ${pc((c.goBy['1B']?.[1] || 0) + (c.goBy['2B']?.[1] || 0), (c.goBy['1B']?.[0] || 0) + (c.goBy['2B']?.[0] || 0))}, SS ${pc(c.goBy.SS?.[1] || 0, c.goBy.SS?.[0] || 0)}, 3B ${pc(c.goBy['3B']?.[1] || 0, c.goBy['3B']?.[0] || 0)})`,
  Math.min(side('1B'), side('2B')) > side('3B') && side('SS') > side('3B'));
check(`groundout, a runner on second alone takes third ${pc(c.go2a, c.go2)} (mostly the right side)`, r(c.go2a, c.go2) > 0.3 && r(c.go2a, c.go2) < 0.65);
check(`wild pitches ${(c.wp / tg).toFixed(2)} a team-game (MLB about 0.3)`, c.wp / tg > 0.2 && c.wp / tg < 0.4);
check(`…more from pitchers with less control (control under 55: ${(r(c.wpCtl[0][1], c.wpCtl[0][0]) * 100).toFixed(2)}%; 55+: ${(r(c.wpCtl[1][1], c.wpCtl[1][0]) * 100).toFixed(2)}% of chances)`, r(c.wpCtl[0][1], c.wpCtl[0][0]) > r(c.wpCtl[1][1], c.wpCtl[1][0]));
check(`…runs score on them (${c.wpRuns})`, c.wpRuns > 0);
check(`intentional walks ${(c.ibb / tg).toFixed(2)} a team-game (MLB about 0.17)`, c.ibb / tg > 0.1 && c.ibb / tg < 0.26);
check(`…mostly late (${pc(c.ibbLate, c.ibb)} in the 7th on)`, r(c.ibbLate, c.ibb) > 0.5);
// (r229 §122.108 any base state is allowed — MLB has no rule against it — weighted by how often managers choose it)
check(`…mostly with first base open and a runner on second or third (${pc(c.ibbBy.usual || 0, c.ibb)}; first taken ${c.ibbBy.firstTaken || 0}, bases empty ${c.ibbBy.empty || 0}, loaded ${c.ibbBy.loaded || 0})`,
  r(c.ibbBy.usual || 0, c.ibb) >= 0.75 && (c.ibbBy.loaded || 0) <= 1);
console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
