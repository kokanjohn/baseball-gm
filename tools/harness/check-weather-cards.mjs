// §102.5 (4d-2) The weather's decisions do what they say — checks, in a real league.
//   node tools/harness/check-weather-cards.mjs
//   1. "Rain likely tonight — start X?" → Hold: the next man starts tonight, X the game after.
//   2. "Doubleheader — who starts game two?" → Bullpen game: the long man opens game two; the rotation keeps its turn.
//   3. The manager asks only when the GM's own forecast says rain is likely (a season's worth of our games).
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, tick, commitGame, advanceClock } from '../../engine/GameEngine.js';
import * as CardEngine from '../../engine/CardEngine.js';
import { rotationStarter } from '../../engine/SimEngine.js';
import { bullpenRoles, starterRested } from '../../engine/PitchingEngine.js';
import { weatherContext } from '../../engine/WeatherClimate.js';
import { chanceOfPrecip } from '../../engine/WeatherForecast.js';
import { GAME_STATUS, GAME_WEATHER } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const HOUR = 3_600_000;

/** Play our game at `idx` to the final and commit it (as the app's tick loop does). */
async function play(idx) {
  for (let guard = 0; guard < 4000; guard++) {
    const g = SM.get().schedule[idx];
    if (!g || g._committed) return;
    if (g.status === GAME_STATUS.FINAL || (g.status === GAME_STATUS.POSTPONED && g.cancelled)) { await commitGame(idx); return; }
    if (g.status === GAME_STATUS.LIVE) { const np = g.plays?.[g.livePlayIndex]; clock.set(np?._timestamp ? np._timestamp + 1000 : clock.get() + 60_000); }
    else clock.set(Math.max(clock.get() + 60_000, g.status === GAME_STATUS.SCHEDULED ? g.gameTime + 60_000 : 0));
    advanceClock(clock.get());
    tick();
  }
}
const starterOf = (g) => g.boxScore ? (g.isHome ? g.boxScore.home : g.boxScore.away).pitchers[0]?.id : null;
/** A weather plan that lets the game be played as scheduled (so the checks aren't at the weather's mercy). */
const dry = (g) => ({ v: 1, venueId: g.isHome ? 'user' : g.opponentId, gameTime: g.gameTime, playMin: 180, outcome: 'played', decidedAt: null,
                      calledBy: null, reason: null, startAt: g.gameTime, delays: [], endT: null, stopAtPlayMin: null });

seedRandom(21);
clock.set(Date.UTC(2400, 0, 1));
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers', abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
// Into the regular season (spring games aren't asked about): play spring through.
clock.set(SM.get().schedule[0].gameTime - 6 * HOUR);
for (let i = 0; i < 10; i++) {
  SM.mutate(s => { const g = s.schedule[s.currentGameIndex]; g.wx = dry(g); });
  await play(SM.get().currentGameIndex);
}

console.log('Rain likely tonight — hold the starter');
{
  const st = SM.get(), idx = st.currentGameIndex, g = st.schedule[idx];
  SM.mutate(s => { const x = s.schedule[idx]; x.wx = dry(x); x.wxStartAsked = x.gameTime; });
  clock.set(g.gameTime - 3 * HOUR);
  const sp = rotationStarter(st.userTeam, st.players, g.gameTime);
  const order = st.userTeam.rotation.order;
  const alt = order.map((_, j) => order[(order.indexOf(sp) + 1 + j) % order.length]).find(id => id !== sp && starterRested(st.players[id], g.gameTime));
  const card = CardEngine.deliverRainStartCard({ key: `wx:start:test:${g.gameTime}`, gameTime: g.gameTime, starterId: sp, altId: alt, chance: 70, kind: 'storms', city: 'Testville' }, clock.get());
  CardEngine.releaseDueCards(clock.get());
  const inInbox = SM.get().inbox.find(c => c.instanceId === card?.instanceId);
  check(`the card asks about ${st.players[sp].name} and offers ${st.players[alt].name} (“${inInbox?.subject}”)`, !!inInbox && inInbox.yesLabel.includes(st.players[alt].name));
  CardEngine.resolve(card.instanceId, 'yes');
  check('holding him puts the next man in tonight\'s spot', rotationStarter(SM.get().userTeam, SM.get().players, g.gameTime) === alt);
  await play(idx);
  const g1 = SM.get().schedule[idx];
  check(`tonight's starter was ${st.players[alt].name}`, starterOf(g1) === alt, `started ${starterOf(g1)}`);
  const idx2 = SM.get().currentGameIndex, gn = SM.get().schedule[idx2];
  SM.mutate(s => { const x = s.schedule[idx2]; x.wx = dry(x); x.wxStartAsked = x.gameTime; });
  check(`…and ${st.players[sp].name} is in line for the next game`, rotationStarter(SM.get().userTeam, SM.get().players, gn.gameTime) === sp);
  await play(idx2);
  check(`${st.players[sp].name} started it`, starterOf(SM.get().schedule[idx2]) === sp, `started ${starterOf(SM.get().schedule[idx2])}`);
  // Answered "start him": nothing changes.
  const idx3 = SM.get().currentGameIndex, g3 = SM.get().schedule[idx3];
  SM.mutate(s => { const x = s.schedule[idx3]; x.wx = dry(x); x.wxStartAsked = x.gameTime; });
  const sp3 = rotationStarter(SM.get().userTeam, SM.get().players, g3.gameTime);
  const before = JSON.stringify(SM.get().userTeam.rotation);
  const c3 = CardEngine.deliverRainStartCard({ key: `wx:start:test:${g3.gameTime}`, gameTime: g3.gameTime, starterId: sp3, altId: alt, chance: 65, kind: 'rain' }, clock.get());
  CardEngine.releaseDueCards(clock.get());
  CardEngine.resolve(c3.instanceId, 'no');
  check('“Start him” leaves the rotation as it was', JSON.stringify(SM.get().userTeam.rotation) === before);
}

