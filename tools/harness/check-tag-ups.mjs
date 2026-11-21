/**
 * tools/harness/check-tag-ups.mjs — r227 §122.106 tag-ups on a caught fly, realistic.
 *   - none on the inning's third out; none on an infield pop (or the catcher's);
 *   - runner on third, fewer than two outs, a catchable outfield fly: sent about as often as in MLB (~78%), safe on
 *     about 97% of sends; deeper flies sent more, faster runners sent more;
 *   - runner on second to an open third: mostly on flies to center and right (MLB ~12/47/55% with nobody out);
 *   - first to second only on the deepest flies;
 *   - the running game: Run More sends more than Run Normally, Run Less fewer.
 */
import { seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, leagueNorms } from '../../engine/SimEngine.js';
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';
import { playingRating } from '../../engine/Diamonds.js';
seedRandom(227);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const st = SM.get(); const norms = leagueNorms([st.userTeam, ...st.leagueTeams], st.players);
const T0 = st.schedule.find(g => !g.isSpring).gameTime;
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const N = 500;
const measure = (runStyleKey) => {
SM.mutate(s => { s.userTeam.strategy = { ...(s.userTeam.strategy || {}), run: runStyleKey }; for (const t of s.leagueTeams) t.strategy = { ...(t.strategy || {}), run: runStyleKey }; });
const c = { deep: [0, 0], shallow: [0, 0], mid: [], r3: 0, sent: 0, safe: 0, out3rd: 0, sf: 0, pop3: 0, popScored: 0, r2: 0, r2go: 0, r2out: 0, byF: { LF: [0, 0], CF: [0, 0], RF: [0, 0] }, r1: 0, r1go: 0, runs: 0, sfThirdOut: 0 };
for (let i = 0; i < N; i++) {
  const opp = st.leagueTeams[i % st.leagueTeams.length];
  const g = { id: `t-${i}`, isHome: i % 2 === 0, gameTime: T0 + i * 864e5, weather: null, fieldCondition: null };
  const plays = generatePlays(g, st.userTeam, opp, st.players, { phase: st.phase, isSpring: false, norms, rand: dice('tag', i), injuryYear: baseballYear(st) }).plays;
  let pb = { first: null, second: null, third: null }, po = 0, ph = null;
  for (const p of plays) {
    if (p._halfInning !== ph) { pb = { first: null, second: null, third: null }; po = 0; ph = p._halfInning; }
    const caughtOF = (p.type === 'flyout' || p.type === 'sac_fly') && p._ball && ['LF', 'CF', 'RF'].includes(p._ball.at);
    if (p.type === 'sac_fly' && po >= 2) c.sfThirdOut++;
    if (p.type === 'sac_fly') c.sf++;
    if (caughtOF && po < 2 && pb.third) {
      c.r3++;
      const outHome = p._out?.id === pb.third && p._out.base === 'home';
      const went = p.type === 'sac_fly' || outHome;
      if (went) c.sent++;
      const b = p._ball.dist >= 300 ? c.deep : p._ball.dist < 260 ? c.shallow : null; if (b) { b[0]++; if (went) b[1]++; }
      if (p._ball.dist >= 240 && p._ball.dist < 300) c.mid.push([playingRating(st.players[pb.third], 'speed') ?? 50, went]);
      if (p.type === 'sac_fly') c.safe++;
    }
    if ((p.type === 'flyout' || p.type === 'sac_fly') && p._ball && !['LF', 'CF', 'RF'].includes(p._ball.at) && pb.third && po < 2) { c.pop3++; if (p.type === 'sac_fly') c.popScored++; }
    if (caughtOF && po < 2 && pb.second && !pb.third && p.outsAfter < 3) {
      c.r2++; c.byF[p._ball.at][0]++;
      const moved = (p._basesAfter?.third === pb.second) || (p._out?.id === pb.second);
      if (moved) { c.r2go++; c.byF[p._ball.at][1]++; if (p._out?.id === pb.second) c.r2out++; }
    }
    if (caughtOF && po < 2 && pb.first && !pb.second && !pb.third && p.outsAfter < 3) { c.r1++; if (p._basesAfter?.second === pb.first || p._out?.id === pb.first) c.r1go++; }
    if (p._basesAfter) pb = p._basesAfter; if (p.outsAfter != null) po = p.outsAfter;
  }
  const end = plays.filter(p => p.cumOurScore != null).pop(); c.runs += end.cumOurScore + end.cumTheirScore;
}
return c;
};
const pc = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
const r = (a, b) => (b ? a / b : 0);
const c = measure('normal');
console.log(`    ${N} games: runs a team-game ${(c.runs / N / 2).toFixed(2)}, sacrifice flies a team-game ${(c.sf / N / 2).toFixed(3)}`);
check(`no run scores on the inning's third out (${c.sfThirdOut})`, c.sfThirdOut === 0);
check(`no runner scores on an infield pop (${c.popScored} of ${c.pop3})`, c.pop3 > 20 && c.popScored === 0);
check(`runner on third, a catchable outfield fly: sent ${pc(c.sent, c.r3)} (MLB about 78%)`, c.r3 > 120 && r(c.sent, c.r3) > 0.70 && r(c.sent, c.r3) < 0.88);
check(`…safe on ${pc(c.safe, c.sent)} of sends (MLB about 97%)`, r(c.safe, c.sent) > 0.93 && r(c.safe, c.sent) <= 0.995);
check(`…deeper flies sent more (300+ feet ${pc(c.deep[1], c.deep[0])}; under 260 ${pc(c.shallow[1], c.shallow[0])})`, r(c.deep[1], c.deep[0]) > 0.9 && r(c.shallow[1], c.shallow[0]) < 0.6);
const mids = [...c.mid].sort((a, b) => a[0] - b[0]), half = Math.floor(mids.length / 2);
const slowR = r(mids.slice(0, half).filter(x => x[1]).length, half), fastR = r(mids.slice(half).filter(x => x[1]).length, mids.length - half);
check(`…faster runners sent more on the middle flies, 240–300 feet (faster half ${Math.round(fastR * 100)}%, slower half ${Math.round(slowR * 100)}% of ${mids.length})`, mids.length >= 40 && fastR > slowR);
const L = r(c.byF.LF[1], c.byF.LF[0]), C = r(c.byF.CF[1], c.byF.CF[0]), R = r(c.byF.RF[1], c.byF.RF[0]);
check(`runner on second to an open third: LF ${pc(c.byF.LF[1], c.byF.LF[0])}, CF ${pc(c.byF.CF[1], c.byF.CF[0])}, RF ${pc(c.byF.RF[1], c.byF.RF[0])} (MLB about 12/47/55%)`, L < 0.25 && C > 0.35 && C < 0.62 && R > 0.42 && R < 0.68 && L < C && C <= R + 0.05);
check(`first to second: rare (${pc(c.r1go, c.r1)})`, r(c.r1go, c.r1) > 0.01 && r(c.r1go, c.r1) < 0.15);
const more = measure('more'), less = measure('less');
check(`the running game: Run More ${pc(more.sent, more.r3)} · Normally ${pc(c.sent, c.r3)} · Run Less ${pc(less.sent, less.r3)} sent from third`, r(more.sent, more.r3) > r(c.sent, c.r3) && r(c.sent, c.r3) > r(less.sent, less.r3));
console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
