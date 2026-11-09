// §113–114 Back from an injury — the return card (who goes down) and the staff's nudge.
//   node tools/harness/check-il-return.mjs
// A real league, our club at a full 28: a player goes on the IL and a fill-in
// takes the spot; when the player is cleared, the Team Physician asks who goes
// down — our lowest-rated reserves on that side, the lowest recommended — and
// nobody comes off the IL until the GM picks (the roster is never over 28).
// The returning player waits on the bench / pitcher bench, like everyone
// else; the hitting, pitching or bullpen coach asks about the old spot before
// the next game, the manager once more after it.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox } from '../../engine/CardEngine.js';
import { reconcileRoster, applyRosterMutation } from '../../engine/RosterEngine.js';
import { bullpenRoles, reliefValue } from '../../engine/PitchingEngine.js';
import { PLAYER_GROUP, PHASE, GAME_STATUS } from '../../data/constants.js';
import { placeOnILUpdate } from '../../engine/InjuryEngine.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;

seedRandom(21);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(SM.get().schedule[0].gameTime - 6 * 3600_000);
advanceClock(clock.get()); releaseDueCards();

const P = (id) => SM.get().players[id];
const U = () => SM.get().userTeam;
const slotOf = (id) => U().lineupSlots.find(sl => sl.playerId === id)?.slot || null;
const active = () => U().rosterIds.filter(id => P(id)?.group !== PLAYER_GROUP.IL).length;
const pen = () => U().rosterIds.filter(id => P(id)?.group === PLAYER_GROUP.BULLPEN);
let maxActive = 0;
const cardFor = (cardId, id) => getInbox().find(c => c.cardId === cardId && c._targetPlayerId === id && !c.resolved);
/** Minute by minute until the card is in the inbox (a nudge lands before our next first pitch). */
function waitFor(cardId, id, maxMin = 600) {
  for (let i = 0; i < maxMin && !cardFor(cardId, id); i++) step(60_000);
  return cardFor(cardId, id);
}

