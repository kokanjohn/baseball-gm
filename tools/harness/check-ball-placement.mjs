/**
 * tools/harness/check-ball-placement.mjs — r226 §122.105 where the ball went, saved on each play (for the Live View).
 *   - every ball in play has a spot; strikeouts, walks and hit batters don't;
 *   - the spot agrees with what the sim decided: the fielder (their position, and which outfielder — the same as
 *     "in left/center/right" in the play's words), on the ground or in the air, the depth the outcome needs
 *     (grounders in the infield, doubles and triples deep, flyouts catchable, sacrifice flies deep, home runs over
 *     the fence), fair;
 *   - the gems and their direction match the words; the error's kind; a runner thrown out and where (the words);
 *     the double play's relay (the words);
 *   - the same game, the same spots; home runs to all fields.
 * (r226: no game played out differently — sim-season and multi-season identical before and after. r227: a caught fly's
 *  depth now decides the tag-ups — check-tag-ups.)
 */
import { seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { generatePlays, leagueNorms, fenceAt } from '../../engine/SimEngine.js';
import { dice } from '../../engine/Dice.js';
import { baseballYear } from '../../engine/PlayerFactory.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };

seedRandom(226);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const st = SM.get(), players = st.players, user = st.userTeam;
const norms = leagueNorms([user, ...st.leagueTeams], players);
const T0 = st.schedule.find(g => !g.isSpring).gameTime;
const N = 150;
const sim = (i) => {
  const opp = st.leagueTeams[i % st.leagueTeams.length];
  const g = { id: `chk-${i}`, isHome: i % 2 === 0, gameTime: T0 + i * 86_400_000, weather: null, fieldCondition: null };
  return { opp, g, plays: generatePlays(g, user, opp, players, { phase: st.phase, isSpring: false, norms, rand: dice('check-ball', i), injuryYear: baseballYear(st) }).plays };
};

const IN_PLAY = new Set(['single', 'double', 'triple', 'hr', 'groundout', 'flyout', 'double_play', 'fielders_choice', 'sac_fly', 'sac_bunt', 'error']);
const NO_BALL = new Set(['strikeout', 'walk', 'hbp']);
const OF = new Set(['LF', 'CF', 'RF']);
const WHERE = { LF: 'in left', CF: 'in center', RF: 'in right' };
const all = [];
for (let i = 0; i < N; i++) for (const p of sim(i).plays) all.push(p);
const bip = all.filter(p => IN_PLAY.has(p.type));
console.log(`${N} games, ${all.length} plays, ${bip.length} balls in play`);

const bad = (name, xs, fmt = (p) => `${p.type} ${JSON.stringify(p._ball)} — ${p.description}`) =>
  check(`${name}${xs.length ? ` (${xs.length} wrong)` : ''}`, xs.length === 0, xs.slice(0, 3).map(fmt).join('\n      '));

bad('every ball in play has a spot', bip.filter(p => !p._ball));
bad('no spot on a strikeout, a walk or a hit batter', all.filter(p => NO_BALL.has(p.type) && p._ball));
bad('fair: between the lines', bip.filter(p => p._ball && Math.abs(p._ball.angle) > 44));

// the fielder
const posOf = (id) => players[id]?.pos;
bad('a fielder saved: the spot is theirs (an outfielder in the outfield, an infielder at their position)', bip.filter(p => p._fielderId && p._ball && p._ball.at && p.type !== 'hr'
  && (OF.has(p._ball.at) ? !(['LF', 'CF', 'RF', 'OF'].includes(posOf(p._fielderId)) || p._ball.flight === 'ground' && p.type === 'single') && !players[p._fielderId] : false)));
bad('which outfielder: the same as the words ("in left/center/right")', bip.filter(p => p._ball && OF.has(p._ball.at) && p._fielderId
  && /\b(in left|in center|in right)\b/.test(p.description) && !p.description.includes(WHERE[p._ball.at])));

// the depth the outcome needs
const fence = (b) => fenceAt(b.angle);
bad('home runs: over the fence, by 8–55 feet', bip.filter(p => p.type === 'hr' && !(p._ball.dist > fence(p._ball._ ?? p._ball) && p._ball.dist <= fence(p._ball) + 56)));
bad('nothing else leaves the park', bip.filter(p => p.type !== 'hr' && p._ball && p._ball.dist >= fence(p._ball)));
bad('grounders fielded in the infield (outs, double plays, fielder\'s choices): within 165 feet', bip.filter(p => ['groundout', 'double_play', 'fielders_choice'].includes(p.type) && p._ball.flight === 'ground' && p._ball.dist > 165));
bad('doubles and triples: deep (beyond 260 feet)', bip.filter(p => ['double', 'triple'].includes(p.type) && p._ball.dist < 260));
bad('flyouts to the outfield: catchable (190 feet to the fence)', bip.filter(p => p.type === 'flyout' && OF.has(p._ball.at) && (p._ball.dist < 190 || p._ball.dist >= fence(p._ball))));
bad('sacrifice flies: caught in the outfield, never on an infield pop (r227 the tag-ups)', bip.filter(p => p.type === 'sac_fly' && !OF.has(p._ball.at)));
bad('bunts (and a bunt turned into a double play): in front of the plate', bip.filter(p => (p.type === 'sac_bunt' || / — double play$/.test(p.description) && p._ball?.flight === 'bunt') && (p._ball.flight !== 'bunt' || p._ball.dist > 60)));
bad('on the ground or in the air: "grounds" is on the ground, "flies out" in the air', bip.filter(p => p._ball && ((/grounds (out|into)/.test(p.description) && p._ball.flight !== 'ground') || (/flies out|pops out/.test(p.description) && p._ball.flight === 'ground'))));

// the gems, the errors, the throws, the relay
const GEMS = [[/far to the right/, 'right'], [/deep into the hole/, 'hole'], [/ranges to the left/, 'left'], [/at the wall/, 'wall'], [/diving catch/, 'dive'],
              [/leaping grab/, 'leap'], [/drops in front/, 'front'], [/over .+'s head/, 'over'], [/past a diving/, 'past']];
const gemPlays = bip.filter(p => GEMS.some(([re]) => re.test(p.description)));
bad(`every gem in the words is saved, with its direction (${gemPlays.length})`, gemPlays.filter(p => { const g = GEMS.find(([re]) => re.test(p.description)); return p._ball?.gem !== g[1]; }));
bad('no gem saved without the words', bip.filter(p => p._ball?.gem && !GEMS.some(([re, k]) => k === p._ball.gem && re.test(p.description))));
const errs = all.filter(p => p.type === 'error' && p._ball);
bad(`errors: the kind saved, as in the words (${errs.length})`, errs.filter(p => !p._ball.err || (/throwing error/.test(p.description) !== (p._ball.err === 'throwing'))));
const outs = all.filter(p => /thrown out at/.test(p.description));
bad(`a runner thrown out: who and where, as in the words (${outs.length})`, outs.filter(p => !p._out || !p.description.includes(`${players[p._out.id]?.name} thrown out at ${p._out.base}`)), (p) => `${JSON.stringify(p._out)} — ${p.description}`);
bad('no thrown-out runner saved without the words', all.filter(p => p._out && !/thrown out at/.test(p.description)));
const relays = all.filter(p => /double play — .+ to .+ to /.test(p.description));
bad(`the double play's relay, as in the words (${relays.length})`, relays.filter(p => !p._relay || !p.description.includes(p._relay.map(id => players[id]?.name).join(' to '))), (p) => `${JSON.stringify(p._relay)} — ${p.description}`);

// the same game, the same spots; home runs to all fields
const a = sim(7).plays.map(p => JSON.stringify([p._ball, p._out, p._relay])).join('|');
const b = sim(7).plays.map(p => JSON.stringify([p._ball, p._out, p._relay])).join('|');
check('the same game, the same spots', a === b);
const hr = bip.filter(p => p.type === 'hr');
const lf = hr.filter(p => p._ball.angle < -15).length, cf = hr.filter(p => Math.abs(p._ball.angle) <= 15).length, rf = hr.filter(p => p._ball.angle > 15).length;
check(`home runs to every field (${lf} left, ${cf} center, ${rf} right of ${hr.length})`, hr.length > 30 && [lf, cf, rf].every(n => n >= hr.length * 0.12));
const fl = {}; for (const p of bip) fl[p._ball?.flight] = (fl[p._ball?.flight] || 0) + 1;
console.log(`    flights: ${JSON.stringify(fl)}`);
const ex = ['single', 'double', 'flyout', 'groundout', 'hr'].map(t => bip.find(p => p.type === t)).filter(Boolean);
for (const p of ex) console.log(`    ${p.description}\n      ${JSON.stringify(p._ball)}`);

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
