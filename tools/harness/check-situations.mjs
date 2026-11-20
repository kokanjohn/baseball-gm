/**
 * tools/harness/check-situations.mjs — r218 §122.97 messages from what's happening.
 *   - a milestone (at home: mark it, the cost charged; on the road: news), once;
 *   - a first-year player on a tear; a run of injuries; a regular gone cold (sit them: a real day off);
 *   - the series against the closest club in the division (home: a rivalry weekend; road: the manager);
 *   - one a day, the next morning (9:30–11:00); nothing before the 15th game; voice, neutral, no raw tokens.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { findSituations } from '../../engine/Situations.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE, SPRING_TRAINING_GAME_COUNT, PLAYER_GROUP } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000, DAY = 24 * HOUR;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const hr = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
const personOf = (s) => (String(s).match(/^(.+?) \(/) || [])[1] || null;
const readsRight = (c) => voiceProblems(c, personOf).length === 0 && !GEN.test(`${c.body} ${c.preview} ${c.yesMsg || ''} ${c.noMsg || ''}`) && !/\{[a-z0-9_]+\}|undefined|NaN/.test(`${c.subject} ${c.body} ${c.preview}`);
const say = (c) => console.log(`    ${new Date(c.deliverAtMs).toString().slice(0, 21)}  ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}\n      [${c.yesLabel}${c.noLabel ? ` / ${c.noLabel}` : ''}]`);
const all = [];

seedRandom(81);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; });
const sched = S().schedule;
/** Put the season after game i-1 (played): the clock at its final; returns the final. */
const after = (i) => {
  SM.mutate(s => { s.currentGameIndex = i; s.schedule.forEach((g, k) => { g._committed = k < i; }); s.inbox = []; s.scheduledCards = []; s.situations = { done: {} }; });
  const end = sched[i - 1].gameTime + 3 * HOUR;
  clock.set(end);
  return end;
};
const reg = (i) => sched[i] && !sched[i].isSpring && !sched[i].isPlayoff;
// A home game next, the day after a game, well into the season (and not a series opener: no rival in the way).
const homeNext = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && g.isHome && sched[i - 1].isHome && sched[i - 1].opponent === g.opponent);
const roadNext = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 40 && reg(i) && !g.isHome && !sched[i - 1].isHome && sched[i - 1].opponent === g.opponent);
const hitters = () => S().userTeam.lineupSlots.map(x => S().players[x.playerId]);
const deliver = (end) => { const c = CE.deliverSituation(end, buildCardContext()); if (c) { all.push(c); say(c); } return c; };

console.log('A milestone');
{
  let end = after(homeNext);
  const p = hitters()[0];
  SM.mutate(s => { s.players[p.id].stats.hr = 30; });
  const c = deliver(end);
  check(`a 30th home run, next morning 9:30–11:00 (${c?.subject})`, c?.cardId === 'sit_milestone' && c.subject === `${p.name}'s 30th home run` && hr(c.deliverAtMs) >= 9.5 && hr(c.deliverAtMs) <= 11 && new Date(c.deliverAtMs).getDate() !== new Date(end).getDate());
  check('at home next: mark it tonight (a cost)', c.noLabel && c._budgetCost > 0);
  check('…once', CE.deliverSituation(end + DAY, buildCardContext()) == null || !findSituations(S(), end + DAY).some(x => x.kind === 'milestone' && x.playerId === p.id));
  end = after(roadNext);
  SM.mutate(s => { s.players[p.id].stats.hr = 40; });
  const r = deliver(end);
  check('on the road: news', r?.cardId === 'sit_milestone' && !r.noLabel && /on the road/.test(r.body));
  SM.mutate(s => { s.players[p.id].stats.hr = 47; s.situations = { done: {} }; });
  check('long past a mark: no news', !findSituations(S(), end).some(x => x.kind === 'milestone'));
  SM.mutate(s => { s.players[p.id].stats.hr = 0; });
}

console.log('\nA first-year player on a tear');
{
  const end = after(homeNext);
  const p = hitters()[1];
  SM.mutate(s => {
    const x = s.players[p.id]; x.seasonLog = []; x.dob = `${new Date(end).getFullYear() - 23}-05-01`;
    x._impGameLog = Array.from({ length: 15 }, (_, k) => ({ gameIndex: k, atMs: end - k * DAY, stats: { ab: 4, h: 2, hr: 0 } }));
  });
  const c = deliver(end);
  check(`the press wants them (${c?.subject})`, c?.cardId === 'sit_rookie' && /hitting \.500 over the last 15 games/.test(c.body));
  SM.mutate(s => { s.players[p.id]._impGameLog = []; s.players[p.id].seasonLog = [{ stats: { g: 100 } }]; });
}

