/**
 * tools/harness/check-opponents.mjs — r282 §122.161 our games know their opponent by the club's id.
 *   - Every game of ours (spring, regular season) has an opponentId of a real club, the name on it that club's.
 *   - A club renamed — even to another club's name — is still the club our games are against: the lookup, the
 *     series (one club's games in a row), the hometown player's club, the next game's division.
 *   - The next game against a division rival reads as one (it never did: names were matched against ids).
 *   - Games are played after the renames, against the right clubs.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, buildCardContext, getNextGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { opponentOf, sameOpponent } from '../../engine/Opponents.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(282);
clock.set(Date.UTC(2400, 0, 1, 13));
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

const sched = S().schedule;
const bad = sched.filter(g => { const t = opponentOf(S(), g); return !t || t.name !== g.opponent; });
check(`every game of ours (${sched.length}) has its opponent's id, the name on it that club's`, bad.length === 0, bad.slice(0, 3).map(g => g.index).join());

// a series: the same club's games in a row, by id
const reg = sched.filter(g => !g.isSpring);
const i0 = reg.findIndex((g, i) => i && !sameOpponent(reg[i - 1], g) && sameOpponent(reg[i + 1], g));
const series = reg.slice(i0).filter((g, k, a) => a.slice(0, k + 1).every(x => sameOpponent(x, reg[i0]) && x.isHome === reg[i0].isHome));
check(`a series is one club's games in a row (${series.length} vs ${reg[i0]?.opponent})`, series.length >= 2);

// rename two clubs: one to a new name, another to the name the first had (as Settings could)
const A = opponentOf(S(), reg[i0]), B = S().leagueTeams.find(t => t.id !== A.id && t.id !== 'user');
const aWas = A.name;
SM.mutate(s => { s.leagueTeams.find(t => t.id === A.id).name = 'Renamed Rovers'; s.leagueTeams.find(t => t.id === B.id).name = aWas; });
check(`renamed (${aWas} → Renamed Rovers; ${B.abbr} now called “${aWas}”): our games against it still find it`, opponentOf(S(), reg[i0])?.id === A.id);
check('…the series still holds together, and doesn\'t take in the other club', series.every(g => sameOpponent(g, reg[i0])) && !reg.some(g => g.opponentId === B.id && sameOpponent(g, reg[i0])));

// games played after the renames: the right clubs
// (the first game: at first pitch it's simulated, the other side's lineup from its club's roster)
const g0 = S().schedule[S().currentGameIndex || 0];
// (its club renamed to another club's name first: two clubs now answer to it)
const other = S().leagueTeams.find(t => t.id !== g0.opponentId);
SM.mutate(s => { s.leagueTeams.find(t => t.id === g0.opponentId).name = other.name; });
clock.set(g0.gameTime + 60_000); tick(); releaseDueCards();
const live = S().schedule[g0.index];
const theirs = live.liveLineups?.[live.isHome ? 'away' : 'home'] || [];
const club = opponentOf(S(), live);
check(`the next game after the renames is played against its club (${club?.abbr}, now called “${club?.name}” like ${other.abbr}: ${theirs.length} in their lineup, all theirs)`,
  live.plays?.length > 20 && theirs.length === 9 && theirs.every(id => club.rosterIds.includes(id)));

// the division rival
const ctxDiv = () => { const g = getNextGame(); const t = opponentOf(S(), g); return { g, t, ctx: buildCardContext() }; };
let k = 0, sawDiv = null, sawOther = null;
const firstReg = sched.findIndex(g => !g.isSpring);
for (let i = firstReg; i < sched.length && (!sawDiv || !sawOther) && k < 200; i++, k++) {
  SM.mutate(s => { s.currentGameIndex = i; s.phase = 'REGULAR_SEASON'; });
  const { g, t, ctx } = ctxDiv();
  if (!t) continue;
  if (t.divisionId === S().userTeam.divisionId && !sawDiv) sawDiv = { name: t.name, yes: ctx.isDivisionOpponent };
  if (t.divisionId !== S().userTeam.divisionId && !sawOther) sawOther = { name: t.name, yes: ctx.isDivisionOpponent };
}
check(`the next game against a division rival reads as one (${sawDiv?.name}): ${sawDiv?.yes}`, sawDiv?.yes === true);
check(`…and against a club in the other division, not (${sawOther?.name}): ${sawOther?.yes}`, sawOther?.yes === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
