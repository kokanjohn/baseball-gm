/**
 * tools/harness/check-away-days.mjs — r217 §122.96 off days and road trips (message plan, release 4).
 *   - the off day: the first whole day with no game before the next one; its messages come that day, 9am–7pm;
 *   - a road game day: one more message this often; never before a home game;
 *   - every off-day and road message reads right with real tokens (voice, no raw tokens, gender-neutral);
 *   - a player's hometown series names a player from there, and a yes moves the player's view of the GM;
 *   - golf with another club's GM moves our rapport with that club; an off-day session starts real work
 *     with no games away;
 *   - a ballpark booking: the fee comes in, how it went comes the morning of our first home game back (a repair
 *     costs what it says); one booking a road trip.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { offDayWindow, hometownOf, hometownPlayer, PARK_EVENT_IDS } from '../../engine/AwayDays.js';
import { OFFDAY_POOL, ROAD_POOL, AWAY_FOLLOWUPS } from '../../data/cards-away.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE, SPRING_TRAINING_GAME_COUNT } from '../../data/constants.js';
import { rapportOf } from '../../engine/TradeEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000, HOUR = 3_600_000;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const hr = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
const dayOf = (ms) => new Date(ms).toDateString();
const say = (c) => console.log(`    ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}\n      [${c.yesLabel}${c.noLabel ? ` / ${c.noLabel}` : ''}]`);
const personOf = (s) => (String(s).match(/^(.+?) \(/) || [])[1] || (Object.values(S().userTeam.coachingStaff).some(x => x?.name === s) ? s : null);
const readsRight = (c) => voiceProblems(c, personOf).length === 0 && !GEN.test(`${c.body} ${c.preview} ${c.yesMsg || ''} ${c.noMsg || ''}`)
  && !/\{[a-z0-9_]+\}|undefined|NaN/.test(`${c.subject} ${c.preview} ${c.body} ${c.yesMsg || ''} ${c.noMsg || ''}`);

seedRandom(61);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; });
const sched = S().schedule;
const reg = (i) => sched[i] && !sched[i].isSpring && !sched[i].isPlayoff;
/** Put the season at game `i` (the games before it played), the clock `afterMs` after the game before ended. */
const at = (i, afterMs = 4 * HOUR) => {
  SM.mutate(s => { s.currentGameIndex = i; s.schedule.forEach((g, k) => { g._committed = k < i; }); s.inbox = []; s.scheduledCards = []; s.cardPlanKey = null; });
  clock.set(sched[i - 1].gameTime + afterMs);
  return buildCardContext();
};
// A day off: game i is two or more days after game i-1 (after the first 40 regular-season games).
const offIdx = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && reg(i - 1)
  && new Date(g.gameTime).setHours(0, 0, 0, 0) - new Date(sched[i - 1].gameTime).setHours(0, 0, 0, 0) >= 2 * DAY);
// A road game the day after a road game (no day off), and a home game the day after a home game.
const nextDay = (i) => new Date(sched[i].gameTime).setHours(0, 0, 0, 0) - new Date(sched[i - 1].gameTime).setHours(0, 0, 0, 0) === DAY;
const roadIdx = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && reg(i - 1) && !g.isHome && !sched[i - 1].isHome && nextDay(i));
const homeIdx = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && reg(i - 1) && g.isHome && sched[i - 1].isHome && nextDay(i));

/** Plan the next game day `n` times (each on a scratch copy): the cards each plan made. */
const plans = (i, n) => Array.from({ length: n }, (_, k) => SM.speculate(() => {
  seedRandom(1000 + k);
  const ctx = at(i);
  CE.checkAndDeliver(ctx);
  return { cards: [...(SM.get().scheduledCards || [])], win: offDayWindow(SM.get(), clock.get(), sched[i].gameTime) };
}));

