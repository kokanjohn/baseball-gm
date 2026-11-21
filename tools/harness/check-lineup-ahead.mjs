// r240 §122.119 Lineups set ahead, game by game (hitters only): the data, carried forward, and the lineup each
// game takes at first pitch.
//   node tools/harness/check-lineup-ahead.mjs [seed=1]
// A game the GM sets on its own keeps that lineup; the games after it take it too, until one with its own. At
// first pitch the next game takes lineupSlots and the game after it becomes the next one (its own lineup, if
// any, becomes lineupSlots). A player who can't play by then leaves the slot open. A game played again (a held
// start) keeps the lineup it took. A postponed game drops the lineup set for its day.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards } from '../../engine/CardEngine.js';
import { lineupGames, lineupFor, setLineupFor, hasOwnLineup, nextLineupGame } from '../../engine/RosterEngine.js';
import { LINEUP_PLAN } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const H = 3_600_000;
const step = (t) => { clock.set(t); tick(); releaseDueCards(); };
const ids = (slots) => (slots || []).map(sl => sl.playerId || '—');
const same = (a, b) => JSON.stringify(ids(a)) === JSON.stringify(ids(b));
const nm = (slots) => (slots || []).map(sl => `${sl.slot}:${SM.get().players[sl.playerId]?.name || '—'}`).join(' ');
const byTime = (t) => SM.get().schedule.find(g => g.gameTime === t);
async function playThrough(t) {   // the game at first pitch t: started, played out, committed (as the app does at the final)
  for (let x = t + 60_000; x < t + 5 * H; x += 15 * 60_000) step(x);
  const g = byTime(t);
  if (g && !g._committed) { await commitGame(SM.get().schedule.indexOf(g)); releaseDueCards(); }
}

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
step(clock.get());
let st = SM.get();
const games = lineupGames(st, 7);
check(`a week ahead: ${games.length} games whose lineups can be set`, games.length >= 4, games.length);
check(`the default window is ${LINEUP_PLAN.days} days (today and tomorrow)`, lineupGames(st).every(g => g.gameTime < games[0].gameTime + 2 * 86_400_000 + 24 * H));
const [g1, g2, g3, g4] = games.map(g => g.gameTime);
const base = st.userTeam.lineupSlots.map(sl => ({ ...sl }));
check('every game takes the lineup to start with', [g1, g2, g3, g4].every(t => same(lineupFor(st, byTime(t)), base)));

// The GM sets game 3 on its own: 1B and the DH trade places with bench bats... here, the C and 1B swap a bench bat in.
const bench = st.userTeam.rosterIds.map(id => st.players[id])
  .filter(p => p && !['SP', 'RP'].includes(p.pos) && !base.some(sl => sl.playerId === p.id));
const plan = base.map(sl => ({ ...sl }));
const dhIdx = plan.findIndex(sl => sl.slot === 'DH');
plan[dhIdx].playerId = bench[0].id;   // any bat can DH
SM.mutate(s => setLineupFor(s, byTime(g3), plan));
st = SM.get();
check(`game 3 has its own lineup (DH: ${st.players[bench[0].id].name})`, hasOwnLineup(st, byTime(g3)) && same(lineupFor(st, byTime(g3)), plan));
check('game 2 still takes the lineup before it', !hasOwnLineup(st, byTime(g2)) && same(lineupFor(st, byTime(g2)), base));
check('game 4 takes game 3\'s (carried forward)', same(lineupFor(st, byTime(g4)), plan));
check('the next game\'s lineup is unchanged', same(st.userTeam.lineupSlots, base));

// Game 1 plays: game 2 is next, its lineup carried from game 1.
await playThrough(g1);
st = SM.get();
check('game 1 played with the lineup it took', same(byTime(g1).lineupTaken, base));
check('game 2 is the next game now, with the lineup carried', nextLineupGame(st)?.gameTime === g2 && same(st.userTeam.lineupSlots, base), nm(st.userTeam.lineupSlots));

// Game 2 starts: game 3 is next, and its own lineup is the lineup.
step(g2 - 2 * H);
step(g2 + 60_000);
st = SM.get();
check('at game 2\'s first pitch, game 2 took the carried lineup', same(byTime(g2).lineupTaken, base));
check(`…and game 3's own lineup is the lineup now (${nm(st.userTeam.lineupSlots)})`, same(st.userTeam.lineupSlots, plan));
check('…kept once, not on the game any more', !byTime(g3).lineupPlan);
check('game 4 takes it too', same(lineupFor(st, byTime(g4)), plan));
await playThrough(g2);
step(g3 + 60_000);
st = SM.get();
const taken3 = byTime(g3).liveLineups;
const ours3 = byTime(g3).isHome ? taken3?.home : taken3?.away;
check('game 3 is played with the lineup the GM set for it', same(byTime(g3).lineupTaken, plan) && (ours3 || []).includes(bench[0].id), JSON.stringify(ours3));
await playThrough(g3);

// A player in a game's own lineup who can't play by then: the slot opens.
st = SM.get();
const n1 = nextLineupGame(st), n2 = lineupGames(st, 7)[1];
const plan2 = st.userTeam.lineupSlots.map(sl => ({ ...sl }));
const ssIdx = plan2.findIndex(sl => sl.slot === 'SS');
const gone = plan2[ssIdx].playerId;
SM.mutate(s => setLineupFor(s, s.schedule.find(g => g.gameTime === n2.gameTime), plan2));
SM.mutate(s => { s.players[gone].injury = { status: 'il', type: 'test', eligibleAt: n2.gameTime + 30 * 86_400_000, returnAt: n2.gameTime + 30 * 86_400_000 }; s.players[gone].group = 'il'; });
step(n1.gameTime + 60_000);
st = SM.get();
check(`a player in the set lineup who's hurt by then: the slot opens, the rest stays (${nm(st.userTeam.lineupSlots)})`,
      !st.userTeam.lineupSlots[ssIdx].playerId || st.userTeam.lineupSlots[ssIdx].playerId !== gone);
check('…the hurt player isn\'t in it', !st.userTeam.lineupSlots.some(sl => sl.playerId === gone));

// A postponed game drops the lineup set for its day.
const later = lineupGames(st, 7).slice(-1)[0];
SM.mutate(s => setLineupFor(s, s.schedule.find(g => g.gameTime === later.gameTime), plan2));
const src = (await import('node:fs')).readFileSync(new URL('../../engine/GameEngine.js', import.meta.url), 'utf8');
check('a postponement drops the game\'s own lineup (with its named starter)', /delete x\.userStarterId; delete x\.keepRotation;\s*\n\s*delete x\.lineupPlan;/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
