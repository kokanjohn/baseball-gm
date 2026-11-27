/**
 * tools/harness/check-message-history.mjs
 * DEV/TEST ONLY — r292 §122.174 (foundation step 4): Messages keeps the newest answered messages; older ones leave
 * notes (engine/MessageHistory.js), and what reads the past reads the notes the same.
 *
 *   - The rule: the newest MESSAGE_HISTORY.keepAnswered answered, in Completed's order; a `_keep` message is never
 *     trimmed nor counted; notes are cleared after MESSAGE_HISTORY.seasons seasons, unless `_keep`.
 *   - In play: a club through 60 games, the GM answering; Messages holds no more than the limit, the rest are notes,
 *     a note is a fraction of a message, and every id is still unique.
 *   - The readers (§122.173): with every answered message turned into a note, they answer the same.
 *
 *   node tools/harness/check-message-history.mjs
 */
import { clock, seedRandom } from './shims.js';            // MUST be first (installs globals)
import * as SM from '../../store/StateManager.js';
import * as CE from '../../engine/CardEngine.js';
import { startNewGame } from '../../engine/GameEngine.js';
import { trimAnswered, trimDue, noteOf, isNote, withHistory, newestFirst } from '../../engine/MessageHistory.js';
import { _cardsWithKey } from '../../engine/cards/Delivery.js';
import { greetedThisSeason } from '../../engine/FirstDay.js';
import { scoutingAsked } from '../../engine/TradeAdvice.js';
import { MESSAGE_HISTORY } from '../../data/constants.js';
import { liveUntil } from './drive.mjs';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? `\n      ${info}` : ''}`); };
const S = () => SM.get();
const DAY = 86_400_000;

// ── The rule ──
{
  const msg = (i, extra = {}) => ({ instanceId: `m${i}`, cardId: 'x', subject: `s${i}`, resolved: true, resolvedAtMs: 1000 + i, ...extra });
  const st = { seasonNum: 5, inbox: [...Array.from({ length: 8 }, (_, i) => msg(i)), msg(99, { _keep: true, resolvedAtMs: 1 }), { instanceId: 'open', resolved: false }],
    messageHistory: [{ _note: true, instanceId: 'n2', _noteSeason: 2 }, { _note: true, instanceId: 'n3', _noteSeason: 3 }, { _note: true, instanceId: 'k1', _noteSeason: 1, _keep: true }] };
  const rule = { keepAnswered: 5, seasons: 3 };
  check('the rule: due when more than the limit are answered', trimDue(st, rule));
  trimAnswered(st, rule);
  const kept = st.inbox.filter(c => c.resolved && !c._keep).map(c => c.instanceId);
  check(`…the newest ${rule.keepAnswered} answered stay (${kept.join(' ')})`, kept.join() === 'm3,m4,m5,m6,m7');
  check('…a message marked to keep stays, and isn\'t counted; unanswered ones stay', st.inbox.some(c => c.instanceId === 'm99') && st.inbox.some(c => c.instanceId === 'open'));
  const notes = st.messageHistory.map(n => n.instanceId);
  check(`…the older ones are notes, and notes from ${rule.seasons} seasons ago are cleared (unless kept): ${notes.join(' ')}`,
    notes.join() === 'n3,k1,m0,m1,m2' && st.messageHistory.every(isNote));
  check('…then nothing more to do', !trimDue(st, rule));
}

// ── In play ──
for (const sl of await SM.listSlots()) await SM.deleteSlot(sl.slotId || sl.id);
seedRandom(292);
const d0 = new Date(Date.UTC(2400, 0, 1)); d0.setHours(8, 0, 0, 0);
clock.set(d0.getTime());
await startNewGame({ archetypeId: 'contender', gmName: 'T', city: 'T', nickname: 'T', abbr: 'TST', icon: 'x', bannerColor: '#333', region: 'east' });
const answered = new Set();
let r = 0.29;
const rand = () => (r = (r * 9301 + 49297) % 233280 / 233280);
const gm = () => {
  for (const c of CE.getInbox()) {
    if (answered.has(c.instanceId) || c.resolved) continue;
    answered.add(c.instanceId);
    if (rand() < 0.3) continue;
    try { CE.resolve(c.instanceId, rand() < 0.6 ? 'yes' : 'no', c.choices?.length ? { pick: c.choices[0].key } : {}); } catch { /* */ }
  }
};
const regular = S().schedule.filter(g => !g.isSpring);
await liveUntil(regular[59].gameTime + 6 * 3_600_000, { onStep: gm });
CE.releaseDueCards(clock.get());
const st = S();
const inAnswered = (st.inbox || []).filter(c => c.resolved && !c._keep);
const notes = st.messageHistory || [];
check(`in play: Messages keeps no more than ${MESSAGE_HISTORY.keepAnswered} answered (${inAnswered.length}), the rest are notes (${notes.length})`,
  inAnswered.length <= MESSAGE_HISTORY.keepAnswered && notes.length > 0);
const oldestKept = Math.min(...inAnswered.map(c => c.resolvedAtMs || 0)), newestNote = Math.max(...notes.map(n => n.resolvedAtMs || 0));
check('…the ones kept are the newest (Completed\'s order)', newestNote <= oldestKept);
const perNote = JSON.stringify(notes).length / notes.length, perMsg = JSON.stringify(st.inbox).length / st.inbox.length;
check(`…a note is a fraction of a message (${Math.round(perNote)} bytes against ${Math.round(perMsg)})`, perNote < perMsg / 2.5);
const ids = [...withHistory(st), ...(st.scheduledCards || [])].map(c => c.instanceId);
check(`…every id still unique (${ids.length})`, new Set(ids).size === ids.length);
check('…Completed shows the newest answered', CE.getHistory(100).every((c, i, a) => !i || newestFirst(a[i - 1], c) <= 0));

// ── The readers: every answered message a note, the same answers ──
const before = structuredClone(st);
const after = structuredClone(st);
trimAnswered(after, { keepAnswered: 0, seasons: MESSAGE_HISTORY.seasons });
check(`the readers, every answered message a note (${after.messageHistory.length} notes; ${after.inbox.length} left in Messages)`,
  after.inbox.every(c => !c.resolved || c._keep));
const keys = [...new Set([...withHistory(before), ...(before.scheduledCards || [])].map(c => c._rosterKey).filter(Boolean))];
const keyDiff = keys.filter(k => {
  const a = _cardsWithKey(before, k), b = _cardsWithKey(after, k);
  return a.length !== b.length || a.some(c => !c.resolved) !== b.some(c => !c.resolved);
});
check(`…roster keys: the same count and the same open message for each (${keys.length} keys)`, keyDiff.length === 0, keyDiff.slice(0, 5).join(', '));
const teams = (st.leagueTeams || []).map(t => t.id);
check(`…the other GMs greeted this season (${teams.filter(t => greetedThisSeason(before, t)).length} of ${teams.length})`,
  teams.every(t => greetedThisSeason(before, t) === greetedThisSeason(after, t)));
const dealKeys = [...new Set(withHistory(before).filter(c => c.isCompose && c._composeTopic === 'sc_trade').map(c => c._composeArg?.key))];
check(`…Scouting asked about a deal (${dealKeys.length} deals)`, dealKeys.every(k => scoutingAsked(before, k) === scoutingAsked(after, k)));
// every field a §122.173 reader reads, the same on the note as on the message
const FIELDS = ['instanceId', 'cardId', 'tag', 'subject', 'choice', 'autoChoice', 'arrivedAtMs', 'deliverAtMs', '_season', '_expiredSeason',
  '_rosterKey', '_family', '_targetPlayerId', '_gmTeamId', '_gmSeason', '_wxDecision', '_wxGameTime', '_composeTopic', '_sentAtMs'];
const byId = new Map(before.inbox.map(c => [c.instanceId, c]));
const wrong = [];
for (const n of after.messageHistory) {
  const c = byId.get(n.instanceId); if (!c) continue;
  for (const f of FIELDS) if ((c[f] ?? null) !== (n[f] ?? null) && !(f === 'subject' && !c[f] && !n[f])) wrong.push(`${c.cardId}.${f}`);
  if (!!c.noLabel !== !!n.noLabel || (c.resolvedAtMs ?? c.resolvedAt ?? null) !== (n.resolvedAtMs ?? null)) wrong.push(`${c.cardId}.noLabel/resolvedAtMs`);
  if ((c._composeArg?.key ?? null) !== (n._composeArg?.key ?? null)) wrong.push(`${c.cardId}._composeArg`);
  if (JSON.stringify((c._coachCands || []).map(x => x?.name)) !== JSON.stringify((n._coachCands || []).map(x => x?.name))) wrong.push(`${c.cardId}._coachCands`);
  if ((c._raw?._fieldNote ?? null) !== (n._raw?._fieldNote ?? null) && JSON.stringify(c._raw?._fieldNote) !== JSON.stringify(n._raw?._fieldNote)) wrong.push(`${c.cardId}._fieldNote`);
}
check(`…every field a reader reads is the same on the note (${after.messageHistory.length} notes)`, wrong.length === 0, [...new Set(wrong)].slice(0, 8).join(', '));
check('…a note is made from the message alone (noteOf is pure)', JSON.stringify(noteOf(before.inbox.find(c => c.resolved) || {})) === JSON.stringify(noteOf(structuredClone(before.inbox.find(c => c.resolved) || {}))));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
