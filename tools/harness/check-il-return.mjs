// §113 Back from an injury — checks of the return card (who goes down) and the staff's nudge.
//   node tools/harness/check-il-return.mjs
// A real league in spring training: a starter goes on the IL, a fill-in takes
// the spot; when the starter is cleared, the Team Physician asks who goes down
// (the fill-in first — then the starter takes the spot straight back); when a
// reserve goes down instead, the hitting coach (or the pitching coach) asks
// about the lineup before the next game, the manager once more after it.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox } from '../../engine/CardEngine.js';
import { reconcileRoster, applyRosterMutation } from '../../engine/RosterEngine.js';
import { PLAYER_GROUP, PHASE, GAME_STATUS } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;

seedRandom(21);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
const st0 = SM.get();
clock.set(st0.schedule[0].gameTime - 6 * 3600_000);
advanceClock(clock.get()); releaseDueCards();

const P = (id) => SM.get().players[id];
const slotOf = (id) => SM.get().userTeam.lineupSlots.find(sl => sl.playerId === id)?.slot || null;
// The clock moves on; a game whose first pitch it passes is played (marked final — this check
// is about the inbox, and the roster clock waits at an unplayed game's first pitch).
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
const cardFor = (cardId, id) => getInbox().find(c => c.cardId === cardId && c._targetPlayerId === id && !c.resolved);

/** Put a player on the IL now, eligible to return in `hours`. */
function hurt(id, hours) {
  const now = clock.get();
  SM.mutate(s => {
    Object.assign(s.players[id], { isInjured: true, group: PLAYER_GROUP.IL,
      injury: { status: 'il', injuredAt: now, eligibleAt: now + hours * 3600_000, ilDays: 10 } });
    applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: now }));
  });
}
/** Fill the active roster to 28 with farm players so a return needs a corresponding move. */
function fillRoster() {
  SM.mutate(s => {
    const u = s.userTeam;
    const active = () => u.rosterIds.filter(id => s.players[id].group !== PLAYER_GROUP.IL).length;   // (the IL doesn't count)
    while (active() < 28 && u.farmIds.length) {
      const id = u.farmIds.shift();
      u.rosterIds.push(id);
      const p = s.players[id];
      p.group = p.pos === 'SP' ? PLAYER_GROUP.PITCHER_BENCH : p.pos === 'RP' ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.BENCH_HITTERS;
    }
  });
}
// The regular season's 28-man squeeze (spring rosters run large).
SM.mutate(s => {
  s.phase = PHASE.REGULAR_SEASON;
  const u = s.userTeam;
  const keep = new Set([...u.lineupSlots.map(sl => sl.playerId), ...(u.rotation?.order || [])]);
  while (u.rosterIds.length > 28) {
    const i = u.rosterIds.findIndex(id => !keep.has(id) && s.players[id].pos !== 'SP');
    const [id] = u.rosterIds.splice(i, 1);
    u.farmIds.push(id);
    s.players[id].group = 'farm';
  }
});

// ── 1. The fill-in goes down: the starter takes the spot straight back ──
console.log('A starter on the IL, the fill-in goes down');
const lu = SM.get().userTeam.lineupSlots;
const X1 = lu.find(sl => sl.slot === 'SS')?.playerId || lu[0].playerId;
const slot1 = slotOf(X1);
hurt(X1, 2);
const Y1 = SM.get().userTeam.lineupSlots.find(sl => sl.slot === slot1)?.playerId;
check(`the injured starter remembers the spot (${P(X1).name}: ${JSON.stringify(P(X1)._lostSlot)})`, P(X1)._lostSlot?.kind === 'lineup' && P(X1)._lostSlot.slot === slot1);
check(`a fill-in took it (${P(Y1)?.name})`, !!Y1 && Y1 !== X1);
fillRoster();
step(2.5 * 3600_000);
let c = cardFor('il_return', X1);
console.log(`    “${c?.body}”`);
console.log(`    choices: ${(c?._choices || []).map(x => `${x.label} [${x.sub}]`).join(' | ')}`);
check('the Team Physician asks who goes down, with up to three choices', !!c && c.sender === 'Team Physician' && c._choices?.length >= 2 && c._choices.length <= 3);
check(`the fill-in is always a choice (recommended: ${c._choices[0].name}; reserves below ${P(Y1).name}'s OVR ${P(Y1).ovr} go first)`,
      c._choices.some(x => x.key === Y1 && x.replacement)
      && (c._choices[0].key === Y1 || P(c._choices[0].key).ovr < P(Y1).ovr - 3));
check('the choices are all on the same side and none is another starter',
      c._choices.every(x => P(x.key).pos !== 'SP' && P(x.key).pos !== 'RP'
        && (x.key === Y1 || !SM.get().userTeam.lineupSlots.some(sl => sl.playerId === x.key))));
check('the card is gender-neutral', !GEN.test(c.body) && !c._choices.some(x => GEN.test(x.sub)));
resolve(c.instanceId, 'yes', { pick: Y1 }); advanceClock(clock.get());
check(`${P(X1).name} is back at ${slot1}; ${P(Y1).name} went down to the farm`,
      slotOf(X1) === slot1 && SM.get().userTeam.farmIds.includes(Y1) && !P(X1)._lostSlot);
check('the decision reads as the choice in the Completed tab', SM.get().inbox.find(x => x.instanceId === c.instanceId)?.yesLabel.includes(P(Y1).name));
step(3 * 3600_000);
check('no nudge: nothing to ask', !cardFor('lineup_return', X1));

