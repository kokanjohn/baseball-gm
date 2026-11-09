// §122.9 — the league's past, untested ratings, diamonds in the rough, Impact.
//   node tools/harness/check-diamonds.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { computeAge, baseballYear } from '../../engine/PlayerFactory.js';
import { lastSeasonIMP, computePlayerIMP } from '../../engine/IMPEngine.js';
import { isDiamond, worthOf, trueOVR, cpuView, exposeRatings, playingRating, markAvailable } from '../../engine/Diamonds.js';
import { cpuFreeAgentLook } from '../../engine/TransactionEngine.js';
import { PLAYER_ORIGIN, DIAMOND } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};

seedRandom(4);
clock.set(clock.real());   // the opening pool is stamped "now": a real now, so its dates sit before the season
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const s = SM.get(), year = baseballYear(s), L = s.leagueTalentOffset || 0, now = clock.get();
const rostered = [s.userTeam, ...s.leagueTeams].flatMap(t => t.rosterIds).map(id => s.players[id]);
const pool = s.freeAgentPool.map(id => s.players[id]);
const age = (p) => computeAge(p.dob, year);

console.log('The league\'s past');
const vets = rostered.filter(p => age(p) >= 32);
check('every rostered veteran (32+) has a record', vets.every(p => (p.seasonLog || []).length >= 3),
  vets.filter(p => (p.seasonLog || []).length < 3).map(p => `${p.name} ${age(p)}`).join(', '));
check('no season before age 20', [...rostered, ...pool].every(p => (p.seasonLog || []).every(e => computeAge(p.dob, e.year) >= 20)));
check('seasons come before this one, oldest first', [...rostered, ...pool].every(p => (p.seasonLog || []).every((e, i, a) => e.year < year && e.past && (!i || a[i - 1].year < e.year))));
check('career totals add up the seasons', [...rostered, ...pool].every(p => {
  const sum = (p.seasonLog || []).reduce((a, e) => a + (e.stats.g || 0), 0);
  return (p.careerStats?.g || 0) === sum && (p.careerStats?.seasons || 0) === (p.seasonLog || []).length;
}));
const withRecord = pool.filter(p => (p.seasonLog || []).length).length;
check('most free agents have a record (≥ 65%)', withRecord / pool.length >= 0.65, `${withRecord}/${pool.length}`);
check('a free agent with no record says why (rookie / overseas / independent)',
  pool.filter(p => !(p.seasonLog || []).length).every(p => [PLAYER_ORIGIN.ROOKIE, PLAYER_ORIGIN.OVERSEAS, PLAYER_ORIGIN.INDEPENDENT].includes(p.origin)));
const intl = pool.filter(p => p.origin === PLAYER_ORIGIN.OVERSEAS);
check('players from abroad are older than rookies, with no league record', intl.length > 0 && intl.every(p => age(p) >= 23 && !(p.seasonLog || []).length));
check('last season\'s Impact on opening day for most rostered players (≥ 85%)',
  rostered.filter(p => lastSeasonIMP(p) != null).length / rostered.length >= 0.85);

console.log('Untested ratings');
const untested = [...rostered, ...pool].filter(p => p.origin && p.origin !== PLAYER_ORIGIN.LEAGUE);
check('veterans\' ratings are true (no gap)', [...rostered, ...pool].filter(p => p.origin === PLAYER_ORIGIN.LEAGUE).every(p => !p._ratingGap));
check('most untested players\' estimates are off somewhere', untested.filter(p => p._ratingGap).length / untested.length >= 0.6);
const u = structuredClone(untested.find(p => p._ratingGap && Object.values(p._ratingGap).some(g => Math.abs(g) >= 3)));
const k = Object.keys(u._ratingGap).find(x => Math.abs(u._ratingGap[x]) >= 3);
const truth = playingRating(u, k), shown0 = u.subRatings[k];
check('the games play the truth', truth === shown0 + u._ratingGap[k]);
exposeRatings(u, 150);
const mid = u.subRatings[k];
check('playing moves the estimate toward the truth', Math.abs(truth - mid) < Math.abs(truth - shown0) && playingRating(u, k) === truth);
exposeRatings(u, 3000);
check('a full career shows him as he is', u.subRatings[k] === truth && !u._ratingGap);

