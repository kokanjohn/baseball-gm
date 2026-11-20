/**
 * tools/harness/check-home-opener.mjs — r210 §122.88 our first spring game is at home, every new team and every
 * spring; the second game falls either way; every club still plays every spring day.
 */
import { seedRandom } from './shims.js';
import { generateLeagueCalendar } from '../../engine/SeasonEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const league = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, divisionId: i < 4 ? 'A' : 'B' }));
let first = 0, secondHome = 0, full = 0, homeShare = 0;
const N = 60;
for (let seed = 1; seed <= N; seed++) {
  seedRandom(seed);
  const { schedule, leagueSchedule } = generateLeagueCalendar(1 + (seed % 3), league, new Date(2027, 2, 1, 13, 5), { year: 2027 });
  const spring = schedule.filter(g => g.isSpring);
  if (spring[0]?.isHome) first++;
  if (spring[1]?.isHome) secondHome++;
  homeShare += spring.filter(g => g.isHome).length / spring.length;
  if (spring.length === 10) full++;
}
check(`our first spring game is at home (${first}/${N})`, first === N);
check(`the second falls either way (${secondHome}/${N} at home)`, secondHome > 10 && secondHome < N - 10);
check(`ten spring games every time (${full}/${N}), about half at home (${(homeShare / N * 100).toFixed(0)}%)`, full === N && homeShare / N > 0.4 && homeShare / N < 0.65);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