console.log('The off day');
{
  check('found a day off in the schedule, a road game the day after a road game, a home game the day after a home game', offIdx > 0 && roadIdx > 0 && homeIdx > 0, `${offIdx} ${roadIdx} ${homeIdx}`);
  at(offIdx);
  const w = offDayWindow(S(), clock.get(), sched[offIdx].gameTime);
  check(`the window is the day after the last game, 9am–7pm (${w && new Date(w.startMs).toString().slice(0, 21)} → ${w && new Date(w.endMs).toString().slice(16, 21)})`,
    !!w && dayOf(w.startMs) === dayOf(sched[offIdx - 1].gameTime + DAY) && hr(w.startMs) === 9 && hr(w.endMs) === 19);
  check('no game of ours that day', !sched.some(g => !g.cancelled && dayOf(g.gameTime) === dayOf(w.startMs)));
  at(roadIdx);
  check('no window when the next game is tomorrow', offDayWindow(S(), clock.get(), sched[roadIdx].gameTime) == null);

  const P = plans(offIdx, 30);
  const off = P.flatMap(p => p.cards.filter(c => c._pool === 'OFFDAY_POOL').map(c => ({ c, w: p.win })));
  const days = P.filter(p => p.cards.some(c => c._pool === 'OFFDAY_POOL')).length;
  check(`an off-day message on most off days (${days}/30), about one a day (${off.length} in 30)`, days >= 18 && off.length >= 20 && off.length <= 40);
  check('each on the off day itself, 9am–7pm', off.length > 0 && off.every(({ c, w }) => c.deliverAtMs >= w.startMs && c.deliverAtMs <= w.endMs && dayOf(c.deliverAtMs) === dayOf(w.startMs)),
    off.filter(({ c, w }) => !(c.deliverAtMs >= w.startMs && c.deliverAtMs <= w.endMs)).map(({ c }) => `${c.cardId} ${new Date(c.deliverAtMs)}`).join('; '));
  const kinds = new Set(off.map(({ c }) => c.cardId));
  check(`a range of them (${[...kinds].join(', ')})`, kinds.size >= 5);
  check('none on a day with a game', plans(roadIdx, 10).every(p => !p.cards.some(c => c._pool === 'OFFDAY_POOL')));
}

console.log('\nThe road');
{
  const R = plans(roadIdx, 40);
  const n = R.filter(p => p.cards.some(c => c._pool === 'ROAD_POOL')).length;
  check(`a road game day brings one more message about half the time (${n}/40)`, n >= 12 && n <= 32);
  const H = plans(homeIdx, 20);
  check('never before a home game', H.every(p => !p.cards.some(c => c._pool === 'ROAD_POOL')));
}

console.log('\nEvery message, with real tokens');
{
  // A road series against a club one of our players grew up near (for the hometown message).
  const kid = S().userTeam.rosterIds.map(id => S().players[id]).find(p => hometownOf(S(), p) && ['sh', 'bh', 'sp', 'bp'].includes(p.group));
  const kidClub = kid && S().leagueTeams.find(t => t.id === hometownOf(S(), kid));
  const kidIdx = kidClub ? sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && !g.isHome && g.opponent === kidClub.name) : -1;
  check(`one of ours grew up near a league city (${kid?.name} — ${kidClub?.name})`, kidIdx > 0);
  const ctx = at(kidIdx);
  check('…and the hometown pick finds them when we visit', hometownPlayer(S(), sched[kidIdx].opponent)?.id === kid.id);
  const bad = [];
  for (const d of [...OFFDAY_POOL, ...ROAD_POOL, ...AWAY_FOLLOWUPS.map(e => e.card)]) {
    const c = CE.deliverCardById(d.id, ctx);
    if (!c) { bad.push(`${d.id}: not made`); continue; }
    if (!readsRight(c)) bad.push(`${d.id}: ${c.subject} / ${c.body}`);
  }
  check(`all ${OFFDAY_POOL.length + ROAD_POOL.length + AWAY_FOLLOWUPS.length} read right (voice, tokens, neutral)`, bad.length === 0, bad.join('\n      '));
  const sample = ['od1', 'od6', 'odn1', 'rd1', 'rd3', 'rv6', 'rv6_damage'].map(id => S().inbox.find(c => c.cardId === id)).filter(Boolean);
  sample.forEach(say);

  const rd3 = S().inbox.find(c => c.cardId === 'rd3');
  check('the hometown message names our player, in the city we visit', rd3 && rd3.body.includes(kid.name) && rd3.body.includes(kidClub.city || kidClub.name.split(' ')[0]));
  const before = S().players[kid.id].gmRelationship ?? 50;
  CE.resolve(rd3.instanceId, 'yes');
  check(`…holding the seats: the player thinks better of the GM (${before} → ${S().players[kid.id].gmRelationship})`, S().players[kid.id].gmRelationship > before);

  const golf = S().inbox.find(c => c.cardId === 'od6');
  const r0 = rapportOf(S(), golf._gmTeamId);
  CE.resolve(golf.instanceId, 'yes');
  check(`golf with another club's GM: our rapport with that club goes up (${r0} → ${rapportOf(S(), golf._gmTeamId)})`, !!golf._gmTeamId && rapportOf(S(), golf._gmTeamId) === r0 + 4
    && golf.sender.includes(S().leagueTeams.find(t => t.id === golf._gmTeamId).name));

  const pen = S().inbox.find(c => c.cardId === 'od3');
  const plans0 = (S().developmentPlans || []).length;
  CE.resolve(pen.instanceId, 'yes');
  const p = S().players[pen._targetPlayerId];
  check('an off-day bullpen session: real work on the pitcher it names, no games away', (S().developmentPlans || []).length === plans0 + 1
    && S().developmentPlans.at(-1).playerId === p.id && !p.unavailable);
}