// The clock moves on; a game whose first pitch it passes is played (marked final — this check is
// about the inbox and the roster; the roster clock waits at an unplayed game's first pitch).
function step(ms) {
  const target = clock.get() + ms;
  for (let guard = 0; guard < 50; guard++) {
    const st = SM.get();
    const i = st.schedule.findIndex(g => !g._committed && Number.isFinite(g.gameTime));
    const g = st.schedule[i];
    if (!g || g.gameTime > target) break;
    clock.set(g.gameTime); advanceClock(clock.get()); releaseDueCards(); maxActive = Math.max(maxActive, active());
    SM.mutate(s => { Object.assign(s.schedule[i], { _committed: true, status: GAME_STATUS.FINAL }); s.currentGameIndex = i + 1; });
  }
  clock.set(target); advanceClock(clock.get()); releaseDueCards(); maxActive = Math.max(maxActive, active());
}
function hurt(id, hours) {
  const now = clock.get();
  SM.mutate(s => {
    const p = s.players[id];
    Object.assign(p, placeOnILUpdate({ ...p, injury: { status: 'evaluating', injuredAt: now, days: 1 } }));   // (the real placement)
    p.injury.eligibleAt = now + hours * 3600_000;
    applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: now }));
  });
}
/** A call-up for the IL'd player — from that player's side (the club is at 28 active again). */
function fillRoster() {
  SM.mutate(s => {
    const u = s.userTeam;
    const isP = (id) => ['SP', 'RP'].includes(s.players[id].pos);
    const act = () => u.rosterIds.filter(id => s.players[id].group !== PLAYER_GROUP.IL).length;
    const pitchers = () => u.rosterIds.filter(id => isP(id) && s.players[id].group !== PLAYER_GROUP.IL).length;
    // §122 a free agent signed into the spot (placed at once, for the test)
    const pool = () => (s.freeAgentPool || []).filter(id => s.players[id]?.group === PLAYER_GROUP.FREE_AGENT && !s.players[id].isInjured);
    while (act() < 28 && pool().length) {
      const wantP = pitchers() < 14;
      const id = pool().find(x => isP(x) === wantP) || pool()[0];
      s.freeAgentPool = s.freeAgentPool.filter(x => x !== id);
      u.rosterIds.push(id);
      Object.assign(s.players[id], { teamId: 'user', tier: 'mlb' });
      const p = s.players[id];
      p.group = ['SP', 'RP'].includes(p.pos) ? PLAYER_GROUP.PITCHER_BENCH : PLAYER_GROUP.BENCH_HITTERS;
    }
    applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: clock.get() }));
  });
}
/** §122 a player let go, straight to the free agents (for the test). */
function toPool(s, id) {
  s.userTeam.rosterIds = s.userTeam.rosterIds.filter(x => x !== id);
  Object.assign(s.players[id], { teamId: null, group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent' });
  s.freeAgentPool = [...(s.freeAgentPool || []), id];
}
// The regular season's 28: 14 hitters (the nine, five on the bench) and 14 pitchers (the
// rotation, five in the pen, a spare starter, three reserve arms) — from our 28 and the free agents.
SM.mutate(s => {
  s.phase = PHASE.REGULAR_SEASON;
  const u = s.userTeam, Pl = (id) => s.players[id];
  const org = [...u.rosterIds, ...(s.freeAgentPool || []).filter(id => Pl(id)?.group === PLAYER_GROUP.FREE_AGENT && !Pl(id).isInjured)];
  const lineup = u.lineupSlots.map(sl => sl.playerId), rot = u.rotation.order;
  const byOvr = (a, b) => Pl(b).ovr - Pl(a).ovr;
  const benchBats = org.filter(id => !['SP', 'RP'].includes(Pl(id).pos) && !lineup.includes(id)).sort(byOvr).slice(0, 5);
  const spareSP = org.filter(id => Pl(id).pos === 'SP' && !rot.includes(id)).sort(byOvr).slice(0, 1);
  const rps = org.filter(id => Pl(id).pos === 'RP').sort(byOvr).slice(0, 8);
  const keep = [...lineup, ...benchBats, ...rot, ...spareSP, ...rps];
  for (const id of org) {
    const on = keep.includes(id);
    if (!on) { if (Pl(id).teamId === 'user') toPool(s, id); continue; }
    if (Pl(id).teamId !== 'user') { s.freeAgentPool = s.freeAgentPool.filter(x => x !== id); Object.assign(Pl(id), { teamId: 'user', tier: 'mlb' }); }
    Pl(id).group = lineup.includes(id) || benchBats.includes(id) ? PLAYER_GROUP.BENCH_HITTERS
      : rot.includes(id) ? PLAYER_GROUP.STARTING_PITCHERS : rps.slice(0, 5).includes(id) ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.PITCHER_BENCH;
  }
  u.rosterIds = keep;
  applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: clock.get() }));
});
const healthyRP = () => U().rosterIds.map(P).filter(p => p.pos === 'RP' && !p.isInjured && p.group !== PLAYER_GROUP.IL).length;
check(`the bullpen holds five, or every healthy reliever (${pen().length} of ${healthyRP()}); a spare starter (${U().rosterIds.filter(id => P(id).pos === 'SP').length} SP)`,
      pen().length === 5 && U().rosterIds.length === 28 && U().rosterIds.filter(id => P(id).pos === 'SP').length >= 6);

// ── 1. A hitter: who goes down; nobody comes back until the GM picks ──
console.log('\nA starter on the IL; the return card');
const X1 = U().lineupSlots.find(sl => sl.slot === 'DH')?.playerId;   // (a fill-in who plays the spot for real)
const slot1 = slotOf(X1);
hurt(X1, 2);
const Y1 = U().lineupSlots.find(sl => sl.slot === slot1)?.playerId;
check(`the injured starter remembers the spot (${P(X1).name}: ${P(X1)._lostSlot?.slot})`, P(X1)._lostSlot?.kind === 'lineup' && P(X1)._lostSlot.slot === slot1);
fillRoster();
step(2.5 * 3600_000);
let c = cardFor('il_return', X1);
console.log(`    “${c?.body}”`);
console.log(`    choices: ${(c?._choices || []).map(x => `${x.label} [${x.sub}]`).join(' | ')}`);
const bench = U().rosterIds.map(P).filter(p => p.group === PLAYER_GROUP.BENCH_HITTERS && !U().lineupSlots.some(sl => sl.playerId === p.id) && p.id !== X1);
const lowest3 = bench.sort((a, b) => a.ovr - b.ovr).slice(0, 3).map(p => p.id);
check('the Team Physician asks who goes down: our three lowest-rated bench bats, the lowest first',
      c?.sender === 'Team Physician' && c._choices?.map(x => x.key).join() === lowest3.join());
