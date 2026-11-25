/**
 * tools/harness/check-follow-ups.mjs — r279 §122.158 the club's own people follow up on a decision they're
 * still waiting on: once, in the same message (never a second one), with about a third of the time left, in the
 * staff's day; when the answer is needed and what happens without one. Answering it or its deadline closes the
 * one message. Outside parties and the outward-facing desks don't follow up; notices don't; messages that were
 * already waiting when this began don't.
 */
import { clock, seedRandom } from './shims.js';
import * as SM from '../../store/StateManager.js';
import { startNewGame, advanceClock } from '../../engine/GameEngine.js';
import * as CE from '../../engine/CardEngine.js';
import { internalSender, followUpAt, deadlineMs } from '../../engine/FollowUps.js';
import { STAFF_HOURS } from '../../data/constants.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const card = (id) => S().inbox.find(c => c.instanceId === id);
const tick = (ms) => { clock.set(clock.get() + ms); advanceClock(clock.get()); CE.releaseDueCards(); };
const until = (t, stepMs = 10 * 60_000) => { while (clock.get() < t) tick(Math.min(stepMs, t - clock.get())); };

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(279);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const day9 = new Date(clock.get()); day9.setHours(9, 0, 0, 0); clock.set(day9.getTime());

// a message already waiting before the first run: never followed up
const old = CE.deliverCardById('sp12');
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === old.instanceId); c.expiresAt = null; c.expiresAtMs = clock.get() + 30 * 3_600_000; });
tick(60_000);
check(`the first run marks where new messages begin`, Number.isFinite(S()._followUpsFrom));
check('a message already waiting gets no follow-up', followUpAt(card(old.instanceId), S()) === null);

// a new message from the manager, a decision with a deadline 30 hours out
tick(60_000);
const m = CE.deliverCardById('sp12');
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === m.instanceId); c.expiresAt = null; c.expiresAtMs = clock.get() + 30 * 3_600_000; c._readAt = clock.get(); });
const at = followUpAt(card(m.instanceId), S());
const arrived = card(m.instanceId).arrivedAtMs, due = deadlineMs(card(m.instanceId), S());
const hr = new Date(at).getHours();
check(`the manager (${card(m.instanceId).sender}) will follow up ${((at - arrived) / 3_600_000).toFixed(1)} h after it arrived, ${((due - at) / 3_600_000).toFixed(1)} h before the deadline, at ${new Date(at).toLocaleTimeString()}`,
  at > arrived && due - at >= 45 * 60_000 && hr >= +STAFF_HOURS.start.slice(0, 2) && hr < +STAFF_HOURS.end.slice(0, 2) && Math.abs((due - at) - (due - arrived) / 3) < 12 * 3_600_000);
const push = CE.getPushSchedule(S(), clock.get()).find(p => p.id === `fu:${m.instanceId}`);
check(`its alert is on the push schedule (“${push?.title}: ${push?.body}”, the message's own tag)`, !!push && push.deliverAt === at && push.tag === m.instanceId);
until(at - 60_000);
check('not before then', !card(m.instanceId)._followUp);
CE.takeReleased();
until(at + 60_000);
const f = card(m.instanceId);
const announced = CE.takeReleased().find(c => c.instanceId === m.instanceId);
console.log(`    “${f._followUp?.text}”`);
check('then: the same message, unread again, the follow-up in it', !!f._followUp && !f._readAt && f._followUp.atMs === at
  && S().inbox.filter(c => c.cardId === m.cardId && !c.resolved).length === 2);   // (this one and the old one: no third)
check('…saying when the answer is needed and what happens without one', /need your answer by/.test(f._followUp.text) && /If I don't hear back/.test(f._followUp.text) && f._followUp.text.includes(f.noLabel.replace(/[.!]$/, '')));
check(`…announced like a new message (“${announced?.subject}”)`, /^Following up: /.test(announced?.subject || ''));
check('…and its alert is off the schedule', !CE.getPushSchedule(S(), clock.get()).some(p => p.id === `fu:${m.instanceId}`));
tick(3 * 3_600_000);
check('one follow-up only', card(m.instanceId)._followUp.atMs === at && followUpAt(card(m.instanceId), S()) === null);
CE.resolve(m.instanceId, 'yes');
check('answered: the one message closes (nothing left in the inbox for it)', card(m.instanceId).resolved && !CE.getInbox().some(c => c.instanceId === m.instanceId));

// unanswered past its deadline: the one message lapses
const n = CE.deliverCardById('sp12');
// (a deadline of its own, on the wall clock: as a situation's is — expireDueRosterCards)
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === n.instanceId); c.expiresAt = null; c.expiresAtMs = clock.get() + 20 * 3_600_000; c._situation = true; });
const nDue = card(n.instanceId).expiresAtMs;
until(nDue + 30 * 60_000, 30 * 60_000);
CE.expireDueRosterCards(clock.get());   // (the clock's sweep of wall-clock deadlines)
const nc = card(n.instanceId);
check('unanswered: followed up, then lapses at its deadline as one message', !!nc._followUp && nc.resolved && nc.choice === 'auto' && !CE.getInbox().some(c => c.instanceId === n.instanceId));

// who follows up
const who = [['Hollandale (Manager)', true], ['Calloway', true], ['Head Trainer', true], ['Team Physician', true], ['Stadium Ops.', true],
  ['PR Dept.', true], ['Ticket Office', true], ['Guest Services', true], ['Player Rep.', true], ['Scouting', true], ['Media Relations', true],
  ['Morello (Gulfport Mullets GM)', false], ['Partnerships', false], ['Marketing Dept.', false], ['Community Relations', false],
  ['Fan Relations', false], ['Booster Club', false], ['Beat Writer', false], ['League Office', false], ['Other GMs', false], ['Sponsorship Dept.', false]];
const wrong = who.filter(([s, want]) => internalSender({ sender: s }) !== want);
check('inside the club follows up; other clubs and the outward-facing desks don\'t', wrong.length === 0, JSON.stringify(wrong));

// a message from another club's GM, and a notice: none
const gm = CE.deliverCardById('ms_1');   // (Partnerships)
SM.mutate(s => { const c = s.inbox.find(x => x.instanceId === gm.instanceId); c.expiresAt = null; c.expiresAtMs = clock.get() + 30 * 3_600_000; });
check(`Partnerships (${card(gm.instanceId).sender}): no follow-up`, followUpAt(card(gm.instanceId), S()) === null);
const notice = { ...card(m.instanceId), resolved: false, noLabel: null, _choices: null, _followUp: null, arrivedAtMs: clock.get(), expiresAtMs: clock.get() + 30 * 3_600_000 };
check('a notice (one answer only): no follow-up', followUpAt(notice, S()) === null);
const short = { ...notice, noLabel: 'No', expiresAtMs: clock.get() + 2 * 3_600_000 };
check('a two-hour window: no follow-up', followUpAt(short, S()) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
