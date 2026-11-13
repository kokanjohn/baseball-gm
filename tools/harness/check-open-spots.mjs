// r153 Our open spots wait for the GM; every arrival reports to the bench; the Team screen's MOVE.
//   node tools/harness/check-open-spots.mjs
// A real league. A lineup slot, a rotation turn or a bullpen spot that opens
// stays open until the next game's roster deadline (an hour before first
// pitch): the manager says what will happen, the GM can fill it from Team
// (MOVE) or have it done now, and at the deadline the manager fills it (a
// line in Recent). Inside the last hour, an open spot is filled at once.
// Signings, claims and trades land on the bench / pitcher bench.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock, gmMove, gmSignFreeAgent } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox } from '../../engine/CardEngine.js';
import { moveOptions, managerFillsNow, managerFillAt, openSpots, eligibleSlotsFor, tradedAway } from '../../engine/RosterEngine.js';
import { PLAYER_GROUP, GAME_STATUS, ROSTER_DECISION_LEAD_MS } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;
const MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d/;

seedRandom(31);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(SM.get().schedule[0].gameTime - 8 * 3600_000);
advanceClock(clock.get()); releaseDueCards();

const P = (id) => SM.get().players[id];
const U = () => SM.get().userTeam;
const slots = () => U().lineupSlots;
const pen = () => U().rosterIds.filter(id => P(id)?.group === PLAYER_GROUP.BULLPEN);
const open = (cardId) => getInbox().filter(c => c.cardId === cardId && !c.resolved);
const nextGame = () => SM.get().schedule.find(g => !g._committed && Number.isFinite(g.gameTime));

function step(ms) {
  const target = clock.get() + ms;
  for (let guard = 0; guard < 50; guard++) {
    const st = SM.get();
    const i = st.schedule.findIndex(g => !g._committed && Number.isFinite(g.gameTime));
    const g = st.schedule[i];
    if (!g || g.gameTime > target) break;
    clock.set(g.gameTime); advanceClock(clock.get()); releaseDueCards();
    SM.mutate(s => { Object.assign(s.schedule[i], { _committed: true, status: GAME_STATUS.FINAL }); s.currentGameIndex = i + 1; });
  }
  clock.set(target); advanceClock(clock.get()); releaseDueCards();
}
/** To `ms` before our next first pitch. */
const toBefore = (ms) => step(nextGame().gameTime - ms - clock.get());
const move = (id, pred) => { const o = moveOptions(SM.get(), id).find(pred); return o ? gmMove(id, o.key, clock.get()).ok : false; };

check('the full nine, five turns and five in the pen to start',
      slots().every(sl => sl.playerId) && U().rotation.order.length === 5 && pen().length === 5);
check('eight hours before first pitch: the GM\'s time, not the manager\'s', !managerFillsNow(SM.get(), clock.get()));

// ── 1. MOVE: the choices ──
console.log('\nMOVE');
// (r162 a new club's roster isn't fully sorted: the infield spot with a bench backup — SS when it has one)
const _backed = (sl) => moveOptions(SM.get(), sl.playerId).some(o => o.key.startsWith('in:'));
const ssIdx = (() => { const i = slots().findIndex(sl => sl.slot === 'SS' && _backed(sl)); return i >= 0 ? i : slots().findIndex(sl => ['2B', '3B', '1B', 'SS'].includes(sl.slot) && _backed(sl)); })();
const ss = slots()[ssIdx].playerId;
const SS = slots()[ssIdx].slot;   // (the spot's label)
const ssOpts = moveOptions(SM.get(), ss);
check('a starter can go to the bench (open, or a bench bat who can play there takes it)',
      ssOpts.some(o => o.key === 'bench') && ssOpts.filter(o => o.key.startsWith('in:')).every(o => eligibleSlotsFor(P(o.key.slice(3))).includes(SS)),
      JSON.stringify(ssOpts));
check('…and to any other slot they can play, never one they can\'t',
      ssOpts.filter(o => o.key.startsWith('slot:')).every(o => eligibleSlotsFor(P(ss)).includes(slots()[+o.key.slice(5)].slot))
      && ssOpts.filter(o => o.oop).every(o => !eligibleSlotsFor(P(ss)).includes(o.label)));