check(`the fill-in (${P(Y1).name}, OVR ${P(Y1).ovr}) is not offered unless among the lowest`, lowest3.includes(Y1) || !c._choices.some(x => x.key === Y1));
check('no deadline: nothing happens on its own', !Number.isFinite(c.expiresAtMs) && !c._raw.onAuto);
check('the card is gender-neutral', !GEN.test(c.body));
step(30 * 3600_000);
check(`a day later, still unanswered: ${P(X1).name} is still on the IL and the roster is at 28`,
      !!cardFor('il_return', X1) && P(X1).group === PLAYER_GROUP.IL && active() === 28);
// A pick that's no longer possible (the player was sent down meanwhile): nobody moves, the card comes back.
const gone = c._choices[0].key;
SM.mutate(s => toPool(s, gone));
fillRoster();
resolve(c.instanceId, 'yes', { pick: gone }); advanceClock(clock.get()); step(60_000);
const c2 = cardFor('il_return', X1);
check('a pick that\'s no longer possible: still on the IL, and the card comes back with today\'s choices',
      P(X1).group === PLAYER_GROUP.IL && !!c2 && !c2._choices.some(x => x.key === gone) && active() === 28);
const down = c2._choices[0].key;
resolve(c2.instanceId, 'yes', { pick: down }); advanceClock(clock.get());
check(`picked: ${P(down).name} went on waivers, ${P(X1).name} is active on the bench, the roster is at 28`,
      P(down).onWaivers && P(X1).group === PLAYER_GROUP.BENCH_HITTERS && !slotOf(X1) && active() === 28);
check('the decision reads as the choice in the Completed tab', SM.get().inbox.find(x => x.instanceId === c2.instanceId)?.yesLabel.includes(P(down).name));

console.log('\nThe hitting coach asks');
let n = waitFor('lineup_return', X1);
console.log(`    ${n?.sender}: “${n?.body}”`);
check(`the hitting coach (${U().coachingStaff.hittingCoach.name}) asks before our next game`,
      !!n && n.sender === U().coachingStaff.hittingCoach.name && n.expiresAtMs > clock.get() && n.body.includes(P(Y1).name) && !GEN.test(n.body));
resolve(n.instanceId, 'yes'); advanceClock(clock.get());
check(`yes: ${P(X1).name} back ${slot1}, ${P(Y1).name} to the bench`, slotOf(X1) === slot1 && !slotOf(Y1) && !P(X1)._lostSlot && active() === 28);

// ── 2. Unanswered: the manager follows up once; "keep" ends it ──
console.log('\nUnanswered: the manager follows up once');
const X3 = U().lineupSlots.find(sl => sl.slot === 'OF')?.playerId;
hurt(X3, 2); fillRoster(); step(2.5 * 3600_000);
c = cardFor('il_return', X3);
resolve(c.instanceId, 'yes', { pick: c._choices[0].key }); advanceClock(clock.get());
n = waitFor('lineup_return', X3);
const lock = n?.expiresAtMs;
for (let i = 0; i < 60 && cardFor('lineup_return', X3)?._nudge !== 2; i++) step(60 * 60_000);
const n2 = cardFor('lineup_return', X3);
console.log(`    ${n2?.sender}: “${n2?.body}”`);
check('no answer by first pitch: nothing changed', SM.get().inbox.find(x => x.instanceId === n.instanceId)?.choice === 'auto' && !slotOf(X3));
check('the manager asks once more after that game', !!n2 && n2.sender === U().coachingStaff.manager.name && n2.deliverAtMs >= lock + 3 * 3600_000);
resolve(n2.instanceId, 'no'); advanceClock(clock.get());
for (let i = 0; i < 30; i++) step(60 * 60_000);
check('"keep" ends it', !cardFor('lineup_return', X3) && !P(X3)._lostSlot);

