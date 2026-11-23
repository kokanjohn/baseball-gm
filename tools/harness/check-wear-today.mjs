/**
 * tools/harness/check-wear-today.mjs — r259 §122.138 one wear bar, and wear fresh each spring.
 *   - A reliever's bar reads today's arm too: pitched yesterday → Tired (half the bar), needs a day down → red (a
 *     quarter, "Needs a day"); the workload when it's worse; a starter's and a hitter's are their wear alone.
 *   - armStatus says why, in words, for the player card.
 *   - A new season's spring starts everyone fresh (wear, starts in a row, workload, recent outings); a new club too.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { wearToday, wearOf } from '../../engine/DevelopmentEngine.js';
import { armStatus, dayOf } from '../../engine/PitchingEngine.js';
import { openNewSeason } from '../../engine/OffseasonEngine.js';
import { WEAR } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const D = 86_400_000;

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(259);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const S = () => SM.get();
const now = clock.get(), day = dayOf(now);
const pen = S().userTeam.rosterIds.map(id => S().players[id]).filter(p => p.pos === 'RP');
const out = (d, bf) => ({ at: now - d * D, day: day - d, bf, outs: 3, start: false });
const rp = (arm, load = 2) => ({ ...pen[0], arm, load, loadAt: now - D, loadMult: 1 });

check('a new club starts fresh', S().userTeam.rosterIds.every(id => !(S().players[id].wear) && !(S().players[id].load)));

const yest = rp([out(1, 4)]);
const t1 = wearToday(yest, now, { reliever: true });
check(`pitched yesterday: "${t1.word}", ${Math.round(t1.left * 100)}% of the bar, why "${t1.why}"`, t1.level === 'tired' && t1.word === 'Tired' && Math.round(t1.left * 100) === 50 && t1.today === 'tired' && t1.why === 'Pitched yesterday.');
const two = rp([out(2, 4), out(1, 4)]);
const t2 = wearToday(two, now, { reliever: true });
check(`two days running: "${t2.word}", ${Math.round(t2.left * 100)}%, "${t2.why}"`, t2.level === 'worn' && t2.word === 'Needs a day' && Math.round(t2.left * 100) === 25 && t2.why === 'Pitched 2 days in a row: never a third.');
const long = rp([out(1, 12)]);
check(`a long outing yesterday: "${armStatus(long, now).why}"`, armStatus(long, now).status === 'down' && armStatus(long, now).why === 'A long outing yesterday.');
const three = rp([out(3, 3), out(2, 3)]);
check(`two days ago and three, one batter short of anything: fresh (${armStatus(three, now).status})`, armStatus(three, now).status === 'fresh' && armStatus(three, now).why === null);
const heavy = rp([out(1, 4)], 20);
const t3 = wearToday(heavy, now, { reliever: true });
check(`a heavy workload beats today's arm: "${t3.word}" (${t3.wear})`, t3.level === wearOf(heavy, now).level && t3.wear >= WEAR.tired);
check('a starter (not the bullpen) reads his workload alone', wearToday(yest, now, { reliever: false }).today === null && wearToday(yest, now).level === wearOf(yest, now).level);
check('rested: the workload alone', wearToday(rp([out(3, 4)], 1), now, { reliever: true }).today === null);

// A new season: everyone fresh.
SM.mutate(s => { for (const id of s.userTeam.rosterIds.slice(0, 12)) Object.assign(s.players[id], { wear: 9, straight: 8, load: 11, loadAt: now, arm: [out(1, 4)] }); });
const after = SM.speculate(() => { SM.mutate(s => { openNewSeason(s, now); }); return S().userTeam.rosterIds.slice(0, 12).map(id => S().players[id]).filter(Boolean); });
check(`a new spring: wear, starts in a row, workload and recent outings all clear (${after.length})`, after.every(p => !p.wear && !p.straight && !p.load && !(p.arm || []).length));

console.log(fail ? `\n${fail} FAILED — ${pass} passed` : `\nALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