console.log('Diamonds in the rough');
const D = pool.filter(p => isDiamond(p, L));
check(`a handful in the opening pool (5–20): ${D.length}`, D.length >= 5 && D.length <= 20);
check('both kinds: proven role fits and unproven upside',
  D.some(p => p.origin === PLAYER_ORIGIN.LEAGUE) && D.some(p => p.origin !== PLAYER_ORIGIN.LEAGUE));
check('each worth DIAMOND.edge+ over his rating', D.every(p => worthOf(p) - p.ovr >= DIAMOND.edge));
check('each has a day word gets around, 10–30 days out', D.every(p => (p._buzzAt - now) / 86_400_000 >= 9.9 && (p._buzzAt - now) / 86_400_000 <= 30.1));
check('nobody else has one', pool.filter(p => !isDiamond(p, L)).every(p => !Number.isFinite(p._buzzAt)));
const d = D.find(p => worthOf(p) - p.ovr >= DIAMOND.edge);
check('CPU clubs see his rating before word gets around', cpuView(d, d._buzzAt - 1) === d.ovr);
check('…and his worth after', cpuView(d, d._buzzAt) === worthOf(d));

// The race: the same three weeks of CPU looks (one upgrade a club a day, the opening flurry
// first), with and without word getting around. Word is what gets the hidden ones signed.
const DAY = 86_400_000;
const lows = D.filter(p => p.ovr - L <= 43);
const signedOver = (quiet) => SM.speculate(() => {
  if (quiet) SM.mutate(dr => { for (const p of lows) delete dr.players[p.id]._buzzAt; });
  const from = Math.min(...lows.map(p => p._buzzAt)) - 10 * DAY, to = Math.max(...lows.map(p => p._buzzAt)) + 7 * DAY;
  for (let t = from; t <= to; t += DAY) SM.mutate(dr => { cpuFreeAgentLook(dr, t); });
  return lows.filter(p => SM.get().players[p.id].teamId).length;
});
const quietly = signedOver(true), word = signedOver(false);
check(`hidden diamonds (rated ≤ 43 over the level): word getting around gets them signed (${word} of ${lows.length}, against ${quietly} without it)`,
  lows.length > 0 && word > quietly);
const rel = { ...pool.find(p => p.origin === PLAYER_ORIGIN.LEAGUE && !isDiamond(p, L)) };
markAvailable(rel, now, () => 0.5, L);
check('a released ordinary player gets no date', !Number.isFinite(rel._buzzAt));

console.log('Impact');
const reg = rostered.filter(p => (p.seasonLog || []).at(-1)?.stats?.ab >= 400);
const imps = reg.map(p => lastSeasonIMP(p)).sort((a, b) => a - b);
check(`regulars' last-season Impact spans about −4 to +7 (${imps[0]} … ${imps.at(-1)})`, imps[0] > -6 && imps.at(-1) < 9 && imps.at(-1) > 2);
const pit = rostered.filter(p => p.pos === 'SP' && (p.seasonLog || []).at(-1)?.stats?.ip >= 100).map(p => lastSeasonIMP(p));
check(`starters on the same scale (${Math.min(...pit)} … ${Math.max(...pit)})`, Math.min(...pit) > -8 && Math.max(...pit) < 9);
const p0 = structuredClone(reg[0]);
p0._impGameLog = [{ gameIndex: 0, atMs: 1000, stats: { ab: 20, h: 8, tb: 14, bb: 2, k: 3, hr: 1 } },
                  { gameIndex: 1, atMs: 1000 + 10 * 86_400_000, stats: { ab: 4, h: 0, tb: 0, k: 2 } }];
const w = computePlayerIMP(p0, 1, 1000 + 10 * 86_400_000);
check('the windows are days: a game 10 days ago is out of the 7-day window', w.imp7 == null && w.imp15 != null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