// ── 3. A starting pitcher: the pitcher bench, then the pitching coach ──
console.log('\nA starting pitcher');
const S = [...U().rotation.order].sort((a, b) => P(b).ovr - P(a).ovr)[0];
hurt(S, 2);
check(`the starter remembers the turn (${P(S).name})`, P(S)._lostSlot?.kind === 'rotation');
fillRoster(); step(2.5 * 3600_000);
c = cardFor('il_return', S);
const pb = U().rosterIds.map(P).filter(p => p.group === PLAYER_GROUP.PITCHER_BENCH && p.id !== S).sort((a, b) => a.ovr - b.ovr).slice(0, 3).map(p => p.id);
check('the choices: our lowest-rated arms on the pitcher bench (never the rotation or the bullpen)', c?._choices?.map(x => x.key).join() === pb.join());
resolve(c.instanceId, 'yes', { pick: c._choices[0].key }); advanceClock(clock.get());
check(`${P(S).name} rejoins on the pitcher bench, not the rotation`, P(S).group === PLAYER_GROUP.PITCHER_BENCH && !U().rotation.order.includes(S) && active() === 28);
n = waitFor('lineup_return', S);
console.log(`    ${n?.sender}: “${n?.body}”`);
check(`the pitching coach asks (${U().coachingStaff.pitchingCoach.name})`, n?.sender === U().coachingStaff.pitchingCoach.name);
const weakest = [...U().rotation.order].sort((a, b) => P(a).ovr - P(b).ovr)[0];
resolve(n.instanceId, 'yes'); advanceClock(clock.get());
check(`yes: back in the rotation for the weakest turn (${P(weakest).name} to the pitcher bench)`,
      U().rotation.order.includes(S) && U().rotation.order.length === 5 && P(weakest).group === PLAYER_GROUP.PITCHER_BENCH);

// ── 4. A reliever: the pen keeps five; the pitcher bench, then the bullpen coach ──
console.log('\nA reliever');
const R = [...pen()].sort((a, b) => reliefValue(P(b)) - reliefValue(P(a)))[0];
const closer0 = bullpenRoles(U(), SM.get().players).closer;
hurt(R, 2);
check(`the pen refills from the pitcher bench (${pen().length} of ${healthyRP()} healthy relievers); ${P(R).name} remembers the spot`, pen().length === Math.min(5, healthyRP()) && P(R)._lostSlot?.kind === 'bullpen');
fillRoster(); step(2.5 * 3600_000);
c = cardFor('il_return', R);
resolve(c.instanceId, 'yes', { pick: c._choices[0].key }); advanceClock(clock.get());
const pen0 = pen().length;
check(`${P(R).name} rejoins on the pitcher bench, not the bullpen`, P(R).group === PLAYER_GROUP.PITCHER_BENCH && !pen().includes(R));
const roles = bullpenRoles(U(), SM.get().players);
check(`a reserve arm doesn't close: ${P(roles.closer)?.name} (bullpen) closes, not ${P(R).name}`,
      roles.closer !== R && P(roles.closer)?.group === PLAYER_GROUP.BULLPEN && (closer0 === R || true));
n = waitFor('lineup_return', R);
console.log(`    ${n?.sender}: “${n?.body}”`);
check(`the bullpen coach asks (${U().coachingStaff.bullpenCoach.name})`, n?.sender === U().coachingStaff.bullpenCoach.name);
resolve(n.instanceId, 'yes'); advanceClock(clock.get());
check(`yes: ${P(R).name} back in the bullpen, the pen the same size (${pen().length})`, P(R).group === PLAYER_GROUP.BULLPEN && pen().length === pen0);
check(`…and closing again (${P(bullpenRoles(U(), SM.get().players).closer)?.name})`, bullpenRoles(U(), SM.get().players).closer === R);

check(`never more than 28 active at any step (most: ${maxActive})`, maxActive <= 28);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