const benchBat = U().rosterIds.find(id => !['SP', 'RP'].includes(P(id).pos) && !slots().some(sl => sl.playerId === id));
const bbOpts = moveOptions(SM.get(), benchBat).filter(o => !o.oop);   // (r165 out-of-position spots are their own, behind a button)
check('a bench bat: only the slots they can play, each saying who goes to the bench',
      bbOpts.length > 0 && bbOpts.every(o => o.key.startsWith('slot:') && eligibleSlotsFor(P(benchBat)).includes(o.label)), JSON.stringify(bbOpts));

// ── 2. A lineup slot opens and waits ──
console.log('\nAn open slot waits for the GM');
check('benching the shortstop leaves SS open', move(ss, o => o.key === 'bench') && !slots()[ssIdx].playerId && P(ss).group === PLAYER_GROUP.BENCH_HITTERS);
step(5 * 60_000);
check('…still open minutes later (the manager waits)', !slots()[ssIdx].playerId);
check('…and it isn\'t an open roster spot (nobody needs signing)', !getInbox().some(c => c.cardId === 'roster_need' && !c.resolved));
step(30 * 60_000);
let card = open('open_spots')[0];
check('the manager says what\'s open and what happens at the deadline', !!card && card.body.includes(SS) && card.expiresAtMs === managerFillAt(SM.get()),
      JSON.stringify(getInbox().filter(c => !c.resolved).map(c => c.cardId)));
if (card) {
  console.log(`    ${card.sender}: “${card.subject}” — ${card.body}`);
  console.log(`    [${card.yesLabel}]  [${card.noLabel}]`);
  check('gender-neutral, no calendar dates', !GEN.test(card.body + card.subject) && !MONTH.test(card.body + card.preview));
}
const pick = moveOptions(SM.get(), ss).length ? U().rosterIds.find(id => !['SP', 'RP'].includes(P(id).pos) && id !== ss
  && !slots().some(sl => sl.playerId === id) && eligibleSlotsFor(P(id)).includes(SS)) : null;
check('the GM fills it from Team: a bench bat to SS', !!pick && move(pick, o => o.key === `slot:${ssIdx}`) && slots()[ssIdx].playerId === pick);
check('…and the manager\'s message is withdrawn', !open('open_spots').length);
check('the shortstop goes back (the fill-in to the bench)', move(ss, o => o.key === `slot:${ssIdx}`) && slots()[ssIdx].playerId === ss && P(pick).group === PLAYER_GROUP.BENCH_HITTERS);

// ── 3. A rotation turn and a pen spot wait too; the deadline fills all three ──
console.log('\nThe deadline: the manager fills what is still open');
const nextSP = () => U().rotation.order[(U().rotation.currentIndex || 0) % U().rotation.order.length];
const nextBefore = nextSP();
const sp3 = U().rotation.order.find(id => id !== nextBefore);
const rp = pen()[0];
move(ss, o => o.key === 'bench'); move(sp3, o => o.key === 'bench'); move(rp, o => o.key === 'bench');
check('SS, a rotation turn and a pen spot open', !slots()[ssIdx].playerId && U().rotation.order.length === 4 && pen().length === 4,
      JSON.stringify({ ss: slots()[ssIdx].playerId, rot: U().rotation.order.length, pen: pen().length }));
check('benching a starter keeps the next starter up', nextSP() === nextBefore);
check('openSpots sees all three', (() => { const o = openSpots(SM.get()); return o.lineup.length === 1 && o.rotation === 1 && o.bullpen === 1; })());
toBefore(ROSTER_DECISION_LEAD_MS + 5 * 60_000);
check('five minutes before the deadline: still open', !slots()[ssIdx].playerId && U().rotation.order.length === 4 && pen().length === 4);
card = getInbox().find(c => c.cardId === 'open_spots');
step(10 * 60_000);
check('at the deadline the manager fills all three', !!slots()[ssIdx].playerId && U().rotation.order.length === 5 && pen().length === 5,
      JSON.stringify({ ss: slots()[ssIdx].playerId, rot: U().rotation.order.length, pen: pen().length }));