console.log('\nThe ballpark while we\'re away');
{
  // The first game of a road trip three games or longer.
  const tripIdx = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && sched[i - 1].isHome && [0, 1, 2].every(k => reg(i + k) && !sched[i + k].isHome));
  const ctx = at(tripIdx);
  const funds0 = S().userTeam.finances.funds;
  const rv6 = CE.deliverCardById('rv6', ctx);
  CE.resolve(rv6.instanceId, 'yes');
  check(`the festival booked: the fee comes in (${rv6._revenueK}K)`, rv6._revenueK > 0 && Math.round(S().userTeam.finances.funds - funds0) === rv6._revenueK,
    `${S().userTeam.finances.funds - funds0}`);
  const home = sched.find(g => g.isHome && g.gameTime > clock.get() + 2 * HOUR);
  const after = (S().scheduledCards || []).find(c => ['rv6_damage', 'rv6_good', 'rv6_noise'].includes(c.cardId));
  check(`how it went comes the morning we're home (${after?.cardId}, ${after && new Date(after.deliverAtMs).toString().slice(0, 21)}; first pitch ${new Date(home.gameTime).toString().slice(16, 21)})`,
    !!after && dayOf(after.deliverAtMs) === dayOf(home.gameTime) && hr(after.deliverAtMs) >= 10 && hr(after.deliverAtMs) <= 11.5 && after.deliverAtMs < home.gameTime);
  // Every outcome is possible: over many bookings each comes up, damage most often.
  const seen = {};
  for (let k = 0; k < 60; k++) SM.speculate(() => {
    seedRandom(500 + k);
    const c = CE.deliverCardById('rv6', ctx); CE.resolve(c.instanceId, 'yes');
    const o = SM.get().scheduledCards.filter(x => x.cardId.startsWith('rv6_')).at(-1);
    seen[o.cardId] = (seen[o.cardId] || 0) + 1;
  });
  check(`each outcome comes up (${JSON.stringify(seen)})`, seen.rv6_damage > 15 && seen.rv6_good > 10 && seen.rv6_noise > 2);

  const dmg = CE.deliverCardById('rv6_damage', ctx);
  const f1 = S().userTeam.finances.funds;
  CE.resolve(dmg.instanceId, 'yes');
  check(`a repair costs what it says (${dmg._budgetCost}K)`, dmg._budgetCost > 0 && Math.round(f1 - S().userTeam.finances.funds) === dmg._budgetCost);

  // One booking a road trip: with the festival dealt on this trip, no other booking is offered.
  let elig = [];
  CE.cardDebug.onEligible = (moment, ids) => { if (moment === 'road') elig = ids; };
  SM.speculate(() => { at(tripIdx + 1); SM.mutate(s => { (s.cardLog ||= {}).rv6 = { n: { [s.seasonNum || 1]: 1 }, lastMs: clock.get() - HOUR, choice: 'yes', choiceSeason: s.seasonNum || 1 }; }); CE.checkAndDeliver(buildCardContext()); });
  const withOne = elig.filter(id => PARK_EVENT_IDS.includes(id));
  SM.speculate(() => { at(tripIdx); CE.checkAndDeliver(buildCardContext()); });
  const fresh = elig.filter(id => PARK_EVENT_IDS.includes(id));
  CE.cardDebug.onEligible = null;
  check(`one booking a road trip (offered at the trip's start: ${fresh.length}; once one is booked: ${withOne.length})`, fresh.length >= 5 && withOne.length === 0);
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