console.log('\nA regular gone cold');
{
  const end = after(homeNext);
  const p = hitters()[2];
  SM.mutate(s => { s.players[p.id]._impGameLog = Array.from({ length: 10 }, (_, k) => ({ gameIndex: k, atMs: end - k * DAY, stats: { ab: 4, h: k < 3 ? 1 : 0 } })); });
  const c = deliver(end);
  check(`the hitting coach (${c?.subject})`, c?.cardId === 'sit_slump' && c.subject === `${p.name} is 3-for-40`);
  check('…answered by first pitch', c.expiresAtMs === sched[homeNext].gameTime - 30 * 60_000);
  clock.set(c.deliverAtMs); CE.releaseDueCards(c.deliverAtMs);
  CE.resolve(c.instanceId, 'yes');
  check('sit them: a real day off (out of the lineup tonight)', S().players[p.id].unavailable?.reason === 'rest' && !S().userTeam.lineupSlots.some(x => x.playerId === p.id));
  SM.mutate(s => { s.players[p.id]._impGameLog = []; });
}

console.log('\nA run of injuries');
{
  const end = after(homeNext);
  const ids = S().userTeam.rosterIds.filter(id => S().players[id].group === PLAYER_GROUP.BULLPEN).slice(0, 3);
  SM.mutate(s => { ids.forEach((id, k) => { s.players[id].group = PLAYER_GROUP.IL; s.players[id].injury = { status: 'il', injuredAt: end - (k + 1) * DAY }; }); });
  const c = deliver(end);
  check(`the trainer names all three (${c?.subject})`, c?.cardId === 'sit_injuries' && ids.every(id => c.body.includes(S().players[id].name)) && c._budgetCost > 0);
  SM.mutate(s => { ids.forEach(id => { s.players[id].group = PLAYER_GROUP.BULLPEN; s.players[id].injury = null; }); });
}

console.log('\nThe closest club');
{
  // A series opener against a division club; the standings put them a game behind us, the others far off.
  const div = S().userTeam.divisionId || 'A';
  const mates = S().leagueTeams.filter(t => t.divisionId === div);
  for (const home of [true, false]) {
    const i = sched.findIndex((g, k) => k > SPRING_TRAINING_GAME_COUNT + 40 && reg(k) && !!g.isHome === home && mates.some(t => t.name === g.opponent) && (sched[k - 1].opponent !== g.opponent || !!sched[k - 1].isHome !== home));
    const end = after(i);
    const them = mates.find(t => t.name === sched[i].opponent);
    const rows = [['user', 50, 40], [them.id, 49, 41], ...mates.filter(t => t.id !== them.id).map((t, k) => [t.id, 40 - k * 3, 50 + k * 3])];
    SM.mutate(s => { s.standings = { ...(s.standings || {}), [div === 'B' ? 'divB' : 'divA']: rows.map(([id, w, l]) => ({ id, name: id === 'user' ? s.userTeam.name : s.leagueTeams.find(t => t.id === id).name, wins: w, losses: l })) }; });
    const c = deliver(end);
    check(`${home ? 'at home: a rivalry weekend' : 'on the road: the manager'} (${c?.subject})`, c?.cardId === 'sit_rival' && c.body.includes(them.name) && /one game ahead of them/.test(c.body) && (home ? !!c.noLabel : !c.noLabel));
  }
}

console.log('\nOne a day; not too early');
{
  const end = after(homeNext);
  const [a, b] = hitters();
  SM.mutate(s => { s.players[a.id].stats.hr = 30; s.players[b.id].stats.h = 150; });
  const c1 = deliver(end), c2 = CE.deliverSituation(end + 60_000, buildCardContext());
  check('two milestones the same night: one message (the other waits)', !!c1 && c2 == null);
  const early = sched.findIndex((g, i) => reg(i) && reg(i - 1));
  SM.mutate(s => { s.situations = { done: {} }; });
  after(early + 5);
  SM.mutate(s => { s.players[a.id].stats.hr = 30; });
  check('nothing before the 15th game', findSituations(S(), clock.get()).length === 0);
}

check(`every message reads right (${all.length})`, all.every(readsRight), all.filter(c => !readsRight(c)).map(c => `${c.subject}: ${c.body}`).join('\n      '));
console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
