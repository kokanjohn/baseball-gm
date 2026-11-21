// r241 §122.120 Roster changes reach the lineups set ahead.
//   node tools/harness/check-lineup-changes.mjs [seed=1]
// A player who can't play in a game the GM set ahead leaves only that slot open, only in the games they miss
// (a day-to-day back in time plays the later one). The manager says so in one message listing every game,
// and fills them now when asked ("Fill the Spots") or at each game's deadline. A spot the GM leaves open
// ahead gets no message. Suspensions and games away count our games; a player traded tonight is gone after.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox, syncRosterCards } from '../../engine/CardEngine.js';
import { lineupGames, lineupFor, setLineupFor, availableFor, laterOpenSpots, nextLineupGame, eligibleSlotsFor } from '../../engine/RosterEngine.js';
import { ROSTER_DECISION_LEAD_MS as LEAD } from '../../data/constants.js';

const SEED = parseInt(process.argv[2] || '1', 10);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const H = 3_600_000, DAY = 86_400_000;
const step = (t) => { clock.set(t); tick(); releaseDueCards(); };
const byTime = (t) => SM.get().schedule.find(g => g.gameTime === t);
const P = (id) => SM.get().players[id];
const nm = (slots) => (slots || []).map(sl => `${sl.slot}:${P(sl.playerId)?.name || '—'}`).join(' ');
const openCards = () => getInbox().filter(c => c.cardId === 'open_spots' && !c.resolved);

seedRandom(SEED);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
step(clock.get());
let st = SM.get();
const [g1, g2, g3, g4] = lineupGames(st, 7).map(g => g.gameTime);
check('four games ahead to work with', Number.isFinite(g4));
const base = st.userTeam.lineupSlots.map(sl => ({ ...sl }));
const ss = base.findIndex(sl => sl.slot === 'SS'), c = base.findIndex(sl => sl.slot === 'C');
const ssId = base[ss].playerId;

// The GM sets games 2 and 4 on their own (the same nine). Game 3 carries game 2's.
SM.mutate(s => { setLineupFor(s, s.schedule.find(g => g.gameTime === g2), base); setLineupFor(s, s.schedule.find(g => g.gameTime === g4), base); });

// ── 1. A day-to-day, back between games 3 and 4 ──
const back = g3 + 2 * H;
SM.mutate(s => { Object.assign(s.players[ssId], { isInjured: true, injury: { status: 'dtd', diagnosed: true, injuredAt: clock.get(), returnAt: back, days: 2 } }); });
st = SM.get();
check('day-to-day: out for games 2 and 3, back for game 4', !availableFor(st, P(ssId), byTime(g2)) && !availableFor(st, P(ssId), byTime(g3)) && availableFor(st, P(ssId), byTime(g4)));
syncRosterCards([], clock.get());
st = SM.get();
check(`game 2's own lineup: SS opens, the rest stays (${nm(byTime(g2).lineupPlan)})`, !byTime(g2).lineupPlan[ss].playerId && byTime(g2).lineupPlan.filter(sl => sl.playerId).length === 8);
check('game 3 carries it: SS open', !lineupFor(st, byTime(g3))[ss].playerId);
check(`game 4 keeps them at SS (back in time: ${P(ssId).name})`, byTime(g4).lineupPlan[ss].playerId === ssId);
const later = laterOpenSpots(st);
check(`the open spots ahead: ${later.map(x => `${x.slot}@${new Date(x.gameTime).toISOString().slice(5, 16)}`).join(', ')}`,
      later.length === 2 && later.every(x => x.slot === 'SS') && later.map(x => x.gameTime).join() === [g2, g3].join());
step(clock.get() + 25 * 60_000);
let card = openCards().find(c => /lineups you set ahead/.test(c.body));
check(`one message lists every game (“${card?.body?.split('. ')[0] || card?.body}”)`, !!card && /SS is open/.test(card.body) && (card.body.match(/ at \d/g) || []).length >= 2, card?.body);
check('…just one', openCards().length === 1, openCards().map(c => c.subject).join(' | '));

