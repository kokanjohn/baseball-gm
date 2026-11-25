/**
 * tools/harness/check-callbacks.mjs — r220 §122.99 callbacks: a later message back to a decision the GM made.
 *   - the record carries who and what a decision was about (the player, the other club, the money, the numbers);
 *   - each callback: only from a real decision, in its window, while its people are still around; what happened
 *     since from the real numbers; about half open a new decision (and do what they say);
 *   - one per decision, one a day, the next afternoon; voice, neutral, no raw tokens.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, buildCardContext } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import * as GMP from '../../engine/GMProfile.js';
import { CALLBACKS, pickCallback } from '../../engine/Callbacks.js';
import { hometownOf } from '../../engine/AwayDays.js';
import { senderLabel } from '../../engine/Senders.js';
import { voiceProblems } from './voice-rules.mjs';
import { PHASE, SPRING_TRAINING_GAME_COUNT } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000, DAY = 24 * HOUR;
const GEN = /\b(he|him|his|she|her|hers|himself|herself)\b/i;
const personOf = (s) => (String(s).match(/^(.+?) \(/) || [])[1] || null;
const readsRight = (c) => voiceProblems(c, personOf).length === 0 && !GEN.test(`${c.body} ${c.preview} ${c.yesMsg || ''} ${c.noMsg || ''}`) && !/\{[a-z0-9_]+\}|undefined|NaN/.test(`${c.subject} ${c.body} ${c.preview}`);
const all = [];
const say = (c) => { all.push(c); console.log(`    ${senderLabel(c, S())} — ${c.subject}\n      ${c.body}\n      [${c.yesLabel}${c.noLabel ? ` / ${c.noLabel}` : ''}]`); };

seedRandom(101);
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const sched = S().schedule;
const reg = (i) => sched[i] && !sched[i].isSpring && !sched[i].isPlayoff;
const at = (i) => { SM.mutate(s => { s.phase = PHASE.REGULAR_SEASON; s.currentGameIndex = i; s.schedule.forEach((g, k) => { g._committed = k < i; }); s.inbox = []; s.scheduledCards = []; }); clock.set(sched[i - 1].gameTime + 3 * HOUR); return clock.get(); };
const hitters = () => S().userTeam.lineupSlots.map(x => S().players[x.playerId]);
const rec = (o, atMs) => SM.mutate(s => { GMP.recordDecision(s, { noLabel: 'No', yesLabel: 'Yes', autoResolve: 'no', yesEffect: {}, noEffect: {}, _raw: {}, ...o }, o._c || 'yes', atMs); });
const fit = (key, atMs = clock.get()) => {
  const cb = CALLBACKS.find(c => c.key === key);
  const e = S().gmRecord.log.filter(x => cb.match ? cb.match(x) : cb.from.includes(x.id)).at(-1);
  const age = e ? (atMs - e.at) / DAY : -1;
  if (!e || age < cb.days[0] || age > cb.days[1]) return null;   // (its window, as pickCallback reads it)
  const ctx = cb.fits(S(), e, atMs, null);
  return ctx ? cb.build(S(), e, ctx, atMs) : null;
};
const games = (p, from, n, st) => SM.mutate(s => { s.players[p.id]._impGameLog = Array.from({ length: n }, (_, k) => ({ gameIndex: k, atMs: from + (k + 1) * DAY, stats: st })); });

const mid = sched.findIndex((g, i) => i > SPRING_TRAINING_GAME_COUNT + 60 && reg(i) && reg(i - 1));
let now = at(mid);

console.log('The record');
{
  const a = CE.deliverCardById('od1', buildCardContext());
  CE.resolve(a.instanceId, 'yes');
  const e = S().gmRecord.log.at(-1);
  check('a decision about a player names them', e.id === 'od1' && e.p === a._targetPlayerId);
}

console.log('\nEach callback');
{
  SM.mutate(s => { s.gmRecord = { log: [], seasons: {} }; });
  const [p1, p2, p3] = hitters();
  // The flight home, 30 days ago.
  rec({ cardId: 'od1', _targetPlayerId: p1.id, _budgetCost: 10 }, now - 30 * DAY);
  let c = fit('flight'); say(c);
  check('the flight home: the player, the month, real', c && c.body.includes(p1.name) && c.body.includes(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][new Date(now - 30 * DAY).getMonth()]));
  SM.speculate(() => { SM.mutate(s => { s.players[p1.id].teamId = s.leagueTeams[0].id; }); check('…not once they\'re gone', fit('flight') == null); });
  SM.speculate(() => { SM.mutate(s => { s.gmRecord.log.at(-1).at = now - 5 * DAY; }); check('…not before its time', fit('flight') == null); });

  // A slump, sat 20 days ago; since then good, then bad.
  rec({ cardId: 'sit_slump', _targetPlayerId: p2.id, _cbData: { h: 3, ab: 40 } }, now - 20 * DAY);
  games(p2, now - 20 * DAY, 10, { ab: 4, h: 2, hr: 0 });
  c = fit('slump'); say(c);
  check('sat in a slump, since: .500 — news, the real line', c && !c.noLabel && /3-for-40/.test(c.body) && /\.500/.test(c.body));
  games(p2, now - 20 * DAY, 10, { ab: 4, h: 0, hr: 0 });
  c = fit('slump'); say(c);
  check('…still cold: the coach asks to start the work (a decision)', c && c.noLabel && c._raw.onYes === 'offday_session');

  // A booking of the festival last season.
  rec({ cardId: 'rv6', _revenueK: 150 }, now - 300 * DAY);
  c = fit('event_back'); say(c);
  check('the festival wants to come back, paying more than last time', c && c._revenueK === 180 && /festival/.test(c.body) && c.noLabel);

  // A trade 30 days ago: the player who came over.
  const other = S().leagueTeams[1];
  rec({ cardId: `trade_${other.id}`, _proposingTeamId: other.id, _tradeOffer: { incomingIds: [p3.id] }, _raw: { onYes: 'trade_execute' } }, now - 30 * DAY);
  games(p3, now - 30 * DAY, 12, { ab: 4, h: 1, hr: 1 });
  c = fit('trade'); say(c);
  check('since the trade: the club it came from, the real line', c && c.body.includes(other.name) && /is hitting \.250 with 12 home runs/.test(c.body));

  // A player let go in the winter, now with another club.
  const gone = hitters()[4];
  rec({ cardId: 'os_resign', _targetPlayerId: gone.id, _c: 'no', _raw: { onYes: 'os_resign', onNo: 'os_walk' } }, now - 80 * DAY);
  SM.mutate(s => { const x = s.players[gone.id]; x.teamId = s.leagueTeams[2].id; x.stats = { ...x.stats, ab: 200, h: 64, hr: 9 }; });
  c = fit('gone'); say(c);
  check('let go in the winter: where they are, how they\'re doing', c && c.body.includes(S().leagueTeams[2].name) && /is hitting \.320/.test(c.body));
  SM.mutate(s => { s.players[gone.id].teamId = 'user'; });

  // The exit meeting: we said we'd look at a bigger role.
  const bench = S().userTeam.rosterIds.map(id => S().players[id]).find(p => p.group === 'bh');
  rec({ cardId: 'wt_exit', _targetPlayerId: bench.id }, now - 120 * DAY);
  SM.mutate(s => { s.players[bench.id].stats.g = 5; });
  c = fit('exit'); say(c);
  check('the bigger role, not given: a decision with the real games', c && c.noLabel && /played 5 of our \d+ games/.test(c.body));
}

console.log('\nExtra work, once it\'s done');
{
  const p = hitters()[5];
  rec({ cardId: 'tr3', _targetPlayerId: p.id }, now - 40 * DAY);
  SM.mutate(s => { (s.developmentPlans ||= []).push({ id: 'x', playerId: p.id, source: 'tr3', createdAt: now - 40 * DAY, status: 'done', applied: 2 }); });
  const c = fit('work'); if (c) say(c);
  check('it took: the coach says so, the month real', c && /it took/.test(c.body) && c.body.includes(p.name));
  SM.mutate(s => { s.developmentPlans.at(-1).status = 'active'; });
  check('…not while it\'s still going', fit('work') == null);
}

console.log('\nThe hometown, next visit');
{
  const kid = S().userTeam.rosterIds.map(id => S().players[id]).find(p => hometownOf(S(), p) && ['sh', 'bh', 'sp', 'bp'].includes(p.group));
  const club = S().leagueTeams.find(t => t.id === hometownOf(S(), kid));
  const i = sched.findIndex((g, k) => k > mid && reg(k) && !g.isHome && g.opponentId === club.id && (sched[k - 1].opponentId !== g.opponentId || sched[k - 1].isHome));
  now = at(i);
  rec({ cardId: 'rd3', _tokenPlayers: { hometown_player: kid.id }, _budgetCost: 15 }, now - 60 * DAY);
  const cb = CALLBACKS.find(x => x.key === 'hometown'), e = S().gmRecord.log.at(-1);
  const next = { ...sched[i], opener: true };
  const ctx = cb.fits(S(), e, now, next);
  const c = ctx && cb.build(S(), e, ctx, now); if (c) say(c);
  check(`the family again, the same seats at the same price (${kid.name}, ${club.name})`, c && c._budgetCost === 15 && c.body.includes(kid.name) && c.body.includes(club.name));
  check('…not when we play elsewhere', cb.fits(S(), e, now, { ...next, opponentId: S().leagueTeams.find(t => t.id !== club.id).id }) == null);
}

console.log('\nDelivery');
{
  now = at(mid);
  SM.mutate(s => { s.gmRecord = { log: [], seasons: {} }; s.callbacks = { used: {} }; });
  const p = hitters()[0];
  rec({ cardId: 'od1', _targetPlayerId: p.id, _budgetCost: 10 }, now - 30 * DAY);
  // How often: over 80 games, each on a scratch copy.
  let hits = 0;
  for (let k = 0; k < 80; k++) SM.speculate(() => { if (CE.deliverCallback(now + k * 60_000, buildCardContext())) hits++; });
  check(`now and then after a game (${hits} of 80)`, hits >= 10 && hits <= 32);
  let got = null;
  for (let k = 0; k < 60 && !got; k++) got = CE.deliverCallback(now + k * 60_000, buildCardContext());
  const h = new Date(got.deliverAtMs).getHours();
  check('the next afternoon, 1–4pm', h >= 13 && h < 16 && new Date(got.deliverAtMs).getDate() !== new Date(now).getDate());
  let again = null;
  for (let k = 0; k < 80 && !again; k++) again = CE.deliverCallback(now + 2 * DAY + k * 60_000, buildCardContext());
  check('one per decision', again == null);
}

check(`every callback reads right (${all.length})`, all.every(readsRight), all.filter(c => !readsRight(c)).map(c => `${c.subject}: ${c.body}`).join('\n      '));
console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
