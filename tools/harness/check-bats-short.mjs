// r196 §122.73 A full roster that can't field nine: hitters held day-to-day (the spot stays theirs) and
// away leave fewer than nine bats for a game. The manager's message comes as soon as it's true, with a
// deadline the night before that game's day (a signing reports the next morning); the GM's move, or at
// the deadline the manager's: the day-to-day bat out longest to the IL, a free-agent bat into the spot.
// Either way the game is played with nine.
//   node tools/harness/check-bats-short.mjs
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox } from '../../engine/CardEngine.js';
import { getRosterNeeds } from '../../engine/TransactionEngine.js';
import { dayToDayUpdate } from '../../engine/InjuryEngine.js';
import { setUnavailable } from '../../engine/DevelopmentEngine.js';
import { PLAYER_GROUP, PHASE } from '../../data/constants.js';
import { voiceProblems } from './voice-rules.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;
const S = () => SM.get(), P = (id) => S().players[id], U = () => S().userTeam;
const DAY = 86_400_000;

/** A fresh club, regular season; the next game two days off; six of our 14 bats out (three day-to-day, three away). */
async function setup(seed, archetypeId) {
  seedRandom(seed);
  await startNewGame({ archetypeId, gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                       abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
  const g = S().schedule[S().currentGameIndex];
  clock.set(g.gameTime - 2 * DAY);
  advanceClock(clock.get()); releaseDueCards();
  const now = clock.get();
  const bats = U().rosterIds.map(P).filter(p => p && !['SP', 'RP'].includes(p.pos) && p.group !== PLAYER_GROUP.IL);
  SM.mutate(s => {
    s.phase = PHASE.REGULAR_SEASON;
    bats.slice(0, 3).forEach((p, i) => Object.assign(s.players[p.id], dayToDayUpdate({ ...s.players[p.id], injury: { injuredAt: now - DAY, days: 6 + i * 3, status: 'evaluating' } })));
    bats.slice(3, 6).forEach(p => setUnavailable(s, p.id, { reason: 'leave', games: 4 }, now));
  });
  advanceClock(clock.get() + 60_000); releaseDueCards();
  return { g, dtd: bats.slice(0, 3).map(p => p.id), away: bats.slice(3, 6).map(p => p.id) };
}
const card = () => getInbox().find(c => c.cardId === 'bats_short' && !c.resolved);
const step = (to) => { for (let t = clock.get(); t < to; t += 15 * 60_000) { clock.set(Math.min(to, t + 15 * 60_000)); advanceClock(clock.get()); releaseDueCards(); } };

console.log('Nobody answers: the manager makes the move');
{
  const { g, dtd } = await setup(5, 'contender');
  const n = getRosterNeeds(S(), 'user', clock.get());
  check(`six bats out: ${9 - n.batsShort} can play the game, ${n.bats.length} to fix`, n.batsShort === 1 && n.bats.length === 1);
  const longest = dtd.slice().sort((a, b) => P(b).injury.returnAt - P(a).injury.returnAt)[0];
  const day = new Date(g.gameTime); day.setHours(0, 0, 0, 0);
  check(`a deadline the night before the game's day (${new Date(U().batsDeadlineAt).toString().slice(0, 21)})`, U().batsDeadlineAt === day.getTime() - 10 * 60_000);
  step(clock.get() + 3 * 3600_000);
  const c = card();
  check(`the manager's message: “${c?.subject}”`, !!c && c._targetPlayerId === longest && /IL/.test(c.yesLabel));
  console.log(`    ${c?.body}`);
  console.log(`    [${(c?._choices || []).map(x => x.label).join(' / ')} / ${c?.noLabel}]`);
  check('…naming who is out, gender-neutral, in the manager\'s voice', !!c && dtd.every(id => c.body.includes(P(id).name)) && !GEN.test(c.body)
        && !voiceProblems(c, () => S().userTeam.coachingStaff.manager.name).length);
  step(U().batsDeadlineAt + 60_000 || clock.get());
  const filled = getInbox().find(c => c.cardId === 'manager_fill_bats');
  check(`at the deadline: ${P(longest).name} on the IL, a bat signed (“${filled?.subject}”)`, P(longest).group === PLAYER_GROUP.IL && !!filled);
  console.log(`    ${filled?.body}`);
  step(g.gameTime + 10 * 60_000);
  const lineup = U().lineupSlots.filter(s => s.playerId).length;
  check(`the game is played with nine (${lineup} in the lineup at first pitch)`, lineup === 9);
  check('…and the message is gone once fixed', !card());
}

console.log('The GM makes the move');
{
  const { dtd } = await setup(6, 'institution');
  step(clock.get() + 3 * 3600_000);
  const c = card();
  check('the message came', !!c);
  if (c) {
    const longest = c._targetPlayerId, pick = c._choices?.[0]?.key;
    resolve(c.instanceId, 'yes', { pick }); advanceClock(clock.get()); releaseDueCards();
    check(`yes: ${P(longest).name} on the IL, ${P(pick)?.name} signed (${P(pick)?.group})`, P(longest).group === PLAYER_GROUP.IL && P(pick)?.teamId === 'user');
    const n = getRosterNeeds(S(), 'user', clock.get());
    check('…and nine can play: no deadline, no move left', n.batsShort === 0 && U().batsDeadlineAt == null, `short ${n.batsShort}, deadline ${U().batsDeadlineAt}`);
    check('the other day-to-day bats keep their spots', dtd.filter(id => id !== longest).every(id => P(id).group !== PLAYER_GROUP.IL));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