const news = (SM.get().activityFeed || []).filter(e => e.type === 'ours' && /filled our open spots/.test(e.text)).at(-1);
check('…with a line in Recent, not a message', !!news, JSON.stringify((SM.get().activityFeed || []).slice(-3)));
if (news) console.log(`    Recent: ${news.text}`);
const resolvedCard = SM.get().inbox.find(c => c.instanceId === card?.instanceId);
check('the manager\'s message settled at the deadline', !card || resolvedCard?.resolved, JSON.stringify(resolvedCard && { r: resolvedCard.resolved, c: resolvedCard.choice }));

// ── 4. Inside the last hour, an open spot is filled at once ──
console.log('\nInside the last hour');
check('it is the manager\'s time', managerFillsNow(SM.get(), clock.get()));
const lf = slots().find(sl => sl.slot === 'OF').playerId;
move(lf, o => o.key === 'bench');
check('a starter benched now is replaced at once', slots().every(sl => sl.playerId));

// ── 5. "Do it that way now" ──
step(nextGame().gameTime - clock.get() + 5 * 3600_000);   // past this game, the evening after
const c3 = slots().find(sl => sl.slot === 'C');
move(c3.playerId, o => o.key === 'bench');
step(30 * 60_000);
card = open('open_spots')[0];
check('the next open slot gets the manager\'s message', !!card);
if (card) { resolve(card.instanceId, 'yes'); advanceClock(clock.get()); }
check('"Do it that way now" fills it at once', slots().every(sl => sl.playerId));

// ── 6. Arrivals report to the bench ──
console.log('\nEvery arrival reports to the bench');
const fa = (pos) => (SM.get().freeAgentPool || []).map(P).filter(p => p && p.pos === pos).sort((a, b) => b.ovr - a.ovr)[0];
const rpFA = fa('RP');
const weakRP = U().rosterIds.map(P).filter(p => p.pos === 'RP' && p.group === PLAYER_GROUP.PITCHER_BENCH).sort((a, b) => a.ovr - b.ovr)[0]
  || U().rosterIds.map(P).filter(p => p.pos === 'RP').sort((a, b) => a.ovr - b.ovr)[0];
const res = gmSignFreeAgent(rpFA.id, weakRP.id, clock.get());
check('a reliever signs', res.ok, res.reason);
const tx = SM.get().transactions.find(t => t.playerId === rpFA.id && t.status === 'pending');
check('…headed for the pitcher bench, not the bullpen', tx?.toGroup === PLAYER_GROUP.PITCHER_BENCH, tx?.toGroup);
check('…and can\'t be moved before reporting', moveOptions(SM.get(), rpFA.id).length === 0);
step(tx.effectiveAt - clock.get() + 60_000);
check('reported: on the pitcher bench', P(rpFA.id).group === PLAYER_GROUP.PITCHER_BENCH && U().rosterIds.includes(rpFA.id), P(rpFA.id).group);
check('…and the GM can move them into the pen', move(rpFA.id, o => o.key.startsWith('pen:')) && P(rpFA.id).group === PLAYER_GROUP.BULLPEN && pen().length === 5);

// ── 7. A trade waiting on tonight's final out: the players we send can't move ──
const anyId = U().rosterIds.find(id => !['SP', 'RP'].includes(P(id).pos));
SM.mutate(s => { s.transactions.push({ id: 'tx-test', kind: 'trade', teamId: 'user', fromTeamId: s.leagueTeams[0].id, offer: { incomingIds: [], outgoingIds: [anyId] }, status: 'pending', createdAt: clock.get(), effectiveAt: clock.get() + 86_400_000 * 30 }); });
check('a player already traded has no MOVE', tradedAway(SM.get(), anyId) && moveOptions(SM.get(), anyId).length === 0);
SM.mutate(s => { s.transactions = s.transactions.filter(t => t.id !== 'tx-test'); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
