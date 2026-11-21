// r242 §122.121 MOVE for a game set ahead (the engine under the Team screen's day strip).
//   node tools/harness/check-lineup-move.mjs [seed=1]
// MOVE on a later game works on that game's lineup with who can play in it; the next game's lineup is untouched;
// a spot the GM empties there is the GM's (no message), while one a roster change opens stays the manager's.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, gmMoveFor, gmSameAsBefore } from '../../engine/GameEngine.js';
import { releaseDueCards, syncRosterCards } from '../../engine/CardEngine.js';
import { lineupGames, lineupFor, hasOwnLineup, moveOptionsFor, moveOptions, laterOpenSpots } from '../../engine/RosterEngine.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const step = (t) => { clock.set(t); tick(); releaseDueCards(); };
seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
step(clock.get());
let st = SM.get();
const [n, g2, g3] = lineupGames(st, 7);
const G = (g) => SM.get().schedule.find(x => x.gameTime === g.gameTime);
const base = st.userTeam.lineupSlots.map(sl => sl.playerId);
const ssIdx = st.userTeam.lineupSlots.findIndex(sl => sl.slot === 'SS'), cIdx = st.userTeam.lineupSlots.findIndex(sl => sl.slot === 'C');
const ss = base[ssIdx], c = base[cIdx];

// A day-to-day back after game 2: MOVE for game 2 doesn't offer them; for game 3 it does.
SM.mutate(s => Object.assign(s.players[ss], { isInjured: true, injury: { status: 'dtd', diagnosed: true, injuredAt: clock.get(), returnAt: g2.gameTime + 3_600_000, days: 1 } }));
st = SM.get();
check('MOVE for the hurt SS in game 2: nothing (can\'t play then)', moveOptionsFor(st, ss, G(g2)).length === 0);
check('…in game 3: their options are there (back by then)', moveOptionsFor(st, ss, G(g3)).length > 0);
check('…for the next game: as ever (moveOptions)', JSON.stringify(moveOptionsFor(st, ss, G(n))) === JSON.stringify(moveOptions(st, ss)));

// MOVE the C to the bench for game 3, leaving it open: game 3 set on its own; the next game untouched; no message.
const r = gmMoveFor(c, 'bench', g3.gameTime);
st = SM.get();
check('MOVE the C to the bench in game 3: done', r.ok, r.reason);
check('game 3 is set on its own with C open', hasOwnLineup(st, G(g3)) && !lineupFor(st, G(g3))[cIdx].playerId);
check('the next game and game 2 are untouched', JSON.stringify(st.userTeam.lineupSlots.map(s => s.playerId)) === JSON.stringify(base)
      && JSON.stringify(lineupFor(st, G(g2)).map(s => s.playerId)) === JSON.stringify(base));
check('the GM\'s open C: no open spot to tell', !laterOpenSpots(st).some(x => x.slot === 'C'));

// A roster change opens SS in game 3 (out longer now): the manager's to tell, even though the GM set game 3.
SM.mutate(s => { s.players[ss].injury.returnAt = g3.gameTime + 3_600_000; });
syncRosterCards([], clock.get());
st = SM.get();
check('a roster change opens SS in game 3: the manager tells it', laterOpenSpots(st).some(x => x.slot === 'SS' && x.gameTime === g3.gameTime));

// Fill C in game 3 from the bench: the GM's open C is filled.
const fill = moveOptionsFor(st, c, G(g3));
const into = (st.userTeam.rosterIds || []).map(id => st.players[id]).find(p => p && !['SP', 'RP'].includes(p.pos)
  && !lineupFor(st, G(g3)).some(s => s.playerId === p.id) && moveOptionsFor(st, p.id, G(g3)).some(o => o.key === `slot:${cIdx}`));
const r2 = into ? gmMoveFor(into.id, `slot:${cIdx}`, g3.gameTime) : { ok: false, reason: 'nobody' };
check(`a bench bat into C for game 3 (${into?.name})`, r2.ok && lineupFor(SM.get(), G(g3))[cIdx].playerId === into.id, r2.reason);

// Same as the day before
gmSameAsBefore(g3.gameTime);
st = SM.get();
check('"Same as the day before": game 3 takes game 2\'s again', !hasOwnLineup(st, G(g3)) && JSON.stringify(lineupFor(st, G(g3)).map(s => s.playerId)) === JSON.stringify(lineupFor(st, G(g2)).map(s => s.playerId)));
check('the next game can\'t be "same as before"', !gmSameAsBefore(n.gameTime).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
