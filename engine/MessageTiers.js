/**
 * engine/MessageTiers.js
 * r295 §122.178 (step 7 groundwork) — each message's tier: 'important' or 'optional' (MESSAGE_TIERS, decided with the
 * user). Stamped on every message at Entry (`_tier`), the one way in. Normal shows every message as it always has;
 * Important only (next release) shows the important ones, and the staff answer the optional ones quietly.
 *
 * In order:
 *   1. the message's own (`_tier` on it or its definition);
 *   2. what the GM asked for: a Compose reply, a watched player (askedFor) — important;
 *   3. the staff's routine check-ins (routine) — optional, even from the roster clock;
 *   4. an emergency, a trade, an injury, the weather — important;
 *   5. its tag (importantTags) — important;
 *   6. worth the money line or more (cost, cost on no, or revenue) — important;
 *   7. otherwise optional.
 *
 * PURE: no StateManager.
 */
import { MESSAGE_TIERS, MESSAGE_MODES } from '../data/constants.js';

export const TIERS = Object.freeze({ IMPORTANT: 'important', OPTIONAL: 'optional' });
const IMPORTANT_TAGS = new Set(MESSAGE_TIERS.importantTags);
const ROUTINE = new Set(MESSAGE_TIERS.routine);
const ASKED = new Set(MESSAGE_TIERS.askedFor);

/** The money a message is worth (thousands): the largest of its cost, its cost on no, and its revenue. */
export const moneyOf = (c) => Math.max(Number(c?._budgetCost) || 0, Number(c?._budgetCostNo) || 0, Number(c?._revenueK) || 0);

/** 'important' or 'optional', and why (for the audit). */
export function tierWhy(c) {
  const own = c?._tier || c?._raw?._tier;
  if (own === TIERS.IMPORTANT || own === TIERS.OPTIONAL) return [own, 'its own'];
  if (c?.isCompose) return [TIERS.IMPORTANT, 'a reply the GM asked for'];
  if (ASKED.has(c?.cardId)) return [TIERS.IMPORTANT, 'the GM asked'];
  if (ROUTINE.has(c?.cardId)) return [TIERS.OPTIONAL, 'a routine check-in'];
  if (c?._emergency) return [TIERS.IMPORTANT, 'an emergency'];
  if (c?._tradeOffer || c?._talkId || c?._tradeKind) return [TIERS.IMPORTANT, 'a trade'];
  if (c?._injury) return [TIERS.IMPORTANT, 'an injury'];
  if (c?._wxDecision || c?._wxGameTime != null) return [TIERS.IMPORTANT, 'the weather'];
  if (IMPORTANT_TAGS.has(c?.tag)) return [TIERS.IMPORTANT, `its tag (${c.tag})`];
  if (moneyOf(c) >= MESSAGE_TIERS.moneyLineK) return [TIERS.IMPORTANT, 'the money'];
  return [TIERS.OPTIONAL, 'otherwise'];
}
export const tierOf = (c) => tierWhy(c)[0];

/**
 * r296 §122.180 Important only: the staff answer an optional message as it arrives, with the answer it gets at its
 * deadline (no 'left unanswered' penalty, not counted as ignoring), and it's shown nowhere (the user's choices).
 *   - staffHandles(card): a message in Messages the staff took (marked at Entry when it arrived in Important only);
 *     one that was waiting before the switch isn't — it stays the GM's.
 *   - staffWillHandle(state, card): one not here yet (planned, foreseen) that the staff will take, as things stand.
 */
export const importantOnly = (state) => state?.settings?.messageMode === MESSAGE_MODES.IMPORTANT;
export const staffHandles = (c) => !!c?._staffHandle;
export const staffWillHandle = (state, c) => !!c && (staffHandles(c) || (importantOnly(state) && (c._tier || tierOf(c)) === TIERS.OPTIONAL));
