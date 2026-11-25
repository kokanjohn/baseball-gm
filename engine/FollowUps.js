/**
 * engine/FollowUps.js — r279 §122.158 the people inside the club follow up on a decision they're still waiting on.
 *
 * One follow-up per message, in the same thread (never a second message): when about a third of the time to its
 * deadline is left, within the staff's day (STAFF_HOURS), the sender writes again — when the answer is needed, and
 * what happens without one. The message comes back to the top of the inbox, unread. Answering it, or its deadline
 * passing, closes the one message: nothing is left behind.
 *
 * Who follows up: everyone inside the club — the owner, the manager and coaches, the trainers and physician,
 * scouting, the front office's departments (PR, the ticket office, Guest Services, the player rep included).
 * Never: other clubs' GMs and anyone writing for an outside party, the club's outward-facing desks (partnerships
 * and sponsors, marketing, community relations, fan relations, the booster club), the beat writer, the league.
 * Only a message that asks for a decision (two answers or more, a deadline, not a notice) gets one; and only a
 * message that arrived after the club first ran this (`state._followUpsFrom`: new messages only).
 *
 * PURE: no StateManager.
 */
import { FOLLOW_UP, STAFF_HOURS } from '../data/constants.js';
import { senderLabel } from './Senders.js';
import { untilFull } from './When.js';

/** Outward-facing desks and outside parties: they don't chase an answer. */
const NEVER = new Set(['Partnerships', 'Sponsorship Dept.', 'Marketing', 'Marketing Dept.', 'Community Relations', 'Community Liaison',
  'Fan Relations', 'Booster Club', 'Beat Writer', 'League Office', 'Other GMs', 'Free Agent Market']);

/** Is the sender one of the club's own people (who would follow up)? */
export function internalSender(card) {
  const s = String(card?.sender || '').trim();
  if (!s || NEVER.has(s)) return false;
  if (/ GM\)$|, .* GM$|\bGM$/.test(s)) return false;          // another club's GM ("Morello (Gulfport Mullets GM)")
  if (/\bagent\b|\bagency\b/i.test(s) || /agent/i.test(card?._senderRole || '')) return false;   // a player's agent
  return true;
}

/** Does the message ask for a decision (not a notice)? */
export function asksForDecision(card) {
  if (!card || card.resolved || card.autoResolve === 'skip' || card.isCompose) return false;
  return !!(card.noLabel || (card._choices?.length || 0) > 1);
}

/** When the answer is due, in ms: the real deadline, else the first pitch of the game by which it lapses. */
export function deadlineMs(card, state) {
  if (Number.isFinite(card?.expiresAtMs)) return card.expiresAtMs;
  if (!Number.isFinite(card?.expiresAt) || card.expiresAt === null) return null;
  const g = (state?.schedule || [])[card.expiresAt - 1];
  return Number.isFinite(g?.gameTime) ? g.gameTime : null;
}

const _hm = (s) => s.split(':').map(Number);
/** `t` moved into the staff's day (8 AM – 10 PM local): back to that evening if it can (not before `floor`),
 *  else on to the next morning. */
function _inDay(t, floor) {
  const [sh, sm] = _hm(STAFF_HOURS.start), [eh, em] = _hm(STAFF_HOURS.end);
  const start = new Date(t); start.setHours(sh, sm, 0, 0);
  const end = new Date(t); end.setHours(eh, em, 0, 0);
  if (t >= start.getTime() && t < end.getTime()) return Math.max(t, floor);
  const back = t >= end.getTime() ? end.getTime() - FOLLOW_UP.endPadMs
             : (() => { const y = new Date(end); y.setDate(y.getDate() - 1); return y.getTime() - FOLLOW_UP.endPadMs; })();
  if (back >= floor) return back;
  const next = new Date(start); if (t >= end.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(next.getTime() + FOLLOW_UP.startPadMs, floor);
}

/** When this message's follow-up comes (ms), or null: it doesn't get one. */
export function followUpAt(card, state) {
  if (!asksForDecision(card) || !internalSender(card) || card._followUp) return null;
  const from = state?._followUpsFrom;
  const arrived = card.arrivedAtMs;
  if (!Number.isFinite(from) || !Number.isFinite(arrived) || arrived < from) return null;   // new messages only
  const due = deadlineMs(card, state);
  if (!Number.isFinite(due) || due - arrived < FOLLOW_UP.minWindowMs) return null;
  const t = arrived + (due - arrived) * (1 - FOLLOW_UP.leftShare);
  const at = _inDay(t, arrived + FOLLOW_UP.minAfterMs);
  return at !== null && at <= due - FOLLOW_UP.minBeforeMs ? Math.round(at) : null;
}

// The roster clock's outcome (Completed's "No answer — Correa stayed in the outfield"), as what will happen.
const WILL = [
  [/\bstayed\b/g, 'stays'], [/\bstarted\b/g, 'starts'], [/\bsat\b/g, 'sits'], [/\bplayed\b/g, 'plays'], [/\brested\b/g, 'rests'],
  [/\bwaived\b/g, 'waives'], [/\bfilled\b/g, 'fills'], [/ signed$/, ' sign'], [/\bsigned\b/g, 'signs'], [/\bmade\b/g, 'makes'], [/\breported\b/g, 'report'],
  [/\bset\b/g, 'sets'], [/\bwent after\b/g, 'goes after'], [/\bwalked\b/g, 'walks'], [/^(.+) hired$/, '$1 is hired'],
  [/^passed$/, 'we pass'], [/^dropped$/, "it's dropped"], [/^prices held$/, 'prices hold'], [/^left as it was$/, 'it stays as it is'],
  [/^placed on IL,/, 'on the IL, and'], [/^left for each game's deadline$/, "it's left to each game's deadline"],
];

/**
 * What happens without an answer: { quote } an answer it falls to (a button's words: "Send the Players"), or
 * { will } what the roster clock does (as it will happen: "Correa stays in the outfield"). Null: unknown.
 */
export function defaultWords(card) {
  if (card._autoLabel) {
    let s = card._autoLabel.replace(/^No (answer|decision|reply)( in time)?\s*[—–-]\s*/i, '');
    if (!s || /^No (answer|decision)$/i.test(s)) return null;
    for (const [re, to] of WILL) s = s.replace(re, to);
    return { will: s };
  }
  const auto = card.autoResolve;
  const pick = (card._choices || []).find(c => c.key === auto);
  const label = pick ? pick.label : auto === 'yes' ? card.yesLabel : auto === 'no' ? card.noLabel : null;
  return label ? { quote: label } : null;
}

/** The sender's note, in the sender's voice (a person: I; a department: we). */
export function followUpText(card, state, atMs) {
  const due = deadlineMs(card, state);
  const person = senderLabel(card, state).includes(', ');
  const [I, me] = person ? ['I', 'I'] : ['We', 'we'];
  const by = Number.isFinite(due) ? untilFull(due, atMs) : 'soon';
  const d = defaultWords(card);
  const n = String(card.instanceId || card.cardId || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const open = [`Following up on this.`, `Circling back on this one.`, `Checking in on this.`][n % 3];
  const need = `${I} need your answer by ${by}.`;
  const after = d?.quote ? ` If ${me} don't hear back, ${me}'ll take that as “${d.quote.replace(/[.!]$/, '')}.”`
              : d?.will ? ` If ${me} don't hear back by then: ${d.will.replace(/[.!]$/, '')}.` : '';
  return `${open} ${need}${after}`;
}
