/**
 * tools/harness/check-important-only.mjs
 * DEV/TEST ONLY — r296 §122.180 Important only (the design, decided with the user: §122.180).
 *
 *   - A season's start in Important only: every optional message that arrives is the staff's, answered at once with
 *     the answer it gets at its deadline; none reaches Messages, Completed, the badges, the toasts or a push; every
 *     important one reaches Messages as before.
 *   - No penalty: the staff's answer costs no 'left unanswered' tax and isn't counted as the GM ignoring it (against
 *     the same message left to its deadline in Normal).
 *   - Switching: a message waiting before the switch stays the GM's.
 *   - The look-ahead and the push schedule leave out what the staff will take; Normal's are as before.
 *   - Memory: a handled message becomes a note at once (never one of Completed's 100), and the history with its
 *     sender counts the staff's answer, not ignoring.
 *
 *   node tools/harness/check-important-only.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import * as CE from '../../engine/CardEngine.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { _createInstance } from '../../engine/cards/Selection.js';
import { toInbox, toSchedule, VIA } from '../../engine/cards/Entry.js';
import { lookAheadMessages } from '../../engine/LookAhead.js';
import { historyWith } from '../../engine/MessageParts.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const HOUR = 3_600_000;
const setMode = (m) => SM.mutate(s => { s.settings.messageMode = m; });

for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(296);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });

// A test message: optional (culture), its deadline answer 'no' with a 'left unanswered' tax.
const TEST = { id: 'test_imp_culture', tag: 'CULTURE', sender: 'Community Relations', avatar: '🎈', type: 'normal', from: 'city:test_group',
  subject: 'A mural for the concourse', body: 'A local artist offers a mural. Would you like it?', yesLabel: 'Yes', noLabel: 'No',
  autoResolve: 'no', autoResolveTax: { morale: -3 }, yesEffect: {}, noEffect: {}, _ttl: 3 };
const arrive = (def = TEST) => {
  const inst = _createInstance(def, {}, S());
  SM.mutate(s => { toInbox(s, [inst], () => clock.get(), VIA.SEED); });
  return inst.instanceId;
};
const card = (id) => [...S().inbox, ...(S().messageHistory || [])].find(c => c.instanceId === id);
const visible = (id) => CE.getInbox().some(c => c.instanceId === id) || CE.getHistory(500).some(c => c.instanceId === id);

// ── A message waiting before the switch stays the GM's ──
const waiting = arrive();
setMode('important');
CE.releaseDueCards(clock.get());
check('switching: a message waiting before the switch stays the GM\'s (in Messages, unanswered)', CE.getInbox().some(c => c.instanceId === waiting) && !card(waiting).resolved);

// ── No penalty, not counted as ignoring (against Normal) ──
const moraleOf = () => S().userTeam?.teamMorale ?? S().userTeam?.morale;
const decisions = () => (S().gmRecord?.log || []).length;
let m0 = moraleOf(), g0 = decisions();
const handled = arrive();
check('in Important only, an optional message arriving is the staff\'s, and shown nowhere', !visible(handled) && card(handled)._staffHandle);
CE.releaseDueCards(clock.get());
const h = card(handled);
check(`…answered at once with its deadline answer (${h?.choice}/${h?.autoChoice})`, h?.resolved && h._staffHandled && h.autoChoice === 'no');
const staffMorale = moraleOf() - m0, staffDecisions = decisions() - g0;
setMode('normal');
const left = arrive();
m0 = moraleOf(); g0 = decisions();
CE.expire(left, clock.get());
const leftMorale = moraleOf() - m0, leftDecisions = decisions() - g0;
check(`…no 'left unanswered' penalty (morale ${staffMorale >= 0 ? '+' : ''}${staffMorale}; left to its deadline in Normal: ${leftMorale})`, staffMorale === 0 && leftMorale < 0);
check(`…and not counted as ignoring (GM record ${staffDecisions}; left in Normal: ${leftDecisions})`, staffDecisions === 0 && leftDecisions === 1);
CE.resolve(waiting, 'yes');

// ── A season's start in Important only ──
setMode('important');
const answered = new Set();
const gm = () => { for (const c of CE.getInbox()) { if (answered.has(c.instanceId)) continue; answered.add(c.instanceId); try { CE.resolve(c.instanceId, 'yes', c.choices?.length ? { pick: c.choices[0].key } : {}); } catch { /* */ } } };
const seenIds = new Set(S().inbox.map(c => c.instanceId));
const toasts = [];
CE.takeReleased();
await liveUntil(S().schedule.filter(g => !g.isSpring)[19].gameTime + 6 * HOUR, { onStep: () => { toasts.push(...CE.takeReleased()); gm(); } });
const after = [...S().inbox, ...(S().messageHistory || [])].filter(c => !seenIds.has(c.instanceId) && !c._seed);
const opt = after.filter(c => c._tier === 'optional'), imp = after.filter(c => c._tier === 'important');
check(`every optional message the staff's and answered (${opt.length})`, opt.length > 0 && opt.every(c => c._staffHandle && c.resolved && c._staffHandled));
check(`…none in Messages, Completed or the badges; every important one reached Messages (${imp.length})`,
  !opt.some(c => visible(c.instanceId)) && imp.every(c => !c._staffHandle) && CE.inboxCounts().todo === CE.getInbox().length);
check(`…no toast for the staff's (${toasts.length} toasts, ${toasts.filter(c => c._staffHandle).length} the staff's)`, toasts.length > 0 && !toasts.some(c => c._staffHandle));
check(`…each a note at once, never one of Completed's (${opt.filter(c => c._note).length} of ${opt.length} notes)`, opt.every(c => c._note));

// ── The look-ahead and the push schedule ──
await SM.save();
const ahead = lookAheadMessages(clock.get(), clock.get() + 36 * HOUR);
const optPlan = _createInstance(TEST, {}, S());
SM.mutate(s => { toSchedule(s, [{ ...optPlan, deliverAtMs: clock.get() + 2 * HOUR }], VIA.DELIVER_AT); });
const pushes = CE.getPushSchedule(S(), clock.get());
check(`the look-ahead foresees none of the staff's (${ahead.messages.length} foreseen)`, !ahead.messages.some(m => S().inbox.concat(S().messageHistory || []).find(c => c.instanceId === m.instanceId)?._staffHandle));
check('…no push for a planned optional message in Important only', !pushes.some(p => p.id === optPlan.instanceId));
setMode('normal');
check('…in Normal it has its push, as before', CE.getPushSchedule(S(), clock.get()).some(p => p.id === optPlan.instanceId));

// ── Memory: the history counts the staff's answer ──
const hist = historyWith(S(), TEST.from, clock.get());
check(`the history with the sender counts the staff's answer, not ignoring (${JSON.stringify({ yes: hist.yes, no: hist.no, ignored: hist.ignored })})`, hist.no >= 1 && hist.ignored === 1);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