// "Fill the Spots": the best bench bat who can play SS, in game 2 (and so game 3)
if (card) { resolve(card.instanceId, 'yes'); releaseDueCards(); }
st = SM.get();
const filled = byTime(g2).lineupPlan[ss].playerId;
check(`"Fill the Spots" fills them now (${P(filled)?.name || 'nobody'} at SS in games 2 and 3)`, !!filled && filled !== ssId
      && eligibleSlotsFor(P(filled)).includes('SS') && lineupFor(st, byTime(g3))[ss].playerId === filled);
check('…no open spots ahead now', laterOpenSpots(st).length === 0);

// ── 2. A spot the GM leaves open ahead: no message ──
const mine = byTime(g4).lineupPlan.map(sl => ({ ...sl }));
mine[c].playerId = null;
SM.mutate(s => setLineupFor(s, s.schedule.find(g => g.gameTime === g4), mine));
syncRosterCards([], clock.get());
step(clock.get() + 25 * 60_000);
check('the GM leaves C open in game 4: no message', !laterOpenSpots(SM.get()).length && !openCards().some(x => /\bC is open/.test(x.body)));

// ── 3. Suspensions and games away count our games ──
st = SM.get();
const other = base.find(sl => sl.slot === '2B').playerId;
SM.mutate(s => { Object.assign(s.players[other], { isSuspended: true, _suspendedUntilGame: byTime(g3).index }); });
st = SM.get();
check('suspended until game 3: out for game 2, back for game 3', !availableFor(st, P(other), byTime(g2)) && availableFor(st, P(other), byTime(g3)));
SM.mutate(s => { Object.assign(s.players[other], { isSuspended: false, _suspendedUntilGame: null, unavailable: { reason: 'test', gamesLeft: 2, since: clock.get() } }); });
st = SM.get();
check('away for two games: out for games 1 and 2, back for game 3', !availableFor(st, P(other), byTime(g1)) && !availableFor(st, P(other), byTime(g2)) && availableFor(st, P(other), byTime(g3)));
SM.mutate(s => { s.players[other].unavailable = null; });

// ── 4. At the deadline of a game set ahead: its open spot is filled like any other ──
SM.mutate(s => { Object.assign(s.players[ssId], { isInjured: false, injury: null }); });
const plan3 = lineupFor(SM.get(), byTime(g3)).map(sl => ({ ...sl }));
plan3[ss].playerId = ssId;
SM.mutate(s => setLineupFor(s, s.schedule.find(g => g.gameTime === g3), plan3));
SM.mutate(s => { Object.assign(s.players[ssId], { isInjured: true, injury: { status: 'dtd', diagnosed: true, injuredAt: clock.get(), returnAt: g4 + H, days: 3 } }); });
syncRosterCards([], clock.get());
check('game 3 set ahead with them at SS, now out: SS opens in game 3', !byTime(g3).lineupPlan?.[ss]?.playerId);
for (const t of [g1, g2]) {
  for (let x = Math.max(clock.get(), t - 2 * H); x < t + 5 * H; x += 15 * 60_000) step(x);
  const g = byTime(t);
  if (g && !g._committed) { await commitGame(SM.get().schedule.indexOf(g)); releaseDueCards(); }
}
st = SM.get();
check('game 3 is the next game, its lineup the one set ahead, SS open', nextLineupGame(st)?.gameTime === g3 && !st.userTeam.lineupSlots[ss].playerId, nm(st.userTeam.lineupSlots));
step(g3 - LEAD + 60_000);
st = SM.get();
check(`at game 3's deadline the manager fills SS (${nm(st.userTeam.lineupSlots)})`, !!st.userTeam.lineupSlots[ss].playerId && st.userTeam.lineupSlots[ss].playerId !== ssId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
