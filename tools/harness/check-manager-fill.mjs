// r135 §117 What reaches Messages and what goes to Recent.
//   node tools/harness/check-manager-fill.mjs
// The open-spot deadline passes: the manager calls someone up (ownership
// notices). The call-up reports at midnight, so the message is a real choice —
// keep the call-up, or send it back and pick (the spot opens again with a new
// deadline and the open-spot card). Unanswered, it settles as kept when the
// call-up reports. News about our club that asks nothing (a development plan's
// result, a minor-league signing) goes to the Recent feed, not Messages.
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import { releaseDueCards, resolve, getInbox, syncRosterCards } from '../../engine/CardEngine.js';
import { reconcileRoster, applyRosterMutation } from '../../engine/RosterEngine.js';
import { PLAYER_GROUP, PHASE, GAME_STATUS, MANAGER_FILL_PENALTY } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && info ? ` — ${info}` : ''}`);
};
const GEN = /\b(he|him|his|she|her|guys?|men|man)\b/i;

seedRandom(33);
await startNewGame({ archetypeId: 'contender', gmName: 'Test GM', city: 'Testville', nickname: 'Testers',
                     abbr: 'TST', icon: '🧪', bannerColor: '#3366cc', region: 'east' });
clock.set(SM.get().schedule[0].gameTime - 6 * 3600_000);
advanceClock(clock.get()); releaseDueCards();

const P = (id) => SM.get().players[id];
const U = () => SM.get().userTeam;
const active = () => U().rosterIds.filter(id => P(id)?.group !== PLAYER_GROUP.IL).length;
const open = (cardId) => getInbox().filter(c => c.cardId === cardId && !c.resolved);
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
/** Minute by minute until `pred` holds (or the limit). */
function until(pred, maxMin = 3000) { for (let i = 0; i < maxMin && !pred(); i++) step(60_000); return pred(); }

// The regular season's 28 (as check-il-return.mjs).
SM.mutate(s => {
  s.phase = PHASE.REGULAR_SEASON;
  const u = s.userTeam, Pl = (id) => s.players[id];
  const org = [...u.rosterIds, ...(s.freeAgentPool || []).filter(id => Pl(id)?.group === PLAYER_GROUP.FREE_AGENT && !Pl(id).isInjured)];   // §122 our 28 and the free agents
  const lineup = u.lineupSlots.map(sl => sl.playerId), rot = u.rotation.order;
  const byOvr = (a, b) => Pl(b).ovr - Pl(a).ovr;
  const own = new Set(u.rosterIds);   // our own bench first (it covers the field's positions), free agents only to fill out
  const benchBats = org.filter(id => !['SP', 'RP'].includes(Pl(id).pos) && !lineup.includes(id)).sort((a, b) => (own.has(b) - own.has(a)) || byOvr(a, b)).slice(0, 5);
  const spareSP = org.filter(id => Pl(id).pos === 'SP' && !rot.includes(id)).sort(byOvr).slice(0, 1);
  const rps = org.filter(id => Pl(id).pos === 'RP').sort(byOvr).slice(0, 8);
  const keep = [...lineup, ...benchBats, ...rot, ...spareSP, ...rps];
  for (const id of org) {
    const on = keep.includes(id);
    if (!on) { if (Pl(id).teamId === 'user') { Object.assign(Pl(id), { teamId: null, group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent' }); s.freeAgentPool.push(id); } continue; }
    if (Pl(id).teamId !== 'user') { s.freeAgentPool = s.freeAgentPool.filter(x => x !== id); Object.assign(Pl(id), { teamId: 'user', tier: 'mlb' }); }
    Pl(id).group = lineup.includes(id) || benchBats.includes(id) ? PLAYER_GROUP.BENCH_HITTERS
      : rot.includes(id) ? PLAYER_GROUP.STARTING_PITCHERS : rps.slice(0, 5).includes(id) ? PLAYER_GROUP.BULLPEN : PLAYER_GROUP.PITCHER_BENCH;
  }
  u.rosterIds = keep;
  applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: clock.get() }));
});
check('28 active to start', active() === 28);

/** A bench bat leaves the organization: one open spot, the deadline opens. */
function openSpot() {
  SM.mutate(s => {
    const u = s.userTeam;
    const lineup = u.lineupSlots.map(sl => sl.playerId);
    const id = u.rosterIds.find(x => !['SP', 'RP'].includes(s.players[x].pos) && !lineup.includes(x));
    u.rosterIds = u.rosterIds.filter(x => x !== id);
    Object.assign(s.players[id], { teamId: null, group: PLAYER_GROUP.FREE_AGENT, tier: 'freeAgent' });
    s.freeAgentPool = [...(s.freeAgentPool || []), id];
    applyRosterMutation(s, reconcileRoster(s, 'user', { atMs: clock.get() }));
  });
  step(60_000);
}

// ── 1. The deadline passes; the manager calls up; the GM sends them back ──
console.log('\nThe manager fills the spot; the GM sends the call-up back');
openSpot();
const need1 = open('roster_need')[0];
check('the open-spot card asks first, with a deadline', !!need1 && Number.isFinite(need1.expiresAtMs) && active() === 27);
const trust0 = U().ownerTrust;
check('…and the deadline passes unanswered: the manager makes the call-up',
      until(() => open('manager_fill').length > 0), JSON.stringify(getInbox().filter(c => !c.resolved).map(c => c.cardId)));
let mf = open('manager_fill')[0];
const fillIds = mf?._fillIds || [];
console.log(`    ${mf?.sender}: “${mf?.subject}” — ${mf?.body}`);
console.log(`    [${mf?.yesLabel}]  [${mf?.noLabel}]`);
check('it\'s a real choice: keep the call-up, or send it back and pick',
      mf.yesLabel.startsWith('Keep') && mf.noLabel.startsWith('Send') && mf._raw.onNo === 'mfill_sendback' && fillIds.length === 1);
check('it says what it cost with ownership, and the hit was taken', mf.body.includes('Owner Trust') && U().ownerTrust === Math.max(0, trust0 + MANAGER_FILL_PENALTY.ownerTrust));
check('the call-up is in transit and reports at midnight; the card is open until then',
      P(fillIds[0]).group === PLAYER_GROUP.IN_TRANSIT && mf.expiresAtMs === SM.get().transactions.find(t => t.playerId === fillIds[0] && t.status === 'pending').effectiveAt);
check('gender-neutral', !GEN.test(mf.body + mf.subject + mf.yesLabel + mf.noLabel));

resolve(mf.instanceId, 'no'); advanceClock(clock.get()); releaseDueCards();
const tx1 = SM.get().transactions.find(t => t.playerId === fillIds[0] && t.kind === 'arrival' && t.reason === 'signing');
check('let go before reporting: the signing is cancelled and the player is a free agent again',
      (SM.get().freeAgentPool || []).includes(fillIds[0]) && P(fillIds[0]).group === PLAYER_GROUP.FREE_AGENT && tx1?.status === 'cancelled' && active() === 27,
      JSON.stringify({ g: P(fillIds[0]).group, tx: tx1?.status, a: active() }));
check('the ownership hit stands', U().ownerTrust === Math.max(0, trust0 + MANAGER_FILL_PENALTY.ownerTrust));
const need2 = open('roster_need')[0];
check('the spot is open again with a new deadline ahead, and the open-spot card asks',
      !!need2 && need2.instanceId !== need1.instanceId && need2.expiresAtMs > clock.get() && U().vacancyDeadlineAt === need2.expiresAtMs);
resolve(need2.instanceId, 'yes'); advanceClock(clock.get());
check('the GM\'s own signing is on the way', SM.get().transactions.some(t => t.status === 'pending' && t.kind === 'arrival' && t.reason === 'signing' && t.teamId === 'user' && t.by !== 'manager'));
step(26 * 3600_000);
check('…and reports: 28 again', active() === 28);

// ── 2. Kept ──
console.log('\nThe GM keeps the call-up');
openSpot();
until(() => open('manager_fill').length > 0);
mf = open('manager_fill')[0];
resolve(mf.instanceId, 'yes'); advanceClock(clock.get());
const kept = mf._fillIds[0];
step(26 * 3600_000);
check('kept: the call-up reports and the roster is whole', P(kept).teamId === 'user' && U().rosterIds.includes(kept) && active() === 28);

// ── 3. Unanswered ──
console.log('\nNobody answers');
openSpot();
until(() => open('manager_fill').length > 0);
mf = open('manager_fill')[0];
const reportsAt = mf.expiresAtMs;
step(reportsAt - clock.get() + 60_000);
const settled = SM.get().inbox.find(c => c.instanceId === mf.instanceId);
check('it settles as kept when the call-up reports', settled?.resolved && settled.choice === 'auto' && U().rosterIds.includes(mf._fillIds[0]) && active() === 28,
      JSON.stringify({ r: settled?.resolved, c: settled?.choice }));
check('…and reads that way in Completed', /reported/.test(settled?._autoLabel || ''));
// Send back after reporting is no longer possible (nothing moves).
resolve(mf.instanceId, 'no');
check('after the call-up reported, nothing can be sent back', U().rosterIds.includes(mf._fillIds[0]));

// ── 4. News goes to Recent ──
console.log('\nNews about our club goes to Recent');
const devId = U().rosterIds[0];
const inboxBefore = (SM.get().inbox || []).length + (SM.get().scheduledCards || []).length;
syncRosterCards([
  { type: 'DEV_DONE', teamId: 'user', playerId: devId, planId: 'p-test', realized: 3, planned: 2, profile: 'steady', atMs: clock.get() },
], clock.get());
const feed = (SM.get().activityFeed || []).filter(e => e.type === 'ours');
console.log(`    Recent: ${feed.map(e => e.text).join(' | ')}`);
check('a development result is in Recent, not Messages',
      feed.some(e => e.text.includes('development plan'))
      && (SM.get().inbox || []).length + (SM.get().scheduledCards || []).length === inboxBefore);
check('…and no Recent entry is dated ahead of now', feed.every(e => e.timestamp <= clock.get()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
