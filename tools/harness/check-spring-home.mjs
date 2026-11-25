/**
 * tools/harness/check-spring-home.mjs — r278 §122.157 every club's spring is half at home (five of ten; six at
 * most), across many leagues; our first spring game is still at home; nothing else about the calendar changes.
 */
import { seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { SPRING_TRAINING_GAME_COUNT } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const ours = [], all = [], bad = [];
let firstHome = 0;
const N = 12;
for (let s = 0; s < N; s++) {
  for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
  seedRandom(2780 + s);
  await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: ['east', 'north', 'west', 'south'][s % 4] });
  const st = SM.get();
  const sp = st.schedule.filter(g => g.isSpring);
  const home = sp.filter(g => g.isHome).length;
  ours.push(home);
  if (sp[0]?.isHome) firstHome++;
  const counts = {};
  for (const g of Object.values(st.leagueSchedule.dayMap).flat().filter(g => g.isSpring)) {
    counts[g.homeId] = counts[g.homeId] || { h: 0, n: 0 }; counts[g.homeId].h++; counts[g.homeId].n++;
    counts[g.awayId] = counts[g.awayId] || { h: 0, n: 0 }; counts[g.awayId].n++;
  }
  for (const [id, c] of Object.entries(counts)) { all.push(c.h); if (Math.abs(2 * c.h - c.n) > 2) bad.push(`league ${s} ${id}: ${c.h} of ${c.n}`); }
}
check(`our spring: five or six at home in every league (${ours.join(' ')})`, ours.every(h => h === 5 || h === 6));
check(`every club within one game of even at home (${all.length} club springs; ${[4, 5, 6].map(k => `${k}: ${all.filter(h => h === k).length}`).join(', ')})`, bad.length === 0, bad.slice(0, 6).join('; '));
check(`our first spring game is at home (${firstHome} of ${N})`, firstHome === N);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