// ── 2. A reserve goes down: the hitting coach asks before the next game ──
console.log('\nA reserve goes down instead: the hitting coach asks');
const X2 = SM.get().userTeam.lineupSlots.find(sl => sl.slot === 'DH')?.playerId;   // (a fill-in who plays the spot for real, not out of position)
const slot2 = slotOf(X2);
hurt(X2, 2);
const Y2 = SM.get().userTeam.lineupSlots.find(sl => sl.slot === slot2)?.playerId;
fillRoster();
step(2.5 * 3600_000);
c = cardFor('il_return', X2);
const reserve = c._choices.find(x => x.key !== Y2);
resolve(c.instanceId, 'yes', { pick: reserve.key }); advanceClock(clock.get());
check(`${P(X2).name} is active but on the bench; ${P(reserve.key).name} went down`, !slotOf(X2) && P(X2).group === PLAYER_GROUP.BENCH_HITTERS && SM.get().userTeam.farmIds.includes(reserve.key));
step(60 * 60_000);
let n = cardFor('lineup_return', X2);
const coach = SM.get().userTeam.coachingStaff.hittingCoach.name;
console.log(`    ${n?.sender}: “${n?.body}”`);
check(`the hitting coach (${coach}) asks, before our next game`, !!n && n.sender === coach && n.expiresAtMs > clock.get());
check('the nudge names the fill-in and the spot, and is gender-neutral', n.body.includes(P(Y2).name) && /\bDH\b/.test(n.body + n.subject) && !GEN.test(n.body));
resolve(n.instanceId, 'yes'); advanceClock(clock.get());
check(`yes: ${P(X2).name} back at ${slot2}, ${P(Y2).name} to the bench`, slotOf(X2) === slot2 && !slotOf(Y2) && (SM.get().userTeam.rosterIds.includes(Y2)) && !P(X2)._lostSlot);

// ── 3. Unanswered: the manager asks once more after the game; then it's dropped ──
console.log('\nUnanswered: the manager follows up once');
const X3 = SM.get().userTeam.lineupSlots.find(sl => sl.slot === 'OF')?.playerId;
const slot3 = slotOf(X3);
hurt(X3, 2);
fillRoster();
step(2.5 * 3600_000);
c = cardFor('il_return', X3);
resolve(c.instanceId, 'yes', { pick: c._choices.find(x => !SM.get().userTeam.lineupSlots.some(sl => sl.playerId === x.key)).key }); advanceClock(clock.get());
step(60 * 60_000);
n = cardFor('lineup_return', X3);
check('the coach asks', !!n && n._nudge === 1);
const lock = n.expiresAtMs;
for (let i = 0; i < 60 && cardFor('lineup_return', X3)?._nudge !== 2; i++) step(60 * 60_000);
const first = SM.get().inbox.find(x => x.instanceId === n.instanceId);
const n2 = cardFor('lineup_return', X3);
console.log(`    ${n2?.sender}: “${n2?.body}”`);
check('no answer by first pitch: nothing changed', first?.choice === 'auto' && !slotOf(X3) && lock <= clock.get());
check(`the manager asks once more after that game (${n2?.sender})`, !!n2 && n2._nudge === 2 && n2.sender === SM.get().userTeam.coachingStaff.manager.name && n2.deliverAtMs >= lock + 3 * 3600_000);
resolve(n2.instanceId, 'no'); advanceClock(clock.get());
for (let i = 0; i < 30; i++) step(60 * 60_000);
check('"keep" ends it: no more asking', !cardFor('lineup_return', X3) && !P(X3)._lostSlot
      && !SM.get().inbox.some(x => x.cardId === 'lineup_return' && x._targetPlayerId === X3 && x._nudge > 2));

// ── 4. A starter's rotation turn: the pitching coach ──
console.log('\nA starting pitcher: the pitching coach');
const order = SM.get().userTeam.rotation.order;
const S = [...order].sort((a, b) => P(b).ovr - P(a).ovr)[0];
hurt(S, 2);
check(`the starter remembers the rotation turn (${P(S).name})`, P(S)._lostSlot?.kind === 'rotation');
fillRoster();
step(2.5 * 3600_000);
c = cardFor('il_return', S);
const notFill = c._choices.find(x => !SM.get().userTeam.rotation.order.includes(x.key));
check('the choices are pitchers', c._choices.every(x => ['SP', 'RP'].includes(P(x.key).pos)));
resolve(c.instanceId, 'yes', { pick: notFill.key }); advanceClock(clock.get());
step(60 * 60_000);
n = cardFor('lineup_return', S);
console.log(`    ${n?.sender}: “${n?.body}”`);
check(`the pitching coach asks (${SM.get().userTeam.coachingStaff.pitchingCoach.name})`, !!n && n.sender === SM.get().userTeam.coachingStaff.pitchingCoach.name);
const weakest = [...SM.get().userTeam.rotation.order].sort((a, b) => P(a).ovr - P(b).ovr)[0];
resolve(n.instanceId, 'yes'); advanceClock(clock.get());
const ord2 = SM.get().userTeam.rotation.order;
check(`yes: ${P(S).name} back in the rotation for the weakest turn (${P(weakest).name} to the bench)`,
      ord2.includes(S) && !ord2.includes(weakest) && ord2.length === 5 && P(weakest).group === PLAYER_GROUP.PITCHER_BENCH);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
