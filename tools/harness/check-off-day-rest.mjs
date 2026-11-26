/**
 * tools/harness/check-off-day-rest.mjs — r262 §122.141 an off day rests the hitters the day it comes.
 *   - On our off day the regulars' wear is already down WEAR.offDay (the bar shows it that morning), not only once
 *     the next game is counted.
 *   - The next game doesn't take it off again: after it, a regular's wear is what it was, less the off day, plus his
 *     start.
 *   - A league club's off day the same (they rest the same way), seen that day; its next game clears the count.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { dayOf } from '../../engine/PitchingEngine.js';
import { WEAR } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const H = 3_600_000, MIN = 60_000;

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(262);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const sch = S().schedule;
// Our first off day: a calendar day between two of our games.
const k = sch.findIndex((g, i) => i > 0 && dayOf(g.gameTime) - dayOf(sch[i - 1].gameTime) === 2);
const before = sch[k - 1], after = sch[k];
const run = async (until) => {
  for (let t = clock.get(); t <= until; t += 10 * MIN) {
    clock.set(t); tick();
    for (const g of S().schedule) if (g.status === 'final' && !g._committed && g.liveLineups) await commitGame(S().schedule.indexOf(g));
  }
};
await run(before.gameTime + 6 * H);
const regulars = S().userTeam.lineupSlots.map(x => x.playerId).filter(Boolean);
SM.mutate(s => { for (const id of regulars) { s.players[id].wear = 10; s.players[id].straight = 6; } });
const offNoon = new Date(before.gameTime); offNoon.setDate(offNoon.getDate() + 1); offNoon.setHours(12, 0, 0, 0);
const atOff = await (async () => { await run(offNoon.getTime()); return regulars.map(id => S().players[id].wear); })();
check(`our off day: the regulars rested that day (${[...new Set(atOff)].join(', ')}; from 10)`, atOff.every(w => w === 10 - WEAR.offDay));
// r289 §122.170 the league clubs off with us, seen that day (by the next one they've played, and countGame has
// cleared the count: looking then saw a club off only when the schedule happened to leave one idle).
const offDay = dayOf(offNoon.getTime());
const playingOff = new Set();
for (const list of Object.values(S().leagueSchedule?.dayMap || {})) for (const g of list)
  if (g.status !== 'postponed' && Number.isFinite(g.gameTime) && dayOf(g.gameTime) === offDay) { playingOff.add(g.homeId); playingOff.add(g.awayId); }
const offClubs = S().leagueTeams.filter(t => t._lastGameAt && !playingOff.has(t.id));
const offSeen = offClubs.map(t => ({ id: t.id, name: t.name, credited: t._offCredited || 0 }));
// The next game day's morning: nothing more (a game today isn't an off day).
const nextMorning = new Date(after.gameTime); nextMorning.setHours(9, 0, 0, 0);
await run(nextMorning.getTime());
check('the next game day, before the game: no more rest taken', regulars.every(id => S().players[id].wear === 10 - WEAR.offDay));
// After the next game: the start added, the off day not taken twice.
const lineup = new Set(S().userTeam.lineupSlots.map(x => x.playerId));
const catcher = S().userTeam.lineupSlots.find(x => x.slot === 'C')?.playerId;
await run(after.gameTime + 6 * H);
const got = regulars.filter(id => lineup.has(id) && id !== catcher).map(id => ({ w: S().players[id].wear, add: S().players[id].wear - (10 - WEAR.offDay) }));
check(`after the next game: what it was, less the off day, plus the start (${got.map(x => x.w).join(', ')})`,
  got.length >= 5 && got.every(x => x.add > 0 && x.add <= 1.45));

// A league club's off day: rested the same way, credited once.
check(`a league club rests on its off days too (${offSeen.map(x => `${x.name}: ${x.credited} credited`).join(', ') || 'none off with us'})`,
  offSeen.length > 0 && offSeen.every(x => x.credited === 1));
const since = offSeen.map(x => S().leagueTeams.find(t => t.id === x.id)).filter(t => dayOf(t._lastGameAt) > offDay);
check(`…once: its next game clears the count (${since.length} of ${offSeen.length} played since)`,
  since.length > 0 && since.every(t => !t._offCredited));

console.log(fail ? `\n${fail} FAILED — ${pass} passed` : `\nALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