console.log('\nDoubleheader — a bullpen game');
{
  // Make our next two games a doubleheader (game one at 1:05, game two at 7:05 on the second one's date).
  const st0 = SM.get(), i1 = st0.currentGameIndex;
  SM.mutate(s => {
    const a = s.schedule[i1], b = s.schedule[i1 + 1];
    const d = new Date(b.gameTime); d.setHours(13, 5, 0, 0);
    a.date = b.date; a.gameTime = d.getTime(); a.isMakeup = true;
    const e = new Date(b.gameTime); e.setHours(19, 5, 0, 0); b.gameTime = e.getTime();
    a.wx = dry(a); b.wx = dry(b); a.wxStartAsked = a.gameTime; b.wxStartAsked = b.gameTime;
  });
  const st = SM.get(), a = st.schedule[i1], b = st.schedule[i1 + 1];
  const longId = bullpenRoles(st.userTeam, st.players).long[0];
  const card = CardEngine.deliverDoubleheaderCard({ key: `wx:dh:test:${b.date}`, date: b.date, firstPitch: a.gameTime, nextId: null, longId, opp: b.opponent, makeupOf: 'Apr 1' }, clock.get());
  CardEngine.releaseDueCards(clock.get());
  check(`the card offers a bullpen game with ${st.players[longId]?.name} opening (“${card?.yesLabel}”)`, !!card && card.yesLabel.includes(st.players[longId].name));
  CardEngine.resolve(card.instanceId, 'yes');
  check('game two is marked: the long man starts, the rotation keeps its turn', SM.get().schedule[i1 + 1].userStarterId === longId && SM.get().schedule[i1 + 1].keepRotation === true);
  await play(i1);
  const rotAfter1 = SM.get().userTeam.rotation.currentIndex;
  await play(i1 + 1);
  const g2 = SM.get().schedule[i1 + 1];
  check(`game two's starter was ${st.players[longId].name}`, starterOf(g2) === longId, `started ${starterOf(g2)}`);
  check('the rotation didn\'t turn for the bullpen game', SM.get().userTeam.rotation.currentIndex === rotAfter1);
}

console.log('\nThe manager asks only when the forecast says rain is likely');
{
  // A season's worth of our games: the card is due exactly when the GM's forecast,
  // three hours out, gives at least START_CARD_CHANCE for the game window.
  const st = SM.get(), ctx = weatherContext(st);
  let likely = 0, n = 0;
  for (const g of st.schedule.filter(x => !x.isSpring && !x._committed).slice(0, 60)) {
    const park = ctx.map.parks[g.isHome ? 'user' : g.opponentId];
    const ch = chanceOfPrecip(ctx, g.gameTime - 3 * HOUR, park.x, park.y, g.gameTime, g.gameTime + 3 * HOUR);
    n++; if (ch.chance >= GAME_WEATHER.START_CARD_CHANCE) likely++;
  }
  check(`a few games a month (${likely} of ${n} games)`, likely >= 1 && likely <= n * 0.3);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
