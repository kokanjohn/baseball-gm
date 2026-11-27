/**
 * engine/DayPlan.js
 * r297 §122.183 The day plan (the design: §122.182): how many messages a day brings.
 *
 *   - Each day draws its count from a range by the kind of day (DAY_PLAN): a home game day, a road game day, an off
 *     day. The count is everything that day (injuries, trades and the weather count toward it), so a busy day of
 *     those gets fewer of the rest.
 *   - Now and then a day comes in heavy (DAY_PLAN.heavy), so the count can't be guessed.
 *   - The draw is the save's dice on the day itself: the same day always plans the same count (the look-ahead and the
 *     record agree with play).
 *   - Spring and the regular season only (the trade deadline is the season); the postseason and the winter keep
 *     their own pace. Important only plays the Normal plan (the staff take the optional ones); Hardcore its own.
 *   - A short day sends fewer (the user's choice): the plan is a ceiling for what's drawn, never filler.
 *
 * PURE: no StateManager.
 */
import { DAY_PLAN, PHASE, MESSAGE_MODES } from '../data/constants.js';
import { dice, diceSeed } from './Dice.js';

const IN_PLAN = new Set([PHASE.SPRING_TRAINING, PHASE.REGULAR_SEASON, PHASE.TRADE_DEADLINE]);

/** The local calendar day of a time ('2027-04-09'). */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Does the plan run now? */
export const planRuns = (state) => IN_PLAN.has(state?.phase);

/** Whose ranges: Hardcore's, or Normal's (Normal and Important only). */
export const planOf = (state) => (state?.settings?.messageMode === MESSAGE_MODES.HARDCORE ? 'hardcore' : 'normal');

/**
 * The count a day plans: { n, heavy }. `kind`: 'home' | 'road' | 'off'; `key`: the day (dayKey).
 */
export function dayTarget(state, kind, key) {
  const range = DAY_PLAN[planOf(state)][kind] || DAY_PLAN.normal[kind];
  const rand = dice(diceSeed(state), 'day-plan', key);
  let n = range[0] + Math.floor(rand() * (range[1] - range[0] + 1));
  const heavy = rand() < DAY_PLAN.heavy.chance;
  if (heavy) n += DAY_PLAN.heavy.add[0] + Math.floor(rand() * (DAY_PLAN.heavy.add[1] - DAY_PLAN.heavy.add[0] + 1));
  return { n, heavy };
}

/**
 * The messages a day already has: those that came that day and those waiting to come that day. Every one counts
 * (the user's choice), the staff's in Important only too (they're the same day as Normal's).
 */
export function onDay(state, key) {
  let n = 0;
  for (const c of state?.inbox || []) if (Number.isFinite(c?.arrivedAtMs) && dayKey(c.arrivedAtMs) === key) n++;
  for (const c of state?.scheduledCards || []) if (Number.isFinite(c?.deliverAtMs) && dayKey(c.deliverAtMs) === key) n++;
  return n;
}

/**
 * Room left on a day: { key, target, heavy, already, room }.
 */
export function roomOn(state, kind, atMs) {
  const key = dayKey(atMs);
  const { n, heavy } = dayTarget(state, kind, key);
  const already = onDay(state, key);
  return { key, kind, target: n, heavy, already, room: Math.max(0, n - already) };
}
