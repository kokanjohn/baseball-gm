/**
 * engine/cards/Entry.js
 * CardEngine, the one way a message enters the schedule or the inbox (r291 §122.172, foundation step 3).
 *
 * Every message comes in here, inside a StateManager.mutate, with the draft state:
 *   - toSchedule: parked for a time (scheduledCards, kept in delivery order); the release puts it in the inbox.
 *   - toInbox: arrives now (stamped with its sender, `arrivedAtMs` from `arrivedAt(card)`).
 * Each is stamped with its tier (MessageTiers, r295 §122.178) the first time it comes in.
 * `via` says which way it came (VIA). Today they add exactly as the nine places they replace did; this is where
 * the message plan (§122.169: tiers, the day plan, the audit) takes hold. check-entry.mjs holds every path to it.
 */
import { stampSender } from '../Senders.js';
import { _sortInbox } from './Inbox.js';
import { recordUse } from '../MessageParts.js';   // r294 §122.177
import { tierOf, importantOnly, TIERS } from '../MessageTiers.js';   // r295 §122.178, r296 §122.180

export const VIA = Object.freeze({
  DELIVER_AT:  'deliverAt',     // _deliverAt: a card parked for a moment (roster clock, follow-ups, stories; 68 callers)
  MOMENT:      'moment',        // _scheduleCards: a pool card with a moment (soon, pregame, off day, in game)
  BETWEEN:     'between',       // _scheduleCards: a pool card between games (the staff's working day)
  COMPOSE:     'compose',       // a Compose reply, waiting for its time
  RELEASE:     'release',       // releaseDueCards: a scheduled card whose time has come
  EXPIRED:     'expired',       // expire(): a card that lapsed before it was released (so Completed shows it)
  SEED:        'seed',          // deliverSeedCards: a new club's opening slate
  TRADE_SEED:  'tradeSeed',     // deliverTradeOffer: a new club's opening trade offer
  DEBUG:       'debug',         // injectCard: the debug panel
});
const _VIAS = new Set(Object.values(VIA));

const _watchers = [];
/** For checks: fn(via, where, cards) after each entry. Returns a function that stops watching. */
export function watchEntry(fn) {
  _watchers.push(fn);
  return () => { const i = _watchers.indexOf(fn); if (i >= 0) _watchers.splice(i, 1); };
}
function _tell(via, where, cards) {
  if (!_VIAS.has(via)) throw new Error(`Entry: unknown way in '${via}'`);
  for (const fn of _watchers) fn(via, where, cards);
}

/** Park `cards` (each with its deliverAtMs) in the schedule, in delivery order. Returns them. */
export function toSchedule(s, cards, via) {
  for (const c of cards) if (!c._tier) c._tier = tierOf(c);   // r295 §122.178 its tier, decided once
  s.scheduledCards = [...(s.scheduledCards || []), ...cards].sort((a, b) => a.deliverAtMs - b.deliverAtMs);
  _tell(via, 'schedule', cards);
  return cards;
}

/**
 * Put `cards` in the inbox now, each stamped with its sender and `arrivedAtMs: arrivedAt(card)`.
 * `sort: false` leaves the inbox's order as it is (expire() never sorted). Returns them as they arrived.
 */
export function toInbox(s, cards, arrivedAt, via, { sort = true } = {}) {
  const arrived = cards.map(c => stampSender({ ...c, arrivedAtMs: arrivedAt(c), _tier: c._tier || tierOf(c) }, s));   // (r295 its tier)
  // r296 §122.180 Important only: an optional message arriving now is the staff's (answered at the release; shown nowhere)
  if (importantOnly(s) && via !== VIA.EXPIRED && via !== VIA.DEBUG) for (const c of arrived) if (c._tier === TIERS.OPTIONAL) c._staffHandle = true;
  s.inbox = [...(s.inbox || []), ...arrived];
  if (sort) _sortInbox(s.inbox);
  // r294 §122.177 a message in parts: its versions are used now it reaches Messages (one that lapsed unseen isn't)
  if (via !== VIA.EXPIRED) for (const c of arrived) if (c._parts) recordUse(s, c);
  _tell(via, 'inbox', arrived);
  return arrived;
}
